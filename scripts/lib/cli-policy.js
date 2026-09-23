/**
 * cli-policy.js — 决定产物里用哪一份 codex CLI
 *
 * 背景：历史上构建脚本无条件把官方 resources/codex.exe 换成 npm 包
 * @cometix/codex，目的是拿到当时官方还没有的 `thread/delete` 协议。
 * 但 cometix 始终落后官方，官方 26.915 自带 0.155.0-alpha.9，cometix
 * 最新只有 0.154.0-cometix，于是应用弹出「codex cli 版本太旧」；而
 * `thread/delete` 官方自 0.15x 起早已内置，这个理由也不成立了。
 *
 * 现在的策略：
 *   official  始终保留官方 CLI
 *   cometix   强制替换为 @cometix/codex
 *   auto      仅当 cometix 数字三元组 严格大于 官方，
 *             或 三元组相等且官方带预发布标记 时才用 cometix；
 *             其余情况（含查询失败）一律用官方。
 *
 * 决定会写进 src/<platform>/.cli-choice.json，供 patch-all 与
 * build-from-upstream 共享。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const CHOICE_FILE = ".cli-choice.json";
const MODES = ["official", "cometix", "auto"];
const THREAD_DELETE = "thread/delete";

// ─── 参数解析 ────────────────────────────────────────────────────

/**
 * 从命令行参数 / 环境变量解析 CLI 模式，默认 auto。
 */
function parseCliMode(argv = process.argv.slice(2), env = process.env) {
  const idx = argv.indexOf("--cli");
  let mode = idx !== -1 ? argv[idx + 1] : undefined;
  if (!mode) {
    const inline = argv.find((a) => a.startsWith("--cli="));
    if (inline) mode = inline.slice("--cli=".length);
  }
  if (!mode) mode = env.CODEX_CLI;
  if (!mode) return "auto";

  mode = String(mode).trim().toLowerCase();
  if (!MODES.includes(mode)) {
    console.log(`  [!] 未知 CLI 模式 "${mode}"，回退到 auto`);
    return "auto";
  }
  return mode;
}

// ─── 版本解析 ────────────────────────────────────────────────────

/**
 * 从任意字符串里提取第一个 x.y.z[-prerelease]。
 * 例：
 *   "codex-cli 0.155.0-alpha.9" -> { triple:[0,155,0], prerelease:"alpha.9" }
 *   "0.154.0-cometix"           -> { triple:[0,154,0], prerelease:"cometix" }
 */
function parseVersion(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const m = text.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?/);
  if (!m) return null;
  return {
    raw: text,
    version: m[0],
    triple: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] || "",
  };
}

function compareTriple(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

// ─── 版本查询 ────────────────────────────────────────────────────

/**
 * 运行官方 CLI 取版本号。失败返回 null（不抛）。
 */
function getOfficialCliVersion(cliPath) {
  if (!cliPath || !fs.existsSync(cliPath)) return null;
  try {
    const out = execFileSync(cliPath, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
      windowsHide: true,
    });
    return parseVersion(out);
  } catch (e) {
    const stdout = e && e.stdout ? String(e.stdout) : "";
    return parseVersion(stdout);
  }
}

/**
 * 查询 @cometix/codex 的 npm latest。网络失败返回 null（不抛）。
 */
function getCometixVersion() {
  try {
    const out = execSync("npm view @cometix/codex version", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    return parseVersion(out);
  } catch {
    return null;
  }
}

// ─── thread/delete 能力检测 ──────────────────────────────────────
//
// 26.915 起，应用本体自带「删除已归档会话 / 全部删除」的界面，它通过
// app-server 的 `thread/delete`（threadId: string）真正删掉会话；CLI 不
// 支持时界面只会提示「不支持」。所以随包发布的 codex.exe 支不支持这个
// 方法，直接决定了用户能不能用上那个功能 —— 值得在构建时测一下并记录。
//
// 做法是直接问**将要随包发布的那个 codex.exe** 自己：
//   1. 首选 `codex app-server generate-json-schema --out <tmp>`，看导出的
//      协议 JSON 里有没有 "thread/delete"（最权威）。
//   2. 导出不了（非 Windows 跑不了 .exe、或子命令不存在）就退而求其次，
//      扫二进制里有没有这个 ASCII 字符串。
//   3. 连文件都读不了 -> null（无法判断）。
//
// 结果写进 .cli-choice.json / BUILD-INFO.json 的 cli.supportsThreadDelete，
// verify-portable 的 D 项会现场复测并在为 false 时给出警告。
//
// 检测过程用临时 CODEX_HOME，绝不碰用户真实的 ~/.codex。

function schemaDirHasThreadDelete(dir) {
  let hit = false;
  (function walk(d) {
    if (hit) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith(".json")) continue;
      try {
        if (fs.readFileSync(full, "utf-8").includes(THREAD_DELETE)) hit = true;
      } catch {}
    }
  })(dir);
  return hit;
}

function binaryHasThreadDelete(exePath) {
  const needle = Buffer.from(THREAD_DELETE, "ascii");
  let fd;
  try {
    fd = fs.openSync(exePath, "r");
  } catch {
    return null;
  }
  try {
    const CHUNK = 8 * 1024 * 1024;
    const overlap = needle.length - 1;
    const buf = Buffer.alloc(CHUNK + overlap);
    let carry = 0;
    let n;
    while ((n = fs.readSync(fd, buf, carry, CHUNK, null)) > 0) {
      if (buf.subarray(0, carry + n).includes(needle)) return true;
      buf.copy(buf, 0, carry + n - overlap, carry + n);
      carry = overlap;
    }
    return false;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/**
 * 检测某个 codex CLI 是否支持 app-server 的 thread/delete。
 *
 * @param {string} cliExePath
 * @returns {true|false|null}  null = 无法判断
 */
function detectThreadDelete(cliExePath) {
  if (!cliExePath || !fs.existsSync(cliExePath)) return null;

  // 1) 让 CLI 自己导出协议 schema
  let outDir = null;
  try {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-schema-"));
    const isolatedHome = path.join(outDir, "codex-home");
    fs.mkdirSync(isolatedHome, { recursive: true });
    execFileSync(cliExePath, ["app-server", "generate-json-schema", "--out", outDir], {
      stdio: "pipe",
      timeout: 180000,
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: isolatedHome },
    });
    return schemaDirHasThreadDelete(outDir);
  } catch {
    // 落到二进制扫描
  } finally {
    if (outDir) { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {} }
  }

  // 2) 扫二进制里的 ASCII 字符串
  return binaryHasThreadDelete(cliExePath);
}

// ─── 决策 ────────────────────────────────────────────────────────

/**
 * auto 模式的核心判定。纯函数，便于单独测试。
 */
function decideAuto(official, cometix) {
  if (!official) {
    return { useCometix: false, reason: "无法确定官方 CLI 版本，保守保留官方 CLI" };
  }
  if (!cometix) {
    return { useCometix: false, reason: "无法查询 @cometix/codex 版本（网络失败？），使用官方 CLI" };
  }
  const cmp = compareTriple(cometix.triple, official.triple);
  if (cmp > 0) {
    return {
      useCometix: true,
      reason: `cometix ${cometix.version} 高于官方 ${official.version}`,
    };
  }
  if (cmp === 0 && official.prerelease) {
    return {
      useCometix: true,
      reason: `版本号相同且官方为预发布（${official.prerelease}），改用 cometix ${cometix.version}`,
    };
  }
  return {
    useCometix: false,
    reason: `官方 ${official.raw} 不低于 cometix ${cometix.version}，保留官方 CLI`,
  };
}

/**
 * 完整决策：按模式查询版本并给出结论。
 *
 * @param {object} opts
 * @param {"official"|"cometix"|"auto"} opts.mode
 * @param {string} [opts.officialCliPath] 官方 CLI 路径（src/<plat>/codex[.exe]）
 * @returns {{mode:string, official:string|null, cometix:string|null, useCometix:boolean, reason:string}}
 */
function decideCli({ mode, officialCliPath, cometixCliPath }) {
  const official = getOfficialCliVersion(officialCliPath);

  let choice;
  if (mode === "official") {
    choice = {
      mode,
      official: official ? official.raw : null,
      cometix: null,
      useCometix: false,
      reason: "official 模式：强制使用官方 CLI",
    };
  } else if (mode === "cometix") {
    const cometix = getCometixVersion();
    choice = {
      mode,
      official: official ? official.raw : null,
      cometix: cometix ? cometix.version : null,
      useCometix: true,
      reason: "cometix 模式：强制替换为 @cometix/codex",
    };
  } else {
    const cometix = getCometixVersion();
    const d = decideAuto(official, cometix);
    choice = {
      mode: "auto",
      official: official ? official.raw : null,
      cometix: cometix ? cometix.version : null,
      useCometix: d.useCometix,
      reason: d.reason,
    };
  }

  // 对**实际会随包发布的那个** CLI 做 thread/delete 能力检测
  if (choice.useCometix) {
    // cometix fork 明确带这个功能；拿不到它的二进制路径就直接按 true
    choice.supportsThreadDelete = cometixCliPath
      ? (detectThreadDelete(cometixCliPath) ?? true)
      : true;
  } else {
    choice.supportsThreadDelete = detectThreadDelete(officialCliPath);
  }

  return choice;
}

// ─── 持久化 ──────────────────────────────────────────────────────

function choicePath(platformDir) {
  return path.join(platformDir, CHOICE_FILE);
}

function writeCliChoice(platformDir, choice) {
  try {
    fs.mkdirSync(platformDir, { recursive: true });
    fs.writeFileSync(choicePath(platformDir), JSON.stringify(choice, null, 2) + "\n");
  } catch (e) {
    console.log(`  [!] 写入 ${CHOICE_FILE} 失败: ${e.message}`);
  }
  return choice;
}

function readCliChoice(platformDir) {
  try {
    return JSON.parse(fs.readFileSync(choicePath(platformDir), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 决策 + 落盘，返回决定。
 */
function resolveCliChoice({ mode, platformDir, cliBinName, cometixCliPath }) {
  const binName = cliBinName || (platformDir.endsWith("win") ? "codex.exe" : "codex");
  const choice = decideCli({
    mode,
    officialCliPath: path.join(platformDir, binName),
    cometixCliPath,
  });
  return writeCliChoice(platformDir, choice);
}

module.exports = {
  MODES,
  CHOICE_FILE,
  parseCliMode,
  parseVersion,
  compareTriple,
  decideAuto,
  decideCli,
  resolveCliChoice,
  readCliChoice,
  writeCliChoice,
  getOfficialCliVersion,
  getCometixVersion,
  detectThreadDelete,
  binaryHasThreadDelete,
};
