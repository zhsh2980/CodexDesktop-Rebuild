#!/usr/bin/env node
/**
 * patch-portable-mode.js — 让免安装版在没有「程序包标识」时也能启动
 *
 * 症状：26.915 的免安装包解压后直接运行 ChatGPT.exe 会弹
 *   「ChatGPT failed to start. 该进程没有程序包标识符。」
 * 日志：error Desktop bootstrap failed to start the main app
 *       phase=bootstrap-import-main
 * 这是 Windows 的 APPMODEL_ERROR_NO_PACKAGE —— 只有从 MSIX 安装的进程才有
 * 包标识，解压出来直接跑的没有。
 *
 * 根因：.vite/build/bootstrap-*.js 里有这么一个开关
 *   function LA(){
 *     return process.platform===`win32`
 *       && o.app.isPackaged
 *       && process.resourcesPath!=null
 *       && !process.env.CODEX_CLI_PATH?.trim()
 *       && A(`codexWindowsAppContainedCore`,
 *            {candidates:[<resourcesPath>/app.asar/package.json]})===`1`
 *   }
 * 为真时 bootstrap 会调用 native 的 getCurrentPackageFamily()，无包标识就抛错，
 * 整个启动挂掉。而官方 26.915 的 app.asar/package.json 里**新增**了
 *   "codexWindowsAppContainedCore": "1"
 * 26.908（免安装能跑的那版）里根本没有这个键 —— 所以它就是新引入的
 * 「要求包标识」开关。
 *
 * 修法：把这个值从 "1" 改成 "0"（同长度，纯 JSON 数据改动，不碰压缩代码）。
 * 另一个等价绕过是启动时设 CODEX_CLI_PATH（LA() 的条件之一是它为空），
 * installer/Launch-Codex.cmd 就是走这条路的备用方案。
 *
 * Usage:
 *   node scripts/patch-portable-mode.js [win|mac-arm64|mac-x64]
 *   node scripts/patch-portable-mode.js --check
 */
const fs = require("fs");
const path = require("path");
const { relPath, SRC_DIR } = require("./patch-util");

const KEY = "codexWindowsAppContainedCore";
const ALL_PLATFORMS = ["mac-arm64", "mac-x64", "win"];

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ALL_PLATFORMS.includes(a));

  // 这个开关只对 Windows 有意义
  const platforms = (platform ? [platform] : ALL_PLATFORMS).filter((p) => p === "win");
  if (platforms.length === 0) {
    console.log("  [skip] 该补丁只对 win 平台有意义");
    return;
  }

  let patched = 0;

  for (const plat of platforms) {
    const pkgPath = path.join(SRC_DIR, plat, "_asar", "package.json");
    if (!fs.existsSync(pkgPath)) {
      console.log(`  [!] ${relPath(pkgPath)} 不存在`);
      continue;
    }

    const raw = fs.readFileSync(pkgPath, "utf-8");

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.log(`  [!] ${relPath(pkgPath)}: JSON 解析失败 ${e.message}`);
      continue;
    }

    const current = parsed[KEY];
    if (current === undefined) {
      console.log(`  [ok] ${KEY} 不存在，无需修改`);
      continue;
    }
    if (String(current) === "0") {
      console.log(`  [ok] ${KEY} 已经是 "0"，无需修改`);
      continue;
    }
    if (String(current) !== "1") {
      console.log(`  [!] ${KEY} 的值是 ${JSON.stringify(current)}，不是预期的 "1"，保持原样`);
      continue;
    }

    if (isCheck) {
      console.log(`  [?] ${relPath(pkgPath)}: ${KEY} "1" -> "0"`);
      continue;
    }

    // 只替换这一个值，保持文件其余字节不变
    const re = new RegExp(`("${KEY}"\\s*:\\s*")1(")`);
    if (!re.test(raw)) {
      console.log(`  [!] ${relPath(pkgPath)}: 解析到了 ${KEY}="1"，但文本里匹配不到，保持原样`);
      continue;
    }
    const next = raw.replace(re, "$10$2");

    // 回读校验，确保改完仍是合法 JSON 且值正确
    let check;
    try {
      check = JSON.parse(next);
    } catch (e) {
      console.log(`  [!] 改写后 JSON 非法，放弃: ${e.message}`);
      continue;
    }
    if (check[KEY] !== "0") {
      console.log(`  [!] 改写后值不是 "0"（实际 ${JSON.stringify(check[KEY])}），放弃`);
      continue;
    }

    fs.writeFileSync(pkgPath, next);
    console.log(`  * package.json: ${KEY} "1" -> "0"`);
    console.log(`  [ok] portable mode: 1 replacements`);
    patched++;
  }

  if (patched === 0 && !isCheck) {
    console.log("  [done] 没有需要修改的内容");
  }
}

main();
