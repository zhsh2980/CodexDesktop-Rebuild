#!/usr/bin/env node
/**
 * build-from-upstream.js — Patch upstream Codex and repackage
 *
 * For macOS and Windows: no forge needed.
 * Takes the upstream app, patches ASAR in-place, replaces codex CLI, outputs distributable.
 *
 * Usage:
 *   node scripts/build-from-upstream.js --platform mac-arm64
 *   node scripts/build-from-upstream.js --platform mac-x64
 *   node scripts/build-from-upstream.js --platform win
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync, execFileSync } = require("child_process");
const { findSevenZip } = require("./lib/sevenzip");
const { parseCliMode, readCliChoice, resolveCliChoice } = require("./lib/cli-policy");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const OUT_DIR = path.join(PROJECT_ROOT, "out");
const INSTALLER_DIR = path.join(PROJECT_ROOT, "installer");

const TARGET_TRIPLE_MAP = {
  "mac-arm64": "aarch64-apple-darwin",
  "mac-x64": "x86_64-apple-darwin",
  "win": "x86_64-pc-windows-msvc",
};

// ─── Helpers ────────────────────────────────────────────────────

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) {
      const target = fs.readlinkSync(s);
      try { fs.symlinkSync(target, d); } catch {}
      count++;
    } else {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
}

/**
 * 兜底：从 MSIX 包名里解析商店包版本
 * OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0.msix -> 26.915.4065.0
 */
function parseMsixVersionFromName(name) {
  const m = String(name || "").match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_/);
  return m ? m[1] : null;
}

/**
 * 把仓库根目录 installer/ 下的所有文件复制到产物应用根目录
 * （与 ChatGPT.exe 同级），供用户解压后直接运行安装/更新脚本。
 */
function copyInstallerFiles(outApp) {
  if (!fs.existsSync(INSTALLER_DIR)) {
    console.log("   [installer] 仓库无 installer/ 目录，跳过");
    return [];
  }
  const copied = [];
  const walk = (src, rel) => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        fs.mkdirSync(path.join(outApp, r), { recursive: true });
        walk(s, r);
      } else if (!e.isSymbolicLink()) {
        fs.copyFileSync(s, path.join(outApp, r));
        copied.push(r);
      }
    }
  };
  walk(INSTALLER_DIR, "");
  if (copied.length === 0) {
    console.log("   [installer] installer/ 为空，无文件可复制");
  } else {
    console.log(`   [installer] 复制 ${copied.length} 个文件 -> 产物根目录: ${copied.join(", ")}`);
  }
  return copied;
}

function resolveCodexVendor(platform) {
  const triple = TARGET_TRIPLE_MAP[platform];
  if (!triple) return null;
  const binName = platform === "win" ? "codex.exe" : "codex";

  // Try platform-specific package (0.128+)
  const PKG_MAP = { "mac-arm64": "codex-darwin-arm64", "mac-x64": "codex-darwin-x64", "win": "codex-win32-x64" };
  const platPkg = PKG_MAP[platform];
  if (platPkg) {
    const p = path.join(PROJECT_ROOT, "node_modules", "@cometix", platPkg, "vendor", triple, "codex", binName);
    if (fs.existsSync(p)) return p;
  }
  // Try old-style vendor (pre-0.128)
  const localPath = path.join(PROJECT_ROOT, "node_modules", "@cometix", "codex", "vendor", triple, "codex", binName);
  if (fs.existsSync(localPath)) return localPath;

  // npm pack fallback — fetch platform-specific package
  // First get latest cometix base version, then append platform suffix
  const PLAT_SUFFIX = {
    "mac-arm64": "darwin-arm64", "mac-x64": "darwin-x64",
    "win": "win32-x64",
    "linux-x64": "linux-x64", "linux-arm64": "linux-arm64",
  };
  const suffix = PLAT_SUFFIX[platform];
  if (!suffix) return null;

  let baseVer;
  try {
    baseVer = execSync("npm view @cometix/codex version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return null; }

  // e.g. "0.128.0-cometix" → "@cometix/codex@0.128.0-cometix-darwin-x64"
  const platPkgSpec = `@cometix/codex@${baseVer}-${suffix}`;
  console.log(`   [codex] fetching ${platPkgSpec} via npm pack...`);
  const tmpDir = path.join(require("os").tmpdir(), "cometix-codex-pack");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const tgzName = execSync(`npm pack ${platPkgSpec} --pack-destination "${tmpDir}"`, {
      cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n").pop();
    const extractDir = path.join(tmpDir, "extracted");
    clearDir(extractDir);
    execSync(`tar xzf "${path.join(tmpDir, tgzName)}" -C "${extractDir}"`, { stdio: "pipe" });
    const p = path.join(extractDir, "package", "vendor", triple, "codex", binName);
    if (fs.existsSync(p)) return p;
  } catch (e) {
    console.log(`   [!] npm pack failed: ${e.message}`);
  }
  return null;
}

// ─── macOS build ────────────────────────────────────────────────

function buildMac(platform) {
  const platformDir = path.join(SRC_DIR, platform);
  const asarDir = path.join(platformDir, "_asar");

  if (!fs.existsSync(asarDir)) {
    console.error(`[x] ${platform}/_asar/ not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // 1. Find the .app in the ZIP extract cache
  const tempDir = path.join(require("os").tmpdir(), "codex-sync");
  const variant = platform === "mac-arm64" ? "arm64" : "x64";
  const extractDir = path.join(tempDir, `${variant}-extract`);

  // Find Codex.app
  let appPath = null;
  if (fs.existsSync(extractDir)) {
    const findApp = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "Codex.app" && e.isDirectory()) return path.join(dir, e.name);
        if (e.isDirectory()) { const r = findApp(path.join(dir, e.name)); if (r) return r; }
      }
      return null;
    };
    appPath = findApp(extractDir);
  }

  if (!appPath) {
    console.error(`[x] Codex.app not found in cache. Run sync-upstream first.`);
    process.exit(1);
  }

  console.log(`   [source] ${appPath}`);

  // 2. Copy .app to output (ditto preserves symlinks + resource forks)
  const outAppDir = path.join(OUT_DIR, platform);
  clearDir(outAppDir);
  const outApp = path.join(outAppDir, "Codex.app");
  console.log("   [copy] Codex.app -> out/");
  execSync(`ditto "${appPath}" "${outApp}"`);

  const resourcesDir = path.join(outApp, "Contents", "Resources");

  // 3. Repack patched ASAR
  const asarPath = path.join(resourcesDir, "app.asar");
  console.log("   [asar pack] _asar/ -> app.asar");
  execSync(`npx asar pack "${asarDir}" "${asarPath}"`);

  // 4. Update ASAR integrity hash in Info.plist
  const infoPlist = path.join(outApp, "Contents", "Info.plist");
  if (fs.existsSync(infoPlist)) {
    updateAsarIntegrity(asarPath, infoPlist);
  }

  // 5. Strip original signature + quarantine
  console.log("   [codesign] removing original signature");
  try { execSync(`codesign --remove-signature "${outApp}"`, { stdio: "pipe" }); } catch {}
  try { execSync(`xattr -rd com.apple.quarantine "${outApp}"`, { stdio: "pipe" }); } catch {}

  // 6. Replace codex CLI
  replaceCodex(platform, resourcesDir, "codex");

  // 7. Ad-hoc re-sign (prevents "damaged app" Gatekeeper error)
  console.log("   [codesign] ad-hoc signing");
  try {
    execSync(`codesign --sign - --force --deep "${outApp}"`, { stdio: "pipe" });
    console.log("   [ok] ad-hoc signed");
  } catch (e) {
    console.log(`   [!] ad-hoc sign failed: ${e.message}`);
  }

  // 8. Create DMG
  const version = getVersion(asarDir);
  const dmgName = `Codex-${platform}-${version}.dmg`;
  const dmgPath = path.join(OUT_DIR, dmgName);
  console.log(`   [dmg] ${dmgName}`);
  execSync(`hdiutil create -volname Codex -srcfolder "${outAppDir}" -ov -format UDZO "${dmgPath}"`, { stdio: "pipe" });
  const sizeMB = (fs.statSync(dmgPath).size / 1048576).toFixed(1);
  console.log(`   [ok] ${dmgPath} (${sizeMB} MB)`);
}

// ─── Windows build ──────────────────────────────────────────────

function buildWin(platform) {
  const platformDir = path.join(SRC_DIR, platform);
  const asarDir = path.join(platformDir, "_asar");

  if (!fs.existsSync(asarDir)) {
    console.error(`[x] win/_asar/ not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // Windows: use the MSIX extract cache
  const tempDir = path.join(require("os").tmpdir(), "codex-sync");
  const extractDir = path.join(tempDir, "win-extract");
  const appDir = path.join(extractDir, "app");

  if (!fs.existsSync(appDir)) {
    console.error(`[x] MSIX extract not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // Copy app/ to output
  const outAppDir = path.join(OUT_DIR, "win");
  clearDir(outAppDir);
  const outApp = path.join(outAppDir, "Codex-win32-x64");
  console.log("   [copy] MSIX app/ -> out/");
  copyRecursive(appDir, outApp);

  const resourcesDir = path.join(outApp, "resources");

  // Compute old ASAR header hash (before repack)
  const asarPath = path.join(resourcesDir, "app.asar");
  const oldHash = computeAsarHeaderHash(asarPath);
  console.log(`   [integrity] old hash: ${oldHash.slice(0, 16)}...`);

  // Repack patched ASAR
  console.log("   [asar pack] _asar/ -> app.asar");
  execSync(`npx asar pack "${asarDir}" "${asarPath}"`);

  // Compute new hash and patch exe
  const newHash = computeAsarHeaderHash(asarPath);
  console.log(`   [integrity] new hash: ${newHash.slice(0, 16)}...`);

  if (oldHash !== newHash) {
    patchAsarIntegrityInBinaries(outApp, oldHash, newHash);
  }

  // ─── CLI 策略 ───────────────────────────────────────────────
  // 默认 auto：官方 CLI 通常比 @cometix/codex 新，不能无脑替换，
  // 否则应用会提示「codex cli 版本太旧」。cometix 模式仅在你想要它
  // 额外的 TUI 定制时才有必要。
  let choice = readCliChoice(platformDir);
  if (!choice) {
    console.log("   [!] 未找到 .cli-choice.json（patch-all 未运行？），现场重新判定");
    choice = resolveCliChoice({
      mode: parseCliMode(),
      platformDir,
      cliBinName: "codex.exe",
    });
  }
  console.log(`   [cli] 模式=${choice.mode} 官方=${choice.official || "未知"} cometix=${choice.cometix || "未知"}`);
  console.log(`   [cli] 决定: ${choice.useCometix ? "替换为 @cometix/codex" : "保留官方 codex.exe"} — ${choice.reason}`);
  console.log(
    `   [cli] thread/delete 支持: ${
      choice.supportsThreadDelete === true ? "是（应用自带的归档会话删除可用）"
      : choice.supportsThreadDelete === false ? "否（应用内删除已归档会话会提示不支持）" : "无法确认"
    }`
  );

  if (choice.useCometix) {
    replaceCodex(platform, resourcesDir, "codex.exe");
  } else {
    console.log("   [ok] 保留 MSIX 自带的官方 codex.exe，未做任何替换");
  }

  // ─── 免安装辅助脚本 ─────────────────────────────────────────
  copyInstallerFiles(outApp);

  // ─── BUILD-INFO.json ────────────────────────────────────────
  // 版本有两套编号，安装/更新脚本必须分清楚：
  //   appVersion  = app.asar 里 package.json 的版本（如 26.915.31029），
  //                 zip 文件名用的就是它
  //   msixVersion = 商店包版本（如 26.915.4065.0），GitHub 的 tag 和
  //                 release 名用的是它
  // 旧的 version 字段保留，语义仍是 appVersion。
  const version = getVersion(asarDir);
  const source = readJson(path.join(platformDir, ".source-msix.json"), {});
  const patchReport = readJson(path.join(platformDir, ".patch-report.json"), { applied: [], noop: [], skipped: [] });
  const msixVersion = source.msixVersion || source.version
    || parseMsixVersionFromName(source.sourceMsix) || null;
  const zipName = `Codex-win-x64-${version}.zip`;
  const buildInfo = {
    version,
    appVersion: version,
    msixVersion,
    zipName,
    builtAt: new Date().toISOString(),
    sourceMsix: source.sourceMsix || null,
    sourceMsixSha256: source.sourceMsixSha256 || null,
    cli: {
      mode: choice.mode,
      official: choice.official || null,
      cometix: choice.cometix || null,
      used: choice.useCometix ? "cometix" : "official",
      // 随包发布的那个 codex.exe 的 app-server 是否支持 thread/delete。
      // 应用本体自带的「删除已归档会话」界面依赖它，不支持时界面会提示
      // 「不支持」。true / false / null=无法确认
      supportsThreadDelete: choice.supportsThreadDelete ?? null,
    },
    patches: {
      // applied = 确实发生了替换；noop = 正常退出但一处都没匹配（补丁在
      // 当前上游版本上已失效）；skipped = 被前置条件主动跳过
      applied: patchReport.applied || [],
      noop: patchReport.noop || [],
      skipped: patchReport.skipped || [],
    },
    decodedPaths: typeof source.decodedPaths === "number" ? source.decodedPaths : null,
  };
  fs.writeFileSync(path.join(outApp, "BUILD-INFO.json"), JSON.stringify(buildInfo, null, 2) + "\n");
  console.log(
    `   [build-info] BUILD-INFO.json 已写入 (appVersion=${buildInfo.appVersion}, ` +
    `msixVersion=${buildInfo.msixVersion}, cli=${buildInfo.cli.used}, decodedPaths=${buildInfo.decodedPaths})`
  );

  // ─── ZIP + SHA256SUMS.txt ───────────────────────────────────
  const zipPath = path.join(OUT_DIR, zipName);
  console.log(`   [zip] ${zipName}`);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  createZip(outApp, zipPath);

  const sizeMB = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  console.log(`   [ok] ${zipPath} (${sizeMB} MB)`);

  const sums = path.join(OUT_DIR, "SHA256SUMS.txt");
  const digest = sha256File(zipPath);
  fs.writeFileSync(sums, `${digest}  ${zipName}\n`);
  console.log(`   [ok] SHA256SUMS.txt: ${digest}  ${zipName}`);
}

/**
 * 打 zip：7zz -> 7z -> C:\Program Files\7-Zip\7z.exe
 */
function createZip(srcDir, zipPath) {
  const sevenZip = findSevenZip();
  if (!sevenZip) {
    throw new Error("未找到 7-Zip (7zz / 7z / C:\\Program Files\\7-Zip\\7z.exe)，无法打包");
  }
  execFileSync(sevenZip, ["a", "-tzip", "-mx=5", zipPath, "."], { cwd: srcDir, stdio: "inherit" });
}

// ─── ASAR integrity ─────────────────────────────────────────────

function computeAsarHeaderHash(asarPath) {
  const crypto = require("crypto");
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const header = buf.slice(16, 16 + headerSize);
  return crypto.createHash("sha256").update(header).digest("hex");
}

function patchExeHash(exePath, oldHash, newHash) {
  const buf = fs.readFileSync(exePath);
  const oldBuf = Buffer.from(oldHash, "ascii");
  const idx = buf.indexOf(oldBuf);
  if (idx < 0) return false;
  Buffer.from(newHash, "ascii").copy(buf, idx);
  fs.writeFileSync(exePath, buf);
  console.log(`   [integrity] ${path.basename(exePath)}: hash patched at offset ${idx}`);
  return true;
}

/**
 * 在应用根目录的可执行文件 / DLL 里查找并替换嵌入的 asar 头哈希。
 *
 * 注意：当前的 Codex 包用的是 owl 运行时（ChatGPT.exe 只是外壳，
 * 真正的运行时在 chrome.dll 里），实测这些二进制里 **没有** 嵌入
 * asar 完整性哈希，补丁后的 app.asar 照样能正常加载。原先的代码
 * 只对 Codex.exe 做一次查找，找不到就打一条 `[!]` 日志，很容易被
 * 误读成「补丁失败」。这里改成遍历所有候选文件，全都找不到时明确
 * 说明这是预期行为。
 */
function patchAsarIntegrityInBinaries(outApp, oldHash, newHash) {
  const preferred = ["ChatGPT.exe", "Codex.exe", "chrome.dll"];
  const rootFiles = fs.readdirSync(outApp, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(exe|dll)$/i.test(e.name))
    .map((e) => e.name);
  const candidates = [
    ...preferred.filter((n) => rootFiles.includes(n)),
    ...rootFiles.filter((n) => !preferred.includes(n)),
  ];

  let patched = 0;
  const searched = [];
  for (const name of candidates) {
    const p = path.join(outApp, name);
    try {
      if (patchExeHash(p, oldHash, newHash)) patched++;
      searched.push(name);
    } catch (e) {
      console.log(`   [!] ${name}: 读取失败 ${e.message}`);
    }
  }

  if (patched === 0) {
    console.log(
      `   [info] 该运行时没有嵌入 asar 完整性哈希，无需修补` +
      `（已搜索 ${searched.length} 个 exe/dll）`
    );
  } else {
    console.log(`   [integrity] 共修补 ${patched} 个二进制`);
  }
  return patched;
}

function updateAsarIntegrity(asarPath, infoPlistPath) {
  const newHash = computeAsarHeaderHash(asarPath);
  execSync(`plutil -replace ElectronAsarIntegrity.Resources/app\\\\.asar.hash -string "${newHash}" "${infoPlistPath}"`, { stdio: "pipe" });
  execSync(`plutil -replace ElectronAsarIntegrity.Resources/app\\\\.asar.algorithm -string "SHA256" "${infoPlistPath}"`, { stdio: "pipe" });

  // Verify
  const verify = execSync(`plutil -extract ElectronAsarIntegrity.Resources/app\\\\.asar.hash raw "${infoPlistPath}"`, { encoding: "utf-8" }).trim();
  if (verify === newHash) {
    console.log(`   [integrity] hash updated: ${newHash.slice(0, 16)}...`);
  } else {
    console.log(`   [!] integrity verify failed`);
  }
}

// ─── Shared ─────────────────────────────────────────────────────

function replaceCodex(platform, resourcesDir, binName) {
  const vendor = resolveCodexVendor(platform);
  if (vendor) {
    const dest = path.join(resourcesDir, binName);
    fs.copyFileSync(vendor, dest);
    try { fs.chmodSync(dest, 0o755); } catch {}
    console.log(`   [codex] replaced with @cometix/codex`);
  } else {
    console.log(`   [!] @cometix/codex not found, keeping upstream codex`);
  }
}

function getVersion(asarDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(asarDir, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;

  if (!platform || !["mac-arm64", "mac-x64", "win"].includes(platform)) {
    console.error("[x] Usage: build-from-upstream.js --platform <mac-arm64|mac-x64|win>");
    process.exit(1);
  }

  console.log(`\n== Build from upstream: ${platform} ==\n`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (platform.startsWith("mac")) {
    buildMac(platform);
  } else {
    buildWin(platform);
  }
}

main();
