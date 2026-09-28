/**
 * asar-integrity.js — 检测运行时是否启用了 Electron 的 asar 完整性校验
 *
 * 背景：Codex 26.924 起，chrome.dll 里内嵌的 Electron fuse
 *   EnableEmbeddedAsarIntegrityValidation = 1
 *   OnlyLoadAppFromAsar                   = 1
 * 且 ChatGPT.exe 里内嵌了 app.asar 头哈希的 JSON（Electron 的
 * embeddedAsarIntegrity 机制，形如
 *   [{"file":"resources\\app.asar","alg":"SHA256","value":"<64位hex>"}]
 * ）。两者同时生效时，app.asar 的头哈希只要和内嵌值不一致，启动就会
 *   FATAL ... Integrity check failed for asar archive
 * 直接崩溃退出。26.917 及更早版本这个 fuse 是 0、exe 里也没有内嵌哈希，
 * 那时候改 app.asar 是安全的。
 *
 * fuse 的二进制布局（来自 `@electron/fuses` 的 FuseV1 wire format）：
 *   ASCII sentinel "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"（32 字节）
 *   + 1 字节 wire version
 *   + 1 字节 fuse 数量 N
 *   + N 字节，每字节是 '0'/'1'/'r'（ASCII）。已在 26.924 的 chrome.dll
 *     上实测验证：第 5 个（下标 4）是 EnableEmbeddedAsarIntegrityValidation，
 *     第 6 个（下标 5）是 OnlyLoadAppFromAsar。
 */
const fs = require("fs");
const path = require("path");

const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
const ASAR_INTEGRITY_FUSE_INDEX = 4; // EnableEmbeddedAsarIntegrityValidation
const ONLY_LOAD_FROM_ASAR_FUSE_INDEX = 5; // OnlyLoadAppFromAsar
const MAX_FUSE_COUNT = 64; // 合理性上限，超过说明大概率是误匹配

function findFuseBlock(buf) {
  const idx = buf.indexOf(FUSE_SENTINEL);
  if (idx < 0) return null;
  const wireVersion = buf[idx + FUSE_SENTINEL.length];
  const fuseCount = buf[idx + FUSE_SENTINEL.length + 1];
  if (!(fuseCount > 0 && fuseCount <= MAX_FUSE_COUNT)) return null;
  const valuesStart = idx + FUSE_SENTINEL.length + 2;
  const values = buf.slice(valuesStart, valuesStart + fuseCount).toString("ascii");
  return { offset: idx, wireVersion, fuseCount, values };
}

/**
 * 读取一个二进制文件（一般是 chrome.dll），返回 fuse 状态。
 * 找不到 sentinel（老版本运行时没有这套 fuse 机制）时 found=false，
 * 不代表校验没开启，只代表"这个二进制里没有这套开关"——调用方应结合
 * detectEmbeddedAsarIntegrityJson 一起判断。
 *
 * @returns {{found:boolean, reason?:string, offset?:number, wireVersion?:number,
 *            fuseCount?:number, values?:string,
 *            asarIntegrityEnabled?:boolean|null, onlyLoadFromAsar?:boolean|null}}
 */
function detectFuses(binPath) {
  if (!fs.existsSync(binPath)) return { found: false, reason: `文件不存在: ${binPath}` };
  let buf;
  try {
    buf = fs.readFileSync(binPath);
  } catch (e) {
    return { found: false, reason: `读取失败: ${e.message}` };
  }
  const block = findFuseBlock(buf);
  if (!block) return { found: false, reason: "未找到 fuse sentinel（该二进制可能没有 Electron fuses，或版本过旧）" };

  const at = (i) => (i < block.values.length ? block.values[i] : null);
  const toBool = (c) => (c === "1" ? true : c === "0" ? false : null); // 'r' = removed，视为无法判断

  return {
    found: true,
    offset: block.offset,
    wireVersion: block.wireVersion,
    fuseCount: block.fuseCount,
    values: block.values,
    asarIntegrityEnabled: toBool(at(ASAR_INTEGRITY_FUSE_INDEX)),
    onlyLoadFromAsar: toBool(at(ONLY_LOAD_FROM_ASAR_FUSE_INDEX)),
  };
}

// 内嵌 asar 完整性 JSON 的形状：[{"file":"...","alg":"SHA256","value":"<64位hex>"}]
const EMBEDDED_JSON_RE = /\[\s*\{\s*"file"\s*:\s*"([^"]+)"\s*,\s*"alg"\s*:\s*"([^"]+)"\s*,\s*"value"\s*:\s*"([0-9a-fA-F]{64})"\s*\}\s*\]/g;

/**
 * 在可执行文件里查找内嵌的 asar 完整性 JSON（Electron 的
 * embeddedAsarIntegrity 机制，直接以明文 JSON 塞进 exe）。
 *
 * @returns {{found:boolean, reason?:string, entries?:Array<{file:string,alg:string,value:string}>}}
 */
function detectEmbeddedAsarIntegrityJson(exePath) {
  if (!fs.existsSync(exePath)) return { found: false, reason: `文件不存在: ${exePath}` };
  let buf;
  try {
    buf = fs.readFileSync(exePath);
  } catch (e) {
    return { found: false, reason: `读取失败: ${e.message}` };
  }
  // latin1：1 字节 1 字符，不会破坏原始字节序列，足够用正则找 ASCII JSON 片段
  const text = buf.toString("latin1");
  const entries = [];
  EMBEDDED_JSON_RE.lastIndex = 0;
  let m;
  while ((m = EMBEDDED_JSON_RE.exec(text)) !== null) {
    entries.push({ file: m[1], alg: m[2], value: m[3] });
  }
  return { found: entries.length > 0, entries };
}

/**
 * 在目录下（递归）找第一个匹配文件名的文件。
 */
function findFileRecursive(rootDir, fileName, maxDepth = 6) {
  if (!fs.existsSync(rootDir)) return null;
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) return full;
      if (e.isDirectory() && depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

/**
 * 综合判定"这套运行时是否强制 asar 完整性校验"。
 *
 * 会在给定的候选根目录列表里依次查找 chrome.dll 和 ChatGPT.exe（不要求
 * 两者在同一个根目录下都能找到——只要任一根目录下找到的 chrome.dll 显示
 * fuse 开启，或任一根目录下找到的 ChatGPT.exe 里有内嵌哈希，就判定为已启用），
 * 因为 sync-upstream 的输出目录结构（src/<platform>/）目前不包含这两个文件
 * （它们在 MSIX 解压出的 app/ 根目录，和 resources/ 平级），实际检测要靠
 * 调用方传入的参照目录（例如 %TEMP%\codex-sync\win-extract\app 或已经
 * 组装好的构建产物目录）。
 *
 * @param {string[]} candidateRoots 依次尝试的根目录（可包含不存在的路径，会被跳过）
 * @returns {{
 *   enforced: boolean,
 *   checkedRoots: string[],
 *   fuses: (ReturnType<typeof detectFuses> & {source?:string})|null,
 *   embedded: (ReturnType<typeof detectEmbeddedAsarIntegrityJson> & {source?:string})|null,
 * }}
 */
function detectIntegrityEnforcement(candidateRoots) {
  const checkedRoots = [];
  let fuses = null;
  let embedded = null;

  for (const root of candidateRoots) {
    if (!root || !fs.existsSync(root)) continue;
    checkedRoots.push(root);

    if (!fuses || !fuses.found) {
      const chromeDll = findFileRecursive(root, "chrome.dll");
      if (chromeDll) {
        const r = detectFuses(chromeDll);
        if (r.found) fuses = { ...r, source: chromeDll };
        else if (!fuses) fuses = { ...r, source: chromeDll };
      }
    }
    if (!embedded || !embedded.found) {
      const chatgptExe = findFileRecursive(root, "ChatGPT.exe");
      if (chatgptExe) {
        const r = detectEmbeddedAsarIntegrityJson(chatgptExe);
        if (r.found) embedded = { ...r, source: chatgptExe };
        else if (!embedded) embedded = { ...r, source: chatgptExe };
      }
    }
  }

  const fuseEnforced = !!(fuses && fuses.found && fuses.asarIntegrityEnabled === true);
  const embeddedEnforced = !!(embedded && embedded.found);

  return {
    enforced: fuseEnforced || embeddedEnforced,
    checkedRoots,
    fuses,
    embedded,
  };
}

/**
 * win 平台默认的候选根目录：src/win 本身（以防未来 sync 布局变化把这两个
 * 文件放进去），以及 sync-upstream 缓存的 MSIX 解压目录。
 */
function defaultWinCandidateRoots({ platformDir } = {}) {
  const roots = [];
  if (platformDir) roots.push(platformDir);
  const tmp = path.join(require("os").tmpdir(), "codex-sync", "win-extract", "app");
  roots.push(tmp);
  return roots;
}

module.exports = {
  FUSE_SENTINEL,
  ASAR_INTEGRITY_FUSE_INDEX,
  ONLY_LOAD_FROM_ASAR_FUSE_INDEX,
  detectFuses,
  detectEmbeddedAsarIntegrityJson,
  findFileRecursive,
  detectIntegrityEnforcement,
  defaultWinCandidateRoots,
};
