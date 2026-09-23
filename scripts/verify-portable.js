#!/usr/bin/env node
/**
 * verify-portable.js — Windows 免安装包构建后自检（CI 闸门）
 *
 * 用法：
 *   node scripts/verify-portable.js <应用目录> [选项]
 *
 * 选项：
 *   --reference <dir>   解码后的官方 app 目录（通常是 %TEMP%\codex-sync\win-extract\app）
 *   --cli <mode>        official | cometix | auto（默认读 BUILD-INFO.json，再退回 official）
 *   --report <file>     把结构化结果写成 JSON
 *   --smoke             额外做 G 项：真的启动一次应用（会拉起 GUI 进程）
 *   --smoke-force       在已有真实 Codex 用户数据的机器上也强制做 G 项（见下方警告，默认拒绝）
 *
 * 检查项：
 *   A. 产物里没有任何百分号编码路径（%XX）
 *   B. 与官方参照逐文件一致（大小 + 关键文件 SHA-256）
 *   C. computer use 组件完整且 @oai/sky 可被加载
 *   D. resources/codex.exe 可运行，版本符合预期，并报告 thread/delete 支持情况
 *   E. 官方二进制数字签名仍然有效（证明没有误改）
 *   F. app.asar 可被 asar list 读取
 *   G. （--smoke）在隔离环境里真的启动一次应用，确认能起来
 *
 * 任一致命项失败 -> 退出码 1。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFileSync, execSync, spawn } = require("child_process");
const { findEncodedPaths } = require("./lib/msix-paths");
const { parseVersion, detectThreadDelete } = require("./lib/cli-policy");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";

// ─── 参数 ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reference" || a === "--cli" || a === "--report") {
      opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      opts[k] = v === undefined ? true : v;
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

// ─── 结果收集 ───────────────────────────────────────────────────

const results = [];

function record(id, name, status, { fatal = true, details = [] } = {}) {
  results.push({ id, name, status, fatal, details });
  return status;
}

const STATUS_LABEL = { pass: "通过", fail: "失败", skip: "跳过", warn: "警告" };

// ─── 工具 ───────────────────────────────────────────────────────

/**
 * 运行 Windows PowerShell 5.1 的一段命令，返回标准输出。
 *
 * 为什么不直接 execFileSync("powershell.exe", ...)：如果本脚本是从 PowerShell 7（pwsh）
 * 里启动的 —— GitHub Actions 的 windows-latest 默认 shell 就是 pwsh —— 子进程会继承
 * pwsh 改写过的 PSModulePath，5.1 会去加载 7.x 版本的内置模块，结果连
 * Get-AuthenticodeSignature / Get-Process / Start-Sleep 都报「无法加载模块」。
 * 所以这里去掉继承来的 PSModulePath，让 5.1 用它自己的默认模块路径。
 */
/**
 * 真正的异步等待。冒烟测试轮询时必须让出事件循环：以前用同步起一个 powershell Start-Sleep 的写法
 * 会一直占着事件循环，应用进程的 exit 事件在轮询期间根本回调不进来，「启动后闪退」就检测不到。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runWinPowerShell(command, { timeout = 60000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() !== "psmodulepath") env[k] = v;
  }
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return execFileSync(fs.existsSync(exe) ? exe : "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf-8", timeout, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer, env,
  });
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

function listFilesRel(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (!e.isSymbolicLink()) out.push(path.relative(root, full));
    }
  })(root);
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

// ─── A. 百分号编码路径 ──────────────────────────────────────────

function checkEncodedPaths(appDir) {
  const encoded = findEncodedPaths(appDir);
  if (encoded.length === 0) {
    return record("A", "路径编码（无 %XX 残留）", "pass", {
      details: ["产物中没有百分号编码路径"],
    });
  }
  const details = [
    `发现 ${encoded.length} 个仍含 %XX 的路径（MSIX 解压未解码，Node 无法按 @scope 解析模块）`,
    ...encoded.slice(0, 15).map((p) => `  ${p}`),
  ];
  if (encoded.length > 15) details.push(`  …另有 ${encoded.length - 15} 个`);
  return record("A", "路径编码（无 %XX 残留）", "fail", { details });
}

// ─── B. 与官方参照一致 ──────────────────────────────────────────

const KEY_BINARIES = ["ChatGPT.exe", "Codex.exe", "chrome.dll"];

function checkReference(appDir, referenceDir, cliMode) {
  if (!referenceDir) {
    return record("B", "与官方参照一致", "skip", {
      details: ["未提供 --reference，跳过逐文件比对"],
    });
  }
  if (!fs.existsSync(referenceDir)) {
    return record("B", "与官方参照一致", "fail", {
      details: [`参照目录不存在: ${referenceDir}`],
    });
  }

  // app.asar 是被补丁过的；cometix 模式下 codex.exe 是被替换的
  const allowDiff = new Set([path.join("resources", "app.asar")]);
  if (cliMode === "cometix") allowDiff.add(path.join("resources", "codex.exe"));

  const refFiles = listFilesRel(referenceDir);
  const missing = [];
  const sizeMismatch = [];

  for (const rel of refFiles) {
    if (allowDiff.has(rel)) continue;
    const target = path.join(appDir, rel);
    if (!fs.existsSync(target)) { missing.push(rel); continue; }
    const a = fs.statSync(path.join(referenceDir, rel)).size;
    const b = fs.statSync(target).size;
    if (a !== b) sizeMismatch.push(`${rel} (官方 ${a} / 产物 ${b})`);
  }

  // 关键文件 SHA-256
  const hashTargets = [...KEY_BINARIES];
  if (cliMode !== "cometix") hashTargets.push(path.join("resources", "codex.exe"));
  const hashMismatch = [];
  const hashOk = [];
  for (const rel of hashTargets) {
    const refFile = path.join(referenceDir, rel);
    const outFile = path.join(appDir, rel);
    if (!fs.existsSync(refFile) || !fs.existsSync(outFile)) continue;
    const h1 = sha256File(refFile);
    const h2 = sha256File(outFile);
    if (h1 !== h2) hashMismatch.push(`${rel}: 官方 ${h1.slice(0, 16)}… != 产物 ${h2.slice(0, 16)}…`);
    else hashOk.push(`${rel}: ${h1.slice(0, 16)}…`);
  }

  const details = [
    `参照文件 ${refFiles.length} 个，豁免比对 ${[...allowDiff].join(", ")}`,
    `关键文件 SHA-256 一致: ${hashOk.length}/${hashTargets.length}`,
    ...hashOk.map((s) => `  ${s}`),
  ];
  if (missing.length) {
    details.push(`产物中缺失 ${missing.length} 个官方文件:`);
    details.push(...missing.slice(0, 15).map((p) => `  ${p}`));
  }
  if (sizeMismatch.length) {
    details.push(`大小不一致 ${sizeMismatch.length} 个:`);
    details.push(...sizeMismatch.slice(0, 15).map((p) => `  ${p}`));
  }
  if (hashMismatch.length) {
    details.push(`关键文件哈希不一致:`);
    details.push(...hashMismatch.map((p) => `  ${p}`));
  }

  const ok = missing.length === 0 && sizeMismatch.length === 0 && hashMismatch.length === 0;
  return record("B", "与官方参照一致", ok ? "pass" : "fail", { details });
}

// ─── C. computer use ────────────────────────────────────────────

const CUA_BIN = path.join("resources", "cua_node", "bin");
const SKY_PKG = path.join(CUA_BIN, "node_modules", "@oai", "sky", "package.json");

function checkComputerUse(appDir) {
  const required = [
    path.join(CUA_BIN, "node.exe"),
    path.join(CUA_BIN, "node_repl.exe"),
    SKY_PKG,
    path.join(CUA_BIN, "node_modules", "@oai", "sky", "bin", "windows", "codex-computer-use.exe"),
  ];

  const details = [];
  const missing = [];
  for (const rel of required) {
    if (fs.existsSync(path.join(appDir, rel))) details.push(`  存在 ${rel}`);
    else missing.push(rel);
  }
  if (missing.length) {
    return record("C", "computer use 组件", "fail", {
      details: [
        ...details,
        `缺失 ${missing.length} 个文件（多半是 %40oai 未解码导致）:`,
        ...missing.map((p) => `  ${p}`),
      ],
    });
  }

  if (!IS_WIN) {
    return record("C", "computer use 组件", "skip", {
      details: [...details, "非 Windows 平台，跳过 @oai/sky 加载测试"],
    });
  }

  // 用捆绑的 node.exe 真正加载一次 @oai/sky。
  // cwd 设为 cua_node/bin，这样 require 和 bare import 都会走
  // 它下面的 node_modules。
  const nodeExe = path.join(appDir, CUA_BIN, "node.exe");
  const cwd = path.join(appDir, CUA_BIN);
  // 注意：@oai/sky 是 ESM（"type":"module"，且带 top-level await），
  // require() 会失败是正常的，所以要再试一次 import()。
  // 它的 exports 也没有导出 ./package.json，元信息直接读文件。
  const probe = `
(async () => {
  const out = { ok: false, mode: "", errors: [] };
  try {
    const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
    out.name = p.name; out.version = p.version;
  } catch (e) { out.errors.push("读取 package.json: " + e.message); }
  try { require("@oai/sky"); out.ok = true; out.mode = "require"; }
  catch (e1) {
    out.errors.push("require: " + e1.message);
    try { await import("@oai/sky"); out.ok = true; out.mode = "import"; }
    catch (e2) { out.errors.push("import: " + e2.message); }
  }
  console.log("PROBE" + JSON.stringify(out));
})();
`;

  let raw = "";
  try {
    raw = execFileSync(nodeExe, ["-e", probe, path.join(appDir, SKY_PKG)], {
      cwd,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    raw = (e.stdout || "") + "";
    if (!raw.includes("PROBE")) {
      return record("C", "computer use 组件", "fail", {
        details: [...details, `node.exe 探测失败: ${e.message}`, String(e.stderr || "").slice(0, 500)],
      });
    }
  }

  const m = raw.match(/PROBE(\{[\s\S]*\})/);
  if (!m) {
    return record("C", "computer use 组件", "fail", {
      details: [...details, `无法解析探测输出: ${raw.slice(0, 300)}`],
    });
  }
  const probeResult = JSON.parse(m[1]);
  details.push(`  ${probeResult.name || "@oai/sky"}@${probeResult.version || "?"}`);
  if (probeResult.ok) {
    details.push(`  加载成功（方式: ${probeResult.mode}）`);
    return record("C", "computer use 组件", "pass", { details });
  }
  return record("C", "computer use 组件", "fail", {
    details: [...details, "@oai/sky 无法被 require 或 import:", ...probeResult.errors.map((e) => `  ${e}`)],
  });
}

// ─── D. CLI 可运行 ──────────────────────────────────────────────

function checkCli(appDir, referenceDir, cliMode, buildInfo) {
  const cliPath = path.join(appDir, "resources", "codex.exe");
  if (!fs.existsSync(cliPath)) {
    return record("D", "codex CLI 可运行", "fail", { details: [`缺失 ${cliPath}`] });
  }
  if (!IS_WIN) {
    return record("D", "codex CLI 可运行", "skip", { details: ["非 Windows 平台，跳过执行"] });
  }

  let out = "";
  try {
    out = execFileSync(cliPath, ["--version"], {
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch (e) {
    out = String(e.stdout || "").trim();
    if (!out) {
      return record("D", "codex CLI 可运行", "fail", {
        details: [`执行 codex.exe --version 失败: ${e.message}`],
      });
    }
  }
  if (!out) {
    return record("D", "codex CLI 可运行", "fail", { details: ["codex.exe --version 无输出"] });
  }

  const details = [`产物 CLI 版本: ${out}`, `模式: ${cliMode}`];

  // 官方模式下不应该混进第三方 CLI —— 这正是「codex cli 版本太旧」的来源
  if (cliMode === "official" && /cometix/i.test(out)) {
    return record("D", "codex CLI 可运行", "fail", {
      details: [...details, "官方模式下 resources/codex.exe 却是 @cometix/codex 构建，版本通常落后于官方"],
    });
  }

  if (cliMode === "official" && referenceDir) {
    const refCli = path.join(referenceDir, "resources", "codex.exe");
    if (fs.existsSync(refCli)) {
      let refOut = "";
      try {
        refOut = execFileSync(refCli, ["--version"], {
          encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        }).trim();
      } catch (e) { refOut = String(e.stdout || "").trim(); }
      details.push(`官方参照 CLI 版本: ${refOut || "(无输出)"}`);
      if (refOut && refOut !== out) {
        return record("D", "codex CLI 可运行", "fail", {
          details: [...details, "官方模式下产物 CLI 版本与参照不一致"],
        });
      }
    }
  }

  if (cliMode === "cometix") {
    const v = parseVersion(out);
    if (v && !/cometix/i.test(out)) {
      details.push("[!] cometix 模式，但版本串里没有 cometix 标记");
    }
  }

  // ── thread/delete 能力 ──
  // 26.915 起应用本体自带「删除已归档会话 / 全部删除」的界面，它会调用
  // app-server 的 thread/delete；CLI 不支持时界面只会提示「不支持」。
  // 这里现场对产物里的 codex.exe 重新检测一次（不信 BUILD-INFO 的自述），
  // 检测为 false 记警告（非致命），null 只提示无法确认。
  const live = IS_WIN ? detectThreadDelete(cliPath) : null;
  const declared = buildInfo?.cli?.supportsThreadDelete;
  details.push(
    `thread/delete 支持: 实测=${live === true ? "是" : live === false ? "否" : "无法确认"}` +
    `（BUILD-INFO 记录=${declared === true ? "是" : declared === false ? "否" : "无法确认"}）`
  );
  if (live !== null && declared !== undefined && declared !== null && live !== declared) {
    details.push("[!] 实测结果与 BUILD-INFO 记录不一致");
  }

  if (live === false) {
    return record("D", "codex CLI 可运行", "warn", {
      fatal: false,
      details: [
        ...details,
        "该 CLI 的 app-server 不支持 thread/delete，应用内「删除已归档会话」会提示不支持",
      ],
    });
  }
  if (live === null && IS_WIN) {
    details.push("（无法确认 thread/delete 支持情况，不计为问题）");
  }

  return record("D", "codex CLI 可运行", "pass", { details });
}

// ─── E. 数字签名 ────────────────────────────────────────────────

// 严重级别分档：
//   Valid + 签名者含 OpenAI        -> ok
//   Valid 但签名者不是 OpenAI      -> fail（二进制被换掉了）
//   HashMismatch / NotSigned       -> fail（被改动，或根本没签名）
//   其它（UnknownError、NotTrusted、Incompatible…）-> warn
// CI runner 上吊销检查等网络原因常常返回 UnknownError，不该误杀构建。
const FATAL_SIGNATURE_STATUS = new Set(["HashMismatch", "NotSigned"]);

function classifySignature(status, signer) {
  if (status === "Valid") return /OpenAI/i.test(signer || "") ? "ok" : "fail";
  if (FATAL_SIGNATURE_STATUS.has(status)) return "fail";
  return "warn";
}

function checkSignatures(appDir, cliMode) {
  if (!IS_WIN) {
    return record("E", "官方二进制数字签名", "skip", { details: ["非 Windows 平台，跳过签名检查"] });
  }

  const targets = ["ChatGPT.exe", "Codex.exe"];
  const resourcesDir = path.join(appDir, "resources");
  if (fs.existsSync(resourcesDir)) {
    for (const n of fs.readdirSync(resourcesDir)) {
      if (/^codex-.*\.exe$/i.test(n)) targets.push(path.join("resources", n));
    }
  }
  const cometixCli = cliMode === "cometix" ? path.join("resources", "codex.exe") : null;
  if (!cometixCli) targets.push(path.join("resources", "codex.exe"));

  const existing = targets.filter((t) => fs.existsSync(path.join(appDir, t)));
  if (existing.length === 0) {
    return record("E", "官方二进制数字签名", "fail", { details: ["没有找到任何待检查的可执行文件"] });
  }

  const psList = existing.map((t) => `'${path.join(appDir, t).replace(/'/g, "''")}'`).join(",");
  const ps = `$ErrorActionPreference='Stop'; @(${psList}) | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; [PSCustomObject]@{ path=$_; status=$s.Status.ToString(); signer=$(if($s.SignerCertificate){$s.SignerCertificate.Subject}else{''}) } } | ConvertTo-Json -Compress -Depth 3`;

  let raw;
  try {
    raw = runWinPowerShell(ps, { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    return record("E", "官方二进制数字签名", "fail", {
      details: [`Get-AuthenticodeSignature 执行失败: ${e.message}`, String(e.stderr || "").slice(0, 400)],
    });
  }

  let rows;
  try {
    rows = JSON.parse(raw);
    if (!Array.isArray(rows)) rows = [rows];
  } catch {
    return record("E", "官方二进制数字签名", "fail", {
      details: [`无法解析 PowerShell 输出: ${raw.slice(0, 300)}`],
    });
  }

  const details = [];
  const bad = [];
  const warned = [];
  for (const r of rows) {
    const rel = path.relative(appDir, r.path);
    const cn = String(r.signer || "").match(/CN=("([^"]*)"|[^,]*)/);
    const verdict = classifySignature(r.status, r.signer);
    const mark = verdict === "ok" ? "" : verdict === "fail" ? "  <- 失败" : "  <- 警告（非致命）";
    details.push(`  ${rel}: ${r.status}${cn ? ` | CN=${cn[2] ?? cn[1]}` : ""}${mark}`);
    if (verdict === "fail") bad.push(`${rel} (${r.status}${r.status === "Valid" ? "，签名者非 OpenAI" : ""})`);
    if (verdict === "warn") warned.push(`${rel} (${r.status})`);
  }
  if (cometixCli) {
    details.push(`  ${cometixCli}: cometix 模式，允许未签名（已豁免）`);
  }

  if (bad.length) {
    return record("E", "官方二进制数字签名", "fail", {
      details: [...details, `签名缺失/被篡改/签名者非 OpenAI: ${bad.join(", ")}`],
    });
  }
  if (warned.length) {
    return record("E", "官方二进制数字签名", "warn", {
      fatal: false,
      details: [
        ...details,
        `以下文件签名状态无法确认（多半是吊销检查等网络原因），不计为失败: ${warned.join(", ")}`,
      ],
    });
  }
  return record("E", "官方二进制数字签名", "pass", { details });
}

// ─── F. app.asar 可读 ───────────────────────────────────────────

function checkAsar(appDir) {
  const asarPath = path.join(appDir, "resources", "app.asar");
  if (!fs.existsSync(asarPath)) {
    return record("F", "app.asar 可读", "fail", { details: [`缺失 ${asarPath}`] });
  }
  let out;
  try {
    out = execSync(`npx --no-install asar list "${asarPath}"`, {
      cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 180000,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024,
    });
  } catch (e) {
    return record("F", "app.asar 可读", "fail", {
      details: [`asar list 失败: ${e.message}`, String(e.stderr || "").slice(0, 400)],
    });
  }
  // asar list 在 Windows 上输出反斜杠路径，统一成 / 再比对
  const lines = out.split("\n").map((l) => l.trim().replace(/\\/g, "/")).filter(Boolean);
  const hasPkg = lines.includes("/package.json");
  if (!hasPkg) {
    return record("F", "app.asar 可读", "fail", {
      details: [`asar list 成功但未找到 package.json（共 ${lines.length} 条）`],
    });
  }
  return record("F", "app.asar 可读", "pass", {
    details: [`asar list 成功，共 ${lines.length} 个条目，含 package.json`],
  });
}

// ─── G. 启动冒烟测试（--smoke） ─────────────────────────────────
//
// 前面 A–F 全绿也**不等于应用能启动** —— 26.915 起 bootstrap 会在
// codexWindowsAppContainedCore==="1" 时去要 Windows 的「程序包标识」，
// 免安装包没有包标识，直接弹「该进程没有程序包标识符」而起不来。
// 所以必须真的拉起来看一眼。
//
// 隔离方式（三个环境变量都指向临时目录，绝不碰用户真实数据）：
//   CODEX_ELECTRON_USER_DATA_PATH  -> userData（官方代码里就读这个）
//   CODEX_HOME                     -> CLI 的配置/会话目录
//   LOCALAPPDATA                   -> 日志目录。实测日志路径是
//                                     `${LOCALAPPDATA}\Codex\Logs\Y\M\D\`，
//                                     由 LOCALAPPDATA 决定而不是 userData，
//                                     所以必须连它一起改掉才能隔离日志。
// ⚠ 隔离并不完全：内置浏览器 profile 仍写到真实的 %APPDATA%\Codex\web\Codex，见 checkSmoke 里的保护。
// 故意**不设** CODEX_CLI_PATH —— 它是上面那个开关的旁路条件之一，设了
// 就会掩盖真正的问题。

const SMOKE_FAIL_MARKER = "Desktop bootstrap failed";
const SMOKE_OK_MARKER = "Launching app";

/**
 * 找出当前在跑的 Codex 桌面应用进程。
 *
 * 只认这几种，避免把 CodexUpdater.exe、插件的 extension-host.exe 之类
 * 不相干的进程也算进来（它们路径里同样有 "Codex" 字样）：
 *   - 进程名正好是 ChatGPT / Codex
 *   - 可执行文件在 %LOCALAPPDATA%\OpenAI\Codex 下（商店安装位置）
 *   - 可执行文件在 ...\OpenAI.Codex_... 下（MSIX 包目录）
 *   - 可执行文件在本次要测的产物目录下
 */
function findRunningCodexProcesses(appDir) {
  const esc = (s) => s.replace(/'/g, "''");
  const localAppData = process.env.LOCALAPPDATA || "";
  const ps = `$ErrorActionPreference='SilentlyContinue';
$appDir = '${esc(appDir)}';
$storeDir = '${esc(path.join(localAppData, "OpenAI", "Codex"))}';
Get-Process | ForEach-Object {
  $p = $null; try { $p = $_.Path } catch {}
  [PSCustomObject]@{ id=$_.Id; name=$_.ProcessName; path=$p }
} | Where-Object {
  $_.name -in @('ChatGPT','Codex') -or
  ($_.path -and (
    $_.path -like "$storeDir\\*" -or
    $_.path -like '*\\OpenAI.Codex_*' -or
    $_.path -like "$appDir\\*"
  ))
} | ConvertTo-Json -Compress`;
  try {
    const raw = runWinPowerShell(ps, { timeout: 60000 }).trim();
    if (!raw) return [];
    let rows = JSON.parse(raw);
    if (!Array.isArray(rows)) rows = [rows];
    return rows;
  } catch {
    return [];
  }
}

/** 递归收集某目录下 mtime 晚于 since 的 .log 文件 */
function collectLogs(dir, since) {
  const out = [];
  (function walk(d) {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.log$/i.test(e.name)) continue;
      try { if (fs.statSync(full).mtimeMs >= since) out.push(full); } catch {}
    }
  })(dir);
  return out;
}

function readLogs(files) {
  let text = "";
  for (const f of files) {
    try { text += fs.readFileSync(f, "utf-8"); } catch {}
  }
  return text;
}

function dirFingerprint(p) {
  try {
    const s = fs.statSync(p);
    let count = -1;
    if (s.isDirectory()) { try { count = fs.readdirSync(p).length; } catch {} }
    return `${s.size}B mtime=${new Date(s.mtimeMs).toISOString()}${count >= 0 ? ` entries=${count}` : ""}`;
  } catch { return "(不存在)"; }
}

async function checkSmoke(appDir, enabled, force) {
  if (!enabled) {
    return record("G", "启动冒烟测试", "skip", {
      fatal: false,
      details: ["未传 --smoke，跳过（该项会真的启动一次应用）"],
    });
  }
  if (!IS_WIN) {
    return record("G", "启动冒烟测试", "skip", { fatal: false, details: ["非 Windows 平台，跳过"] });
  }

  const exe = path.join(appDir, "ChatGPT.exe");
  if (!fs.existsSync(exe)) {
    return record("G", "启动冒烟测试", "fail", { details: [`缺失 ${exe}`] });
  }

  // 1) 先确认没有 Codex 在跑，避免打扰用户正在使用的实例
  const running = findRunningCodexProcesses(appDir);
  if (running.length > 0) {
    return record("G", "启动冒烟测试", "warn", {
      fatal: false,
      details: [
        `检测到 ${running.length} 个疑似 Codex/ChatGPT 进程正在运行，跳过冒烟测试以免干扰：`,
        ...running.slice(0, 8).map((r) => `  pid=${r.id} ${r.name} ${r.path || ""}`),
      ],
    });
  }

  // 1b) 已知的隔离缺口（2026-09-20 实测发现）：应用内置浏览器的 Chromium profile
  //     无视 CODEX_ELECTRON_USER_DATA_PATH，固定写到 %APPDATA%\Codex\web\Codex
  //     （日志里有 "Ignoring late userData path change after native startup"）。
  //     所以在已经装过 Codex 的机器上跑冒烟，会往真实的浏览器缓存里写入
  //     几百个缓存/状态文件（登录凭据 auth.json、会话库、config.toml 不受影响）。
  //     CI 的干净 runner 没有这个问题；开发机默认拒绝，除非显式 --smoke-force。
  const realWebProfile = path.join(process.env.APPDATA || "", "Codex", "web");
  const inCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
  if (!inCI && !force && process.env.APPDATA && fs.existsSync(realWebProfile)) {
    return record("G", "启动冒烟测试", "warn", {
      fatal: false,
      details: [
        `跳过：本机已有真实的 Codex 用户数据（${realWebProfile}）。`,
        "冒烟测试的隔离对内置浏览器缓存无效：应用会把它固定写到上面这个真实目录，污染其中的缓存和状态文件。",
        "如果你清楚这一点并接受，请加 --smoke-force；在 CI 的干净环境里会自动执行。",
      ],
    });
  }

  // 2) 准备隔离环境
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-smoke-"));
  const userData = path.join(tmpRoot, "userdata");
  const codexHome = path.join(tmpRoot, "codexhome");
  const localAppData = path.join(tmpRoot, "localappdata");
  for (const d of [userData, codexHome, localAppData]) fs.mkdirSync(d, { recursive: true });

  // 隔离有效性取证：记录真实目录的指纹
  const realProbes = {
    "~/.codex/config.toml": path.join(os.homedir(), ".codex", "config.toml"),
    "~/.codex/state_5.sqlite": path.join(os.homedir(), ".codex", "state_5.sqlite"),
    "%APPDATA%/Codex": path.join(process.env.APPDATA || "", "Codex"),
    "%LOCALAPPDATA%/Codex/Logs": path.join(process.env.LOCALAPPDATA || "", "Codex", "Logs"),
  };
  const before = {};
  for (const [k, p] of Object.entries(realProbes)) before[k] = dirFingerprint(p);

  const details = [
    `隔离环境: userData=${userData}`,
    `           CODEX_HOME=${codexHome}`,
    `           LOCALAPPDATA=${localAppData}（日志会落在它下面的 Codex\\Logs）`,
    "（故意不设 CODEX_CLI_PATH —— 它是包标识检查的旁路条件，设了会掩盖问题）",
  ];

  const startedAt = Date.now() - 1000;
  const logRoot = path.join(localAppData, "Codex", "Logs");
  let child = null;
  let verdict = null;
  let logText = "";

  const cleanup = () => {
    if (child && child.pid) {
      // 只按记录到的 PID 结束进程树，绝不按名称杀 codex/ChatGPT
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "pipe", timeout: 30000, windowsHide: true,
        });
      } catch {}
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  };

  try {
    child = spawn(exe, [], {
      env: {
        ...process.env,
        CODEX_ELECTRON_USER_DATA_PATH: userData,
        CODEX_HOME: codexHome,
        LOCALAPPDATA: localAppData,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    let exited = false;
    let exitInfo = "";
    child.on("exit", (code, sig) => { exited = true; exitInfo = `code=${code} sig=${sig}`; });
    child.on("error", (e) => { exited = true; exitInfo = `spawn error: ${e.message}`; });

    details.push(`已启动 ChatGPT.exe，pid=${child.pid}`);

    // 3) 最多等 45 秒，轮询日志
    const deadline = Date.now() + 45000;
    let sawOk = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      logText = readLogs(collectLogs(logRoot, startedAt));
      if (logText.includes(SMOKE_FAIL_MARKER)) { verdict = "fail"; break; }
      if (logText.includes(SMOKE_OK_MARKER)) { sawOk = true; break; }
      if (exited) break;
    }

    if (verdict !== "fail" && sawOk) {
      // 4) 再观察 20 秒，确认没有后续崩溃且进程仍在
      const watchUntil = Date.now() + 20000;
      while (Date.now() < watchUntil) {
        await sleep(2000);
        logText = readLogs(collectLogs(logRoot, startedAt));
        if (logText.includes(SMOKE_FAIL_MARKER)) { verdict = "fail"; break; }
      }
      if (verdict !== "fail") verdict = exited ? "warn" : "pass";
      if (verdict === "warn") details.push(`[!] 进程已退出（${exitInfo}），但日志里出现过 ${SMOKE_OK_MARKER}`);
    } else if (verdict !== "fail") {
      verdict = "warn";
      details.push(
        `45 秒内没有看到「${SMOKE_OK_MARKER}」也没有看到「${SMOKE_FAIL_MARKER}」` +
        (exited ? `，进程已退出（${exitInfo}）` : "，进程仍在运行") +
        "，无法确认启动是否成功（比如 CI runner 上没有桌面环境）"
      );
    }

    // 关键日志行
    const pick = (re, label) => {
      const m = logText.match(re);
      if (m) details.push(`  ${label}: ${m[0].slice(0, 220).replace(/\s+/g, " ")}`);
    };
    const logFiles = collectLogs(logRoot, startedAt);
    details.push(`日志文件 ${logFiles.length} 个（${logRoot}）`);
    pick(/[^\n]*source[^\n]{0,80}bundled[^\n]{0,80}/i, "运行时来源");
    pick(/[^\n]*authenticatedAccountPresent[^\n]{0,80}/i, "账号状态");
    pick(/[^\n]*computer-use[^\n]{0,120}(pipe|ready)[^\n]{0,60}/i, "computer-use");
    pick(/[^\n]*browser[^\n]{0,60}pipe listening[^\n]{0,60}/i, "browser-use");
    const errLines = logText.split(/\r?\n/).filter((l) => /\berror\b/i.test(l));
    details.push(`  日志中 error 级行数: ${errLines.length}`);
    if (errLines.length) details.push(...errLines.slice(0, 5).map((l) => `    ${l.slice(0, 220)}`));

    if (verdict === "fail") {
      const m = logText.match(/[^\n]*Desktop bootstrap failed[^\n]*/);
      details.push(`  失败日志: ${(m ? m[0] : "").slice(0, 300)}`);
      details.push(
        "应用启动失败：该版本要求 Windows「程序包标识」，而免安装包没有包标识。",
        "请检查 app.asar/package.json 里的 codexWindowsAppContainedCore 是否已被 patch-portable-mode 置为 \"0\"。"
      );
    }
  } catch (e) {
    verdict = "fail";
    details.push(`冒烟测试执行出错: ${e.message}`);
  } finally {
    cleanup();
  }

  // 5) 隔离有效性取证
  details.push("隔离有效性（真实目录启动前后对比）:");
  let leaked = false;
  for (const [k, p] of Object.entries(realProbes)) {
    const after = dirFingerprint(p);
    const same = after === before[k];
    if (!same) leaked = true;
    details.push(`  ${same ? "未变" : "!! 变了"} ${k}: ${before[k]} -> ${after}`);
  }
  if (leaked) details.push("  [!] 有真实目录被改动，隔离可能不完整");

  return record("G", "启动冒烟测试", verdict, { fatal: verdict === "fail", details });
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const appDir = positional[0] ? path.resolve(positional[0]) : null;

  if (!appDir) {
    console.error("[x] 用法: node scripts/verify-portable.js <应用目录> [--reference <dir>] [--cli official|cometix|auto] [--report <json>]");
    process.exit(2);
  }
  if (!fs.existsSync(appDir)) {
    console.error(`[x] 应用目录不存在: ${appDir}`);
    process.exit(2);
  }

  const buildInfo = readJson(path.join(appDir, "BUILD-INFO.json"));

  // --cli 优先；否则读 BUILD-INFO.json；再否则按 official 处理
  let cliMode = opts.cli ? String(opts.cli).toLowerCase() : null;
  if (!cliMode || cliMode === "auto") {
    const fromInfo = buildInfo?.cli?.used;
    cliMode = fromInfo === "cometix" || fromInfo === "official" ? fromInfo : (cliMode ? "official" : "official");
  }

  const referenceDir = opts.reference ? path.resolve(opts.reference) : null;

  console.log("== Codex 免安装包自检 ==\n");
  console.log(`   应用目录 : ${appDir}`);
  console.log(`   参照目录 : ${referenceDir || "(未提供)"}`);
  console.log(`   CLI 模式 : ${cliMode}${buildInfo ? "" : "（无 BUILD-INFO.json，按默认推断）"}`);
  if (buildInfo) {
    console.log(`   构建信息 : version=${buildInfo.version} cli=${buildInfo.cli?.used} decodedPaths=${buildInfo.decodedPaths}`);
    console.log(`              patches.applied=${(buildInfo.patches?.applied || []).join(",") || "(无)"}`);
    console.log(`              patches.noop   =${(buildInfo.patches?.noop || []).join(",") || "(无)"}`);
    console.log(`              patches.skipped=${(buildInfo.patches?.skipped || []).join(",") || "(无)"}`);
  }
  if (!IS_WIN) console.log("   [!] 非 Windows 平台：执行类检查（C/D/E）会被跳过");
  console.log("");

  checkEncodedPaths(appDir);
  checkReference(appDir, referenceDir, cliMode);
  checkComputerUse(appDir);
  checkCli(appDir, referenceDir, cliMode, buildInfo);
  checkSignatures(appDir, cliMode);
  checkAsar(appDir);
  await checkSmoke(appDir, !!opts.smoke, !!opts["smoke-force"]);

  // ─── 摘要 ──────────────────────────────────────────────────
  console.log("\n== 自检结果 ==\n");
  for (const r of results) {
    console.log(`[${STATUS_LABEL[r.status]}] ${r.id}. ${r.name}`);
    for (const d of r.details) console.log(`        ${d}`);
  }

  const failures = results.filter((r) => r.status === "fail" && r.fatal);
  const passed = results.filter((r) => r.status === "pass").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const warned = results.filter((r) => r.status === "warn").length;

  console.log(
    `\n== 汇总: 通过 ${passed} / 失败 ${results.filter((r) => r.status === "fail").length}` +
    ` / 警告 ${warned} / 跳过 ${skipped}（共 ${results.length} 项）==`
  );

  if (opts.report) {
    const reportPath = path.resolve(opts.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({
      appDir, referenceDir, cliMode, buildInfo,
      checkedAt: new Date().toISOString(),
      results,
      ok: failures.length === 0,
    }, null, 2) + "\n");
    console.log(`   报告已写入 ${reportPath}`);
  }

  if (failures.length > 0) {
    console.error(`\n[x] 自检未通过: ${failures.map((f) => f.id).join(", ")}`);
    process.exit(1);
  }
  console.log("\n[ok] 自检全部通过");
}

module.exports = { classifySignature };

if (require.main === module) {
  main().catch((e) => {
    console.error(`[x] 自检脚本异常: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
}
