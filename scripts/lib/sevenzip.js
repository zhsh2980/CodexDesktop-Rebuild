/**
 * sevenzip.js — 定位 7-Zip 可执行文件
 *
 * CI 上是 `7zz`（由 workflow 复制出来的别名）或 `7z`；开发机上
 * 7-Zip 常常装在 `C:\Program Files\7-Zip\7z.exe` 而不在 PATH 里。
 * 这里按顺序探测，返回第一个能跑起来的命令。
 */
const fs = require("fs");
const { execFileSync } = require("child_process");

const CANDIDATES = [
  "7zz",
  "7z",
  "C:\\Program Files\\7-Zip\\7z.exe",
  "C:\\Program Files (x86)\\7-Zip\\7z.exe",
];

let cached;

function findSevenZip() {
  if (cached !== undefined) return cached;
  for (const bin of CANDIDATES) {
    if (bin.includes("\\") && !fs.existsSync(bin)) continue;
    try {
      execFileSync(bin, ["i"], { stdio: "pipe" });
      cached = bin;
      return cached;
    } catch {
      // 某些 7-Zip 版本 `i` 返回非 0，但只要能启动就说明可用
      try {
        execFileSync(bin, [], { stdio: "pipe" });
        cached = bin;
        return cached;
      } catch {}
    }
  }
  cached = null;
  return cached;
}

module.exports = { findSevenZip, SEVENZIP_CANDIDATES: CANDIDATES };
