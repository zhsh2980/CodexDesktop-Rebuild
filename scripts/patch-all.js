#!/usr/bin/env node
/**
 * Run all patch scripts in sequence.
 *
 * Usage:
 *   node scripts/patch-all.js              # Patch both platforms
 *   node scripts/patch-all.js unix         # Patch unix only
 *   node scripts/patch-all.js win          # Patch win only
 *   node scripts/patch-all.js --check      # Dry-run all
 *   node scripts/patch-all.js win --cli official|cometix|auto
 *
 * CLI 策略（--cli / 环境变量 CODEX_CLI，默认 auto）在这里就确定下来，
 * 决定写进 src/<platform>/.cli-choice.json，build-from-upstream 复用。
 *
 * ─── app.asar 补丁默认关闭 ──────────────────────────────────────
 * 自 26.924 起，官方运行时给 app.asar 加了完整性校验（chrome.dll 的
 * Electron fuse EnableEmbeddedAsarIntegrityValidation=1，且 ChatGPT.exe
 * 内嵌了官方 app.asar 头的 SHA-256）。app.asar 只要被改动一个字节，
 * 头哈希就会变，启动即 `Integrity check failed for asar archive` 崩溃。
 * 所以这里默认**不对 _asar 做任何修改**——保持官方文件原样，下面所有
 * 补丁都记为 skipped。
 *
 * 只有显式传 `--patch-asar` 或设置环境变量 `PATCH_ASAR=1` 才会尝试真的
 * 打补丁；即便如此，如果检测到当前源（src/<platform> 或 sync 缓存的
 * MSIX 解压目录）已经启用了上述完整性校验，也会直接拒绝并报错退出——
 * 这个开关只是留给"以后遇到没有完整性校验的运行时"用的逃生舱，不是
 * 绕过校验的手段。
 *
 * 每个补丁的结果分四类，写进 src/<platform>/.patch-report.json：
 *   applied  确实发生了替换
 *   noop     正常退出但一处都没匹配（补丁在当前上游版本上已失效）
 *   skipped  被前置条件主动跳过（默认模式下 = 全部补丁；具体原因见
 *            .patch-report.json 的 skippedReasons）
 *   failed   非 0 退出
 * noop 会在 stdout 打 GitHub Actions 的 ::warning 注解，但不让 job 失败。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { parseCliMode, resolveCliChoice } = require("./lib/cli-policy");
const { detectIntegrityEnforcement, defaultWinCandidateRoots } = require("./lib/asar-integrity");

const SRC_DIR = path.join(__dirname, "..", "src");

const PATCHES = [
  // 必须放最前面：没有它，26.915 起的免安装包根本起不来
  // （「该进程没有程序包标识符」/ Desktop bootstrap failed）
  "patch-portable-mode.js",
  "patch-i18n.js",
  "patch-copyright.js",
  "patch-devtools.js",
  "patch-fast-mode.js",
  "patch-plugin-auth.js",
  "patch-updater.js",
];
// 注：patch-archive-delete 已移除 —— 它给「已归档会话」加的删除按钮，
// 26.915 起官方应用本体已经自带（含「全部删除」和 CLI 能力提示），
// 补丁的两层锚点也都失效了，留着只会每次构建产生一条无意义的警告。

const ALL_PLATFORMS = ["mac-arm64", "mac-x64", "win"];

// ─── 补丁生效判定 ────────────────────────────────────────────────
//
// 补丁脚本即使一处都没匹配上也会 exit 0（例如 patch-copyright 打印
// "[!] No copyright property matched" 后正常退出）。只看退出码就会把
// 死补丁记成 applied，BUILD-INFO 里的 patches.applied 就在说谎，将来
// 上游改了代码结构导致补丁悄悄失效也没人发现。
//
// 这里只在 patch-all 里做分类，**不改动任何补丁脚本的语义或输出**：
// 捕获每个补丁的 stdout（原样转发到日志），再用保守的启发式判定。
//
// 成功信号（满足任意一条即算真的改了东西）：
//   1. 形如 `   * offset 123: X -> Y` 的逐处替换明细行。所有补丁脚本
//      写文件时都会打这种 `*` 行，dry-run(--check) 用的是 `[?]` / `>`，
//      所以这是最可靠的信号。
//   2. `[ok]` / `[done]` 行里带正整数 + 成功动词，例如
//      "[ok] 11 gates patched"、"[ok] i18n gate bypassed: 1 replacements"、
//      "[ok] 4 updater methods disabled"。
//   3. `[ok]` 行里出现 injected（注入类补丁成功）。
// 无成功信号但正常退出 -> noop（例如 "No ... matched"、"0 match"、
// "Already patched or no match"、"already patched or absent"）。

const SUCCESS_VERB_RE = /(replacement|gate|patch|remov|disabl|updat|bypass|route|button|match)/i;
// 排除计数为 0 的情况以及各种「没匹配上」的措辞
const NOOP_PHRASE_RE = /(already patched|no match|not matched|no .{0,40}(found|matched|contain)|absent|\b0 match)/i;

function isSuccessLine(line) {
  // 1) 逐处替换明细行
  if (/^\s*\*\s/.test(line)) return true;

  if (!/\[(ok|done)\]/i.test(line)) return false;
  if (NOOP_PHRASE_RE.test(line)) return false;

  // 3) 注入类
  if (/\binjected\b/i.test(line)) return true;

  // 2) 正整数 + 成功动词
  if (/(?:^|[^\d.])[1-9]\d*\b/.test(line) && SUCCESS_VERB_RE.test(line)) return true;

  return false;
}

/** 取输出的最后 n 行非空内容，用于 noop 注解里给点线索 */
function tailLines(stdout, n) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n);
}

/**
 * @returns {{verdict:"applied"|"noop", evidence:string[]}}
 */
function classifyPatchOutput(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  const evidence = [];
  for (const line of lines) {
    if (isSuccessLine(line)) {
      if (evidence.length < 5) evidence.push(line.trim());
    }
  }
  return { verdict: evidence.length > 0 ? "applied" : "noop", evidence };
}

function resolveTargets(platform) {
  if (platform && platform !== "unix") return [platform];
  const existing = ALL_PLATFORMS.filter((p) => fs.existsSync(path.join(SRC_DIR, p)));
  if (platform === "unix") return existing.filter((p) => p.startsWith("mac"));
  return existing;
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));
  // --cli <mode> 是 patch-all 自己的参数，不要往下传给补丁脚本
  const extra = args.filter((a) => a.startsWith("--") && a !== "--cli" && !a.startsWith("--cli="));
  const passArgs = [...(platform ? [platform] : []), ...extra];

  // ─── CLI 策略 ────────────────────────────────────────────────
  const mode = parseCliMode(args);
  const targets = resolveTargets(platform);
  const choices = [];

  console.log(`== CLI 策略: ${mode} ==`);
  if (targets.length === 0) {
    console.log("  [!] 未找到任何 src/<platform>/ 目录，无法判定 CLI 版本，按官方 CLI 处理");
  }
  for (const plat of targets) {
    const platformDir = path.join(SRC_DIR, plat);
    const choice = resolveCliChoice({
      mode,
      platformDir,
      cliBinName: plat === "win" ? "codex.exe" : "codex",
    });
    choices.push(choice);
    console.log(
      `  [${plat}] 官方=${choice.official || "未知"} cometix=${choice.cometix || "未知"}` +
      ` -> ${choice.useCometix ? "cometix" : "official"}`
    );
    console.log(`         理由: ${choice.reason}`);
    // 仅作信息记录：官方应用自带的「删除已归档会话」界面依赖 CLI 支持
    // thread/delete，verify-portable 的 D 项会据此给出警告
    console.log(
      `         thread/delete 支持: ${
        choice.supportsThreadDelete === true ? "是"
        : choice.supportsThreadDelete === false ? "否（应用内删除已归档会话会提示不支持）" : "无法确认"
      }`
    );
  }

  const useCometix = choices.some((c) => c.useCometix);

  // ─── app.asar 补丁开关 ─────────────────────────────────────────
  const patchAsarRequested = args.includes("--patch-asar") || process.env.PATCH_ASAR === "1";
  console.log(`\n== app.asar 补丁: ${patchAsarRequested ? "已请求（--patch-asar / PATCH_ASAR=1）" : "默认关闭（保持官方文件原样）"} ==`);

  let integrityCheck = null;
  if (targets.includes("win")) {
    const winPlatformDir = path.join(SRC_DIR, "win");
    const roots = defaultWinCandidateRoots({ platformDir: winPlatformDir });
    integrityCheck = detectIntegrityEnforcement(roots);
    console.log(`   [完整性检测] 已检查目录: ${integrityCheck.checkedRoots.join(", ") || "(无，均不存在)"}`);
    if (integrityCheck.fuses && integrityCheck.fuses.found) {
      console.log(
        `   [完整性检测] chrome.dll fuse: EnableEmbeddedAsarIntegrityValidation=${integrityCheck.fuses.asarIntegrityEnabled}` +
        ` OnlyLoadAppFromAsar=${integrityCheck.fuses.onlyLoadFromAsar}（${integrityCheck.fuses.source}）`
      );
    } else {
      console.log(`   [完整性检测] chrome.dll: ${integrityCheck.fuses ? integrityCheck.fuses.reason : "未找到"}`);
    }
    if (integrityCheck.embedded && integrityCheck.embedded.found) {
      console.log(`   [完整性检测] ChatGPT.exe 内嵌 asar 哈希: ${integrityCheck.embedded.entries.length} 条（${integrityCheck.embedded.source}）`);
    } else {
      console.log(`   [完整性检测] ChatGPT.exe: ${integrityCheck.embedded ? integrityCheck.embedded.reason : "未找到"}`);
    }
    console.log(`   [完整性检测] 结论: ${integrityCheck.enforced ? "已启用完整性校验（改动 app.asar 会导致启动崩溃）" : "未检测到强制校验"}`);
  } else {
    console.log("   [完整性检测] 目标平台不含 win，跳过（该检测目前只覆盖 Windows 运行时）");
  }

  if (patchAsarRequested && integrityCheck && integrityCheck.enforced) {
    console.error(
      "\n[x] 已请求 --patch-asar / PATCH_ASAR=1，但检测到当前运行时已启用 app.asar 完整性校验\n" +
      "    （chrome.dll fuse EnableEmbeddedAsarIntegrityValidation=1 和/或 ChatGPT.exe 内嵌了 asar 头哈希）。\n" +
      "    在这套运行时上修改 app.asar 会导致应用启动崩溃（Integrity check failed for asar archive），\n" +
      "    已拒绝执行任何补丁。--patch-asar 只用于未来某个不做完整性校验的运行时，不是绕过校验的手段。"
    );
    process.exit(1);
  }

  const doPatch = patchAsarRequested; // 到这里说明：要么没请求，要么请求了但校验证实安全

  // ─── 执行补丁 ────────────────────────────────────────────────
  const applied = [];
  const noop = [];
  const skipped = [];
  const failedList = [];
  const noopEvidence = {};
  const skippedReasons = {};

  if (!doPatch) {
    const reason = patchAsarRequested
      ? "完整性检测通过但仍未生效（不应该出现，若看到请检查逻辑）"
      : "保持官方文件原样：26.924 起 app.asar 受完整性校验保护（未设置 PATCH_ASAR=1 / --patch-asar）";
    for (const script of PATCHES) {
      const label = script.replace(".js", "");
      skipped.push(label);
      skippedReasons[label] = reason;
      console.log(`[skipped] ${label}：${reason}`);
    }
  } else {
    for (const script of PATCHES) {
      const label = script.replace(".js", "");
      const scriptPath = path.join(__dirname, script);
      console.log(`\n== ${label} ==`);

      // stdio 用 pipe 以便分类，随后原样转发，日志内容和以前一致
      const res = spawnSync("node", [scriptPath, ...passArgs], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);

      if (res.error || res.status !== 0) {
        console.error(`[x] ${label} failed (exit ${res.status ?? "n/a"}${res.error ? `, ${res.error.message}` : ""})`);
        failedList.push(label);
        continue;
      }

      const { verdict, evidence } = classifyPatchOutput(res.stdout);
      if (verdict === "applied") {
        applied.push(label);
        console.log(`[applied] ${label}：检测到 ${evidence.length >= 5 ? "≥5" : evidence.length} 条生效证据，例如 ${JSON.stringify(evidence[0])}`);
      } else {
        noop.push(label);
        noopEvidence[label] = tailLines(res.stdout, 3);
        console.log(`[noop] ${label}：正常退出但没有任何替换生效，当前版本上该补丁是空转`);
      }
    }
  }

  const asarModified = doPatch && applied.length > 0;

  // ─── 汇总 + 落盘（供 BUILD-INFO.json 使用）───────────────────
  console.log(`\n== Summary: applied ${applied.length} / noop ${noop.length} / skipped ${skipped.length} / failed ${failedList.length}（共 ${PATCHES.length}）==`);
  console.log(`   applied: ${applied.join(", ") || "(无)"}`);
  console.log(`   noop:    ${noop.join(", ") || "(无)"}`);
  console.log(`   skipped: ${skipped.join(", ") || "(无)"}`);
  if (failedList.length) console.log(`   failed:  ${failedList.join(", ")}`);
  console.log(`   asarModified: ${asarModified}`);

  // GitHub Actions 注解：让空转补丁在 CI 里可见，但不让 job 失败
  for (const label of noop) {
    console.log(`::warning title=补丁未生效::${label} 在当前版本没有匹配，功能可能已失效`);
    for (const l of noopEvidence[label] || []) console.log(`           最后输出: ${l}`);
  }

  const report = {
    applied,
    noop,
    skipped,
    skippedReasons,
    failed: failedList,
    cliMode: mode,
    useCometix,
    patchAsarRequested,
    asarModified,
    integrityCheck: integrityCheck
      ? {
          enforced: integrityCheck.enforced,
          checkedRoots: integrityCheck.checkedRoots,
          fuses: integrityCheck.fuses
            ? {
                found: integrityCheck.fuses.found,
                asarIntegrityEnabled: integrityCheck.fuses.asarIntegrityEnabled,
                onlyLoadFromAsar: integrityCheck.fuses.onlyLoadFromAsar,
                source: integrityCheck.fuses.source,
              }
            : null,
          embedded: integrityCheck.embedded
            ? { found: integrityCheck.embedded.found, source: integrityCheck.embedded.source }
            : null,
        }
      : null,
    patchedAt: new Date().toISOString(),
  };
  for (const plat of targets) {
    const dir = path.join(SRC_DIR, plat);
    if (!fs.existsSync(dir)) continue;
    try {
      fs.writeFileSync(path.join(dir, ".patch-report.json"), JSON.stringify(report, null, 2) + "\n");
    } catch (e) {
      console.log(`  [!] 写入 .patch-report.json 失败: ${e.message}`);
    }
  }

  if (failedList.length > 0) process.exit(1);
}

module.exports = { classifyPatchOutput, isSuccessLine };

if (require.main === module) main();
