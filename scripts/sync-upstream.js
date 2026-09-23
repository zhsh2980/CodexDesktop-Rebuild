#!/usr/bin/env node
/**
 * sync-upstream.js — Extract full upstream Codex resources
 *
 * Output structure per platform:
 *   src/{platform}/
 *     _asar/              Extracted app.asar content (patch target)
 *     app.asar.unpacked/  Native modules (kept as-is from upstream)
 *     codex|codex.exe     CLI binary (will be replaced by @cometix/codex)
 *     rg|rg.exe           ripgrep binary (kept from upstream)
 *     plugins/            Bundled plugins
 *     native/             Platform native modules
 *     ...                 All other upstream resources
 *
 * Usage:
 *   node scripts/sync-upstream.js [--force] [--skip-mac] [--skip-win]
 *   node scripts/sync-upstream.js --skip-mac --msix <本地 MSIX 路径>   # 离线/本地测试
 */

const https = require("https");
const tls = require("tls");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");
const { decodeMsixPaths } = require("./lib/msix-paths");
const { findSevenZip } = require("./lib/sevenzip");

// TLS certs for MS delivery CDN
const certsDir = path.join(__dirname, "certs");
const extraCAs = [...tls.rootCertificates];
for (const f of ["ms-root-ca.pem", "ms-update-ca.pem"]) {
  const p = path.join(certsDir, f);
  if (fs.existsSync(p)) extraCAs.push(fs.readFileSync(p, "utf-8"));
}
https.globalAgent.options.ca = extraCAs;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const TEMP_DIR = path.join(require("os").tmpdir(), "codex-sync");
const VERSION_FILE = path.join(__dirname, ".versions.json");

const APPCAST_ARM64 = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const APPCAST_X64 = "https://persistent.oaistatic.com/codex-app-prod/appcast-x64.xml";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const CHECK_ONLY = args.includes("--check-only");
const SKIP_MAC = args.includes("--skip-mac");
const SKIP_WIN = args.includes("--skip-win");
// --msix <file>: 使用本地 MSIX，完全跳过商店网络查询（本地端到端测试用）
const LOCAL_MSIX = (() => {
  const i = args.indexOf("--msix");
  return i !== -1 && args[i + 1] ? path.resolve(args[i + 1]) : null;
})();

// ─── Helpers ────────────────────────────────────────────────────

function httpGet(url) {
  const mod = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve, reject);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

function curlDownload(url, dest, label) {
  console.log(`  [dl] ${label}`);
  execSync(`curl -L --retry 3 --retry-delay 2 -o "${dest}" "${url}"`, { stdio: "inherit" });
}

function extractArchive(archive, dest) {
  if (process.platform === "darwin" && archive.endsWith(".zip")) {
    // ditto preserves macOS symlinks + resource forks (required for .app)
    execSync(`ditto -xk "${archive}" "${dest}"`);
    return;
  }

  // Windows MSIX / Linux：7zz -> 7z -> C:\Program Files\7-Zip\7z.exe -> 系统自带 tar.exe
  fs.mkdirSync(dest, { recursive: true });
  const errors = [];

  const sevenZip = findSevenZip();
  if (sevenZip) {
    try {
      execFileSync(sevenZip, ["x", "-y", `-o${dest}`, archive], { stdio: "pipe" });
      return;
    } catch (e) {
      errors.push(`${sevenZip}: ${e.message}`);
    }
  } else {
    errors.push("未找到 7-Zip (7zz / 7z / C:\\Program Files\\7-Zip\\7z.exe)");
  }

  // bsdtar 也能解 zip 系容器（MSIX 本质是 zip）
  const tarBin = process.platform === "win32"
    ? "C:\\Windows\\System32\\tar.exe"
    : "tar";
  if (process.platform !== "win32" || fs.existsSync(tarBin)) {
    try {
      console.log("   [!] 7-Zip 不可用或解压失败，改用系统自带 tar");
      execFileSync(tarBin, ["-xf", archive, "-C", dest], { stdio: "pipe" });
      return;
    } catch (e) {
      errors.push(`${tarBin}: ${e.message}`);
    }
  }

  // 容错：7z 对个别条目（如 0 字节 / 属性异常）会以非 0 退出码收场，
  // 但主体内容其实已经解出来了。只要关键文件在，就继续往下走，
  // 由 assertExtractComplete 的条目数校验来兜底判断是否真的缺东西。
  if (fs.existsSync(path.join(dest, "app", "resources", "app.asar"))) {
    console.log("   [!] 解压器返回非 0，但 app/resources/app.asar 已存在，继续（交由条目数校验兜底）");
    for (const e of errors) console.log(`       ${e}`);
    return;
  }

  throw new Error(`Failed to extract ${archive}\n  ${errors.join("\n  ")}`);
}

// ─── 解压完整性校验 ─────────────────────────────────────────────

/**
 * 用 `7z l -slt` 列出 MSIX 里的条目。
 * 注意：`----------` 之前是归档自身的信息块（第一个 Path 是 msix 文件本身），
 * 必须排除；目录条目的特征是 `Folder = +` 或 Attributes 以 D 开头。
 *
 * @returns {{files:string[], dirCount:number}|null}  null = 没有 7-Zip，无法列举
 */
function listMsixEntries(msixPath) {
  const sevenZip = findSevenZip();
  if (!sevenZip) return null;

  let out;
  try {
    out = execFileSync(sevenZip, ["l", "-slt", msixPath], {
      encoding: "utf-8",
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (e) {
    console.log(`   [!] 列举 MSIX 条目失败: ${e.message}`);
    return null;
  }

  const sepIdx = out.indexOf("\n----------");
  if (sepIdx < 0) {
    console.log("   [!] 无法解析 7z -slt 输出（没找到 ---------- 分隔符）");
    return null;
  }
  const body = out.slice(sepIdx);

  const files = [];
  let dirCount = 0;
  let cur = null;

  const flush = () => {
    if (!cur || !cur.Path) return;
    const isDir = cur.Folder === "+" || /^D/.test(cur.Attributes || "");
    if (isDir) dirCount++;
    else files.push(cur.Path);
    cur = null;
  };

  for (const line of body.split(/\r?\n/)) {
    const p = line.match(/^Path = (.*)$/);
    if (p) { flush(); cur = { Path: p[1] }; continue; }
    if (!cur) continue;
    const kv = line.match(/^([A-Za-z0-9 _-]+) = (.*)$/);
    if (kv) cur[kv[1]] = kv[2];
  }
  flush();

  return { files, dirCount };
}

/** 归档里的路径是百分号编码的，逐段解码后才能和解压产物比 */
function decodeArchivePath(p) {
  return p
    .split(/[\\/]/)
    .map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } })
    .join("/");
}

function listExtractedFiles(rootDir) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (!e.isSymbolicLink()) out.push(path.relative(rootDir, full).split(path.sep).join("/"));
    }
  })(rootDir);
  return out;
}

/**
 * 真参照校验：拿 MSIX 归档自身的条目清单和解压产物逐条比对。
 *
 * 光用解压目录当 verify 的 --reference 是不够的 —— 如果解压本身就漏了
 * 文件，参照和产物会一起漏，检查等于空转。这里在 sync 阶段就把归档
 * 清单当作唯一真相来源，对不上直接中止。
 */
function assertExtractComplete(msixPath, extractDir, decoded) {
  const listing = listMsixEntries(msixPath);
  if (!listing) {
    console.log("   [!] 无法列举 MSIX 条目（缺 7-Zip？），跳过解压完整性校验");
    return;
  }

  const expected = new Set(listing.files.map(decodeArchivePath));
  const actualList = listExtractedFiles(extractDir);
  const actual = new Set(actualList);

  console.log(
    `   [verify] MSIX 非目录条目 ${listing.files.length} 个（目录条目 ${listing.dirCount}）` +
    ` / 解压得到 ${actualList.length} 个文件`
  );
  if (expected.size !== listing.files.length) {
    console.log(`   [!] 解码后有 ${listing.files.length - expected.size} 个条目路径重名（已按解码后为准合并）`);
  }

  const missing = [...expected].filter((p) => !actual.has(p));
  const extra = actualList.filter((p) => !expected.has(p));

  if (missing.length === 0 && extra.length === 0) {
    console.log(`   [ok] 解压完整性校验通过：${expected.size} 个条目全部一一对应`);
    return;
  }

  console.log(`   [x] 解压完整性校验失败：缺失 ${missing.length} 个，多出 ${extra.length} 个`);
  for (const p of missing.slice(0, 10)) console.log(`       缺失: ${p}`);
  for (const p of extra.slice(0, 10)) console.log(`       多出: ${p}`);
  if (decoded && decoded.failures && decoded.failures.length) {
    console.log(`       （注意：有 ${decoded.failures.length} 个路径解码失败，可能是原因）`);
  }
  throw new Error(
    `MSIX 解压不完整: 缺失 ${missing.length} 个条目、多出 ${extra.length} 个（归档 ${expected.size} / 产物 ${actualList.length}）`
  );
}

/**
 * 解压后立刻还原 MSIX 的百分号编码路径（%40oai -> @oai 等）。
 * 不做这一步，产物里的 @oai/sky、@serialport/* 等模块都解析不到。
 */
function decodeExtractedPaths(dir, label) {
  const res = decodeMsixPaths(dir);
  if (res.renamed > 0) {
    console.log(`   [decode] ${label}: 还原 ${res.renamed} 个百分号编码路径` +
      (res.merged ? ` (合并目录 ${res.merged})` : "") +
      (res.replaced ? ` (覆盖同名文件 ${res.replaced})` : ""));
    for (const s of res.samples) console.log(`            ${s}`);
  } else {
    console.log(`   [decode] ${label}: 未发现百分号编码路径`);
  }
  if (res.failures.length > 0) {
    console.log(`   [!] ${res.failures.length} 个路径解码失败，保持原样:`);
    for (const f of res.failures.slice(0, 10)) console.log(`       ${f}`);
  }
  return res;
}

function sha256File(file) {
  const crypto = require("crypto");
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * 从 MSIX 内的 AppxManifest.xml 读取 Identity Version（用于 --msix 本地模式）。
 */
function readMsixVersion(msixPath) {
  const tmp = path.join(TEMP_DIR, "msix-manifest");
  clearDir(tmp);
  const sevenZip = findSevenZip();
  let xml = null;

  if (sevenZip) {
    try {
      execFileSync(sevenZip, ["e", "-y", `-o${tmp}`, msixPath, "AppxManifest.xml"], { stdio: "pipe" });
      const p = path.join(tmp, "AppxManifest.xml");
      if (fs.existsSync(p)) xml = fs.readFileSync(p, "utf-8");
    } catch {}
  }
  if (xml === null && process.platform === "win32" && fs.existsSync("C:\\Windows\\System32\\tar.exe")) {
    try {
      execFileSync("C:\\Windows\\System32\\tar.exe", ["-xf", msixPath, "-C", tmp, "AppxManifest.xml"], { stdio: "pipe" });
      const p = path.join(tmp, "AppxManifest.xml");
      if (fs.existsSync(p)) xml = fs.readFileSync(p, "utf-8");
    } catch {}
  }
  if (xml === null) return null;

  const m = xml.match(/<Identity\b[^>]*\bVersion\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) { const r = findFile(full, name); if (r) return r; }
  }
  return null;
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) { /* skip */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

// ─── Version detection ──────────────────────────────────────────

async function getAppcastVersion(url) {
  const { XMLParser } = require("fast-xml-parser");
  const res = await httpGet(url);
  if (res.status !== 200) throw new Error(`Appcast fetch failed: ${res.status}`);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
  const parsed = parser.parse(res.body.toString());
  const items = parsed.rss?.channel?.item;
  const latest = Array.isArray(items) ? items[0] : items;
  let enc = latest.enclosure;
  if (Array.isArray(enc)) enc = enc[0];
  return {
    version: latest.shortVersionString || latest.title,
    build: String(latest.version || ""),
    url: enc?.["@_url"] || "",
  };
}

async function getWindowsVersion() {
  // --msix：使用本地文件，版本号从 AppxManifest.xml 的 Identity Version 读取
  if (LOCAL_MSIX) {
    if (!fs.existsSync(LOCAL_MSIX)) throw new Error(`本地 MSIX 不存在: ${LOCAL_MSIX}`);
    let version = readMsixVersion(LOCAL_MSIX);
    if (!version) {
      const m = path.basename(LOCAL_MSIX).match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_/);
      version = m?.[1] || "unknown";
      console.log(`   [!] 无法读取 AppxManifest.xml，改用文件名推断版本: ${version}`);
    }
    return { version, url: "", packageName: path.basename(LOCAL_MSIX), localPath: LOCAL_MSIX };
  }

  const msstore = require("./fetch-msstore");
  const cookie = await msstore.getCookie();
  const info = await msstore.getAppInfo("9plm9xgg6vks", "US");
  if (!info.categoryId) throw new Error("No CategoryID");
  const pkgs = await msstore.getFileList(cookie, info.categoryId, "Retail");
  if (pkgs.length === 0) throw new Error("No packages");
  const pkg = selectWindowsX64Package(pkgs);
  const url = await msstore.getDownloadUrl(pkg.updateID, pkg.revisionNumber, "Retail", pkg.digest);
  const verMatch = pkg.name.match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_/);
  return { version: verMatch?.[1] || "unknown", url, packageName: pkg.name };
}

function getWindowsPackageArch(packageName) {
  const match = String(packageName || "").match(/_(x64|arm64|x86|neutral)(?:__|_|\.)/i);
  return match ? match[1].toLowerCase() : "";
}

function selectWindowsX64Package(pkgs) {
  const x64Pkgs = pkgs.filter((pkg) => getWindowsPackageArch(pkg.name) === "x64");
  if (x64Pkgs.length === 0) {
    const names = pkgs.map((pkg) => pkg.name).join(", ");
    throw new Error(`No Windows x64 package found. Available packages: ${names || "(none)"}`);
  }

  const codexPkgs = x64Pkgs.filter((pkg) => /codex/i.test(pkg.name));
  const candidates = codexPkgs.length > 0 ? codexPkgs : x64Pkgs;
  return candidates.sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];
}

function assertWindowsX64Resources(appDir, resourcesDir, packageName) {
  const shellRuntimePath = path.join(appDir, "owl-shell-runtime.json");
  if (!fs.existsSync(shellRuntimePath)) {
    throw new Error("Windows: owl-shell-runtime.json not found; cannot verify package architecture");
  }

  const shellRuntime = JSON.parse(fs.readFileSync(shellRuntimePath, "utf-8"));
  if (shellRuntime.platform !== "win32" || shellRuntime.arch !== "x64") {
    throw new Error(
      `Windows package architecture mismatch: selected ${packageName}, ` +
      `but owl-shell-runtime.json says ${shellRuntime.platform}/${shellRuntime.arch}`
    );
  }

  const electronAppPath = path.join(resourcesDir, "owl-electron-app.json");
  if (fs.existsSync(electronAppPath)) {
    const electronApp = JSON.parse(fs.readFileSync(electronAppPath, "utf-8"));
    const packagedFrom = String(electronApp.packagedFrom || "");
    if (/win32-arm64/i.test(packagedFrom)) {
      throw new Error(`Windows package architecture mismatch: packagedFrom=${packagedFrom}`);
    }
  }
}

// ─── Extract macOS ──────────────────────────────────────────────

async function syncMac(variant, appcastUrl, destDir) {
  const label = `macOS-${variant}`;
  console.log(`\n-- ${label}`);

  const info = await getAppcastVersion(appcastUrl);
  console.log(`   version: ${info.version} (build ${info.build})`);

  const zipPath = path.join(TEMP_DIR, `Codex-${variant}-${info.version}.zip`);
  const extractDir = path.join(TEMP_DIR, `${variant}-extract`);

  if (!fs.existsSync(zipPath)) {
    curlDownload(info.url, zipPath, label);
  } else {
    console.log(`   [cache] ${zipPath}`);
  }

  console.log("   [unzip]");
  clearDir(extractDir);
  extractArchive(zipPath, extractDir);

  const resourcesDir = findResourcesDir(extractDir);
  if (!resourcesDir) throw new Error(`${label}: Resources directory not found`);

  assembleOutput(resourcesDir, destDir, label);
  return info;
}

// ─── Extract Windows ────────────────────────────────────────────

async function syncWin(destDir) {
  console.log("\n-- Windows");

  const info = await getWindowsVersion();
  console.log(`   version: ${info.version}`);

  const msixPath = info.localPath
    || path.join(TEMP_DIR, info.packageName || `codex-win-${info.version}.msix`);
  const extractDir = path.join(TEMP_DIR, "win-extract");

  if (info.localPath) {
    console.log(`   [local] ${msixPath}`);
  } else if (!fs.existsSync(msixPath)) {
    curlDownload(info.url, msixPath, "Windows MSIX");
  } else {
    console.log(`   [cache] ${msixPath}`);
  }

  console.log("   [unzip]");
  clearDir(extractDir);
  extractArchive(msixPath, extractDir);

  // MSIX 内部路径是百分号编码的（OPC 规范），必须在任何人读它之前还原
  const decoded = decodeExtractedPaths(extractDir, "win-extract");

  // 拿归档自身的条目清单当唯一真相，确认解压一条不少
  assertExtractComplete(msixPath, extractDir, decoded);

  const resourcesDir = path.join(extractDir, "app", "resources");
  if (!fs.existsSync(resourcesDir)) {
    const alt = findFile(extractDir, "app.asar");
    throw new Error(`Windows: resources dir not found${alt ? `, app.asar at ${alt}` : ""}`);
  }
  assertWindowsX64Resources(path.join(extractDir, "app"), resourcesDir, info.packageName);

  assembleOutput(resourcesDir, destDir, "Windows");

  // 记录来源信息，供 build 写入 BUILD-INFO.json
  console.log("   [sha256] 计算 MSIX 摘要…");
  // 注意：msixVersion（商店包版本，如 26.915.4065.0）和 asar 里 package.json
  // 的 appVersion（如 26.915.31029）是两套编号。GitHub 的 tag / release 名用
  // 前者，而 zip 文件名历来用后者，两者永远对不上 —— 所以两个都要记录下来，
  // 安装/更新脚本才有办法比较版本。
  const sourceInfo = {
    version: info.version,       // 兼容旧字段，等同 msixVersion
    msixVersion: info.version,
    sourceMsix: path.basename(msixPath),
    sourceMsixSha256: sha256File(msixPath),
    decodedPaths: decoded.renamed,
    syncedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(destDir, ".source-msix.json"),
    JSON.stringify(sourceInfo, null, 2) + "\n"
  );
  console.log(`   [ok] sourceMsixSha256 = ${sourceInfo.sourceMsixSha256.slice(0, 16)}…`);

  return info;
}

// ─── Assemble output ────────────────────────────────────────────

function assembleOutput(resourcesDir, destDir, label) {
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) throw new Error(`${label}: app.asar not found`);

  console.log(`   [assemble] -> ${path.relative(PROJECT_ROOT, destDir)}/`);
  clearDir(destDir);

  // 1. Extract app.asar → _asar/ (for patching)
  const asarDest = path.join(destDir, "_asar");
  console.log("   [asar extract] -> _asar/");
  execSync(`npx asar extract "${asarPath}" "${asarDest}"`);

  // 2. Copy app.asar.unpacked/ as-is (native modules)
  const unpackedSrc = path.join(resourcesDir, "app.asar.unpacked");
  if (fs.existsSync(unpackedSrc)) {
    const n = copyRecursive(unpackedSrc, path.join(destDir, "app.asar.unpacked"));
    console.log(`   [copy] app.asar.unpacked/ (${n} files)`);
  }

  // 3. Copy all other resources (binaries, plugins, native, etc.)
  let extraCount = 0;
  for (const e of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (e.name === "app.asar" || e.name === "app.asar.unpacked") continue;
    if (e.name.endsWith(".lproj")) continue;
    const s = path.join(resourcesDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) { extraCount += copyRecursive(s, d); }
    else if (!e.isSymbolicLink()) { fs.copyFileSync(s, d); extraCount++; }
  }
  console.log(`   [copy] ${extraCount} extra resource files`);

  const total = countFiles(destDir);
  console.log(`   [ok] ${total} files total`);
}

function findResourcesDir(extractDir) {
  const appDir = findFile(extractDir, "app.asar");
  return appDir ? path.dirname(appDir) : null;
}

// ─── Version state ──────────────────────────────────────────────

function loadVersions() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8")); } catch { return {}; }
}
function saveVersions(v) {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(v, null, 2) + "\n");
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("== Codex upstream sync ==\n");
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const results = {};

  // Detect versions
  if (!SKIP_MAC) {
    try {
      const arm64Info = await getAppcastVersion(APPCAST_ARM64);
      console.log(`\n   mac-arm64: ${arm64Info.version} (build ${arm64Info.build})`);
      results["mac-arm64"] = arm64Info;
    } catch (e) { console.error(`   [x] mac-arm64 check: ${e.message}`); }

    try {
      const x64Info = await getAppcastVersion(APPCAST_X64);
      console.log(`   mac-x64:   ${x64Info.version} (build ${x64Info.build})`);
      results["mac-x64"] = x64Info;
    } catch (e) { console.error(`   [x] mac-x64 check: ${e.message}`); }
  }

  if (!SKIP_WIN) {
    try {
      const winInfo = await getWindowsVersion();
      console.log(`   win:       ${winInfo.version}`);
      results.win = winInfo;
    } catch (e) { console.error(`   [x] win check: ${e.message}`); }
  }

  if (CHECK_ONLY) {
    console.log("\n== Check only, skipping download ==");
    return;
  }

  // Download and extract
  if (!SKIP_MAC && results["mac-arm64"]) {
    try {
      results["mac-arm64"] = await syncMac("arm64", APPCAST_ARM64, path.join(SRC_DIR, "mac-arm64"));
    } catch (e) { console.error(`   [x] mac-arm64: ${e.message}`); }
  }
  if (!SKIP_MAC && results["mac-x64"]) {
    try {
      results["mac-x64"] = await syncMac("x64", APPCAST_X64, path.join(SRC_DIR, "mac-x64"));
    } catch (e) { console.error(`   [x] mac-x64: ${e.message}`); }
  }
  if (!SKIP_WIN && results.win) {
    try {
      results.win = await syncWin(path.join(SRC_DIR, "win"));
    } catch (e) { console.error(`   [x] win: ${e.message}`); }
  }

  const saved = loadVersions();
  for (const [key, info] of Object.entries(results)) {
    saved[key] = { version: info.version, build: info.build || "", checkedAt: new Date().toISOString() };
  }
  saveVersions(saved);

  console.log("\n== Done ==");
  for (const [key, info] of Object.entries(results)) {
    console.log(`   ${key}: ${info.version}`);
  }
}

main().catch((e) => { console.error(`\n[x] ${e.message}`); process.exit(1); });
