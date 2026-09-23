/**
 * msix-paths.js — 修复 MSIX 解压产物里的百分号编码路径
 *
 * OPC / MSIX 规范要求包内部件名对非 ASCII 及若干保留字符做百分号编码，
 * 例如 npm scope 目录 `@oai` 在包里是 `%40oai`。7-Zip / bsdtar 解压时
 * 不会还原，于是产物里留下字面的 `%40oai`、`%2B`、`%24` 等目录名，
 * Node 按 `@oai/sky` 解析模块时必然失败（computer use 初始化崩溃），
 * 原生模块（@serialport/bindings-cpp、@worklouder/*）同样加载不到。
 *
 * 这里自底向上遍历解压目录，对每个含 %XX 的条目名做 decodeURIComponent
 * 重命名。自底向上是必须的：先处理子项再处理父目录，重命名父目录不会
 * 让还没处理的子路径失效。
 */
const fs = require("fs");
const path = require("path");

// 只要名字里出现 %XX（X 为十六进制）就认为需要解码
const ENCODED_RE = /%[0-9A-Fa-f]{2}/;

/**
 * 对单个条目名解码。解码失败（例如出现孤立的 `%`）返回 null。
 */
function decodeName(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return null;
  }
}

/**
 * 把 from 移动到 to，处理目标已存在的情况：
 *   - 两边都是目录 -> 递归合并（逐个子项再走一遍本函数）
 *   - 其它情况     -> 以解码后的来源为准，覆盖目标
 * 返回 "rename" | "merge" | "replace"
 */
function moveEntry(from, to) {
  if (!fs.existsSync(to)) {
    fs.renameSync(from, to);
    return "rename";
  }

  const fromStat = fs.lstatSync(from);
  const toStat = fs.lstatSync(to);

  if (fromStat.isDirectory() && toStat.isDirectory()) {
    for (const child of fs.readdirSync(from)) {
      moveEntry(path.join(from, child), path.join(to, child));
    }
    try { fs.rmSync(from, { recursive: true, force: true }); } catch {}
    return "merge";
  }

  // 同名文件：解码后的版本才是正确路径，覆盖目标
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
  return "replace";
}

function walkAndDecode(dir, state) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // 1) 先下钻（自底向上）
  for (const e of entries) {
    if (e.isDirectory()) walkAndDecode(path.join(dir, e.name), state);
  }

  // 2) 再处理本层条目名
  for (const e of entries) {
    if (!ENCODED_RE.test(e.name)) continue;

    const decoded = decodeName(e.name);
    const from = path.join(dir, e.name);

    if (decoded === null) {
      state.failures.push(path.relative(state.root, from));
      continue;
    }
    if (decoded === e.name) continue;

    const to = path.join(dir, decoded);
    let how;
    try {
      how = moveEntry(from, to);
    } catch (err) {
      state.failures.push(`${path.relative(state.root, from)} (${err.message})`);
      continue;
    }

    state.renamed++;
    if (how === "merge") state.merged++;
    if (how === "replace") state.replaced++;
    if (state.samples.length < 10) {
      state.samples.push(
        `${path.relative(state.root, from)} -> ${path.relative(state.root, to)}`
      );
    }
  }
}

/**
 * 解码 rootDir 下所有百分号编码的文件/目录名。
 *
 * @param {string} rootDir
 * @returns {{renamed:number, samples:string[], merged:number, replaced:number, failures:string[]}}
 */
function decodeMsixPaths(rootDir) {
  const state = {
    root: rootDir,
    renamed: 0,
    merged: 0,
    replaced: 0,
    samples: [],
    failures: [],
  };
  if (!fs.existsSync(rootDir)) return state;
  walkAndDecode(rootDir, state);
  return {
    renamed: state.renamed,
    samples: state.samples,
    merged: state.merged,
    replaced: state.replaced,
    failures: state.failures,
  };
}

/**
 * 列出仍然含有 %XX 的路径（相对 rootDir），供构建后自检使用。
 *
 * @param {string} rootDir
 * @returns {string[]}
 */
function findEncodedPaths(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;

  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (ENCODED_RE.test(e.name)) out.push(path.relative(rootDir, full));
      if (e.isDirectory()) walk(full);
    }
  })(rootDir);

  return out;
}

module.exports = { decodeMsixPaths, findEncodedPaths, ENCODED_RE };
