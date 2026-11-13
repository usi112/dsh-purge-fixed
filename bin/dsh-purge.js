#!/usr/bin/env node

import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";

const args = process.argv.slice(2);

/** 7 分类的一行摘要。tally 缺失（老调用方传进来的 state）就不打，别打出一排 0 误导人。 */
function tallyLine(tally) {
  if (!tally) return "";
  return "  " + [
    `已落地 ${tally.applied}`,
    `待应用 ${tally.pending}`,
    `部分 ${tally.partial}`,
    `漂移 ${tally.drifted}`,
    `原文不对 ${tally.no_needle}`,
    `文件缺失 ${tally.no_file}`,
    `包缺失 ${tally.no_pkg}`,
    `不适用 ${tally.na}`,
  ].join("  ") + `  合计 ${tally.total}`;
}

function printStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push("  宿主 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.desktop_install) out.push("  桌面安装       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  插件根 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  插件根 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim 目录      ${state.shim_dir || "未定位 / not found"}`);
  out.push(`  备份 / backup  ${state.has_backup ? "有 / yes" : "无 / no"}`);
  out.push(`  注入文件       ${state.override_path}`);
  out.push(`  注入状态       ${state.override_status}`);
  out.push("");
  out.push(`  补丁 ${state.patches_applied}/${core.ALL_PATCHES.length} 已清洗, ${state.patches_pending} 待清洗`);
  if (state.patch_tally) out.push(tallyLine(state.patch_tally));
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

/** --check 明细的排序权重：能动手的排前面（漂移 / 待应用 / 部分），其余只是解释为什么不动。 */
const CHECK_ORDER = { drifted: 0, pending: 1, partial: 2, no_needle: 3, no_file: 4, no_pkg: 5, na: 6, applied: 7 };
/** 这三类重打一次有救，其余重打也变不了，别让人白点。 */
const CHECK_ACTIONABLE = new Set(["drifted", "pending", "partial"]);

/**
 * --check：只读自检。不 backup、不写宿主、连 shim 都不碰，只把「现在是什么状态」数清楚。
 * 面板上只说 ✗ 的条目，这里会说清楚是待应用、部分落地、产物漂移，还是包里根本没这个文件。
 */
function printCheckReport(state) {
  const out = [];
  out.push("dsh-purge 自检 / check（dry-run，只读）");
  out.push("  宿主 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  out.push("  插件根 / root  " + (state.ai_base || core.missingAiBaseMessage()));
  out.push(tallyLine(state.patch_tally));
  out.push("");
  const todo = (state.patch_rows || [])
    .filter((row) => row.category !== "applied" && row.category !== "na")
    .sort((a, b) => (CHECK_ORDER[a.category] ?? 9) - (CHECK_ORDER[b.category] ?? 9) || a.id - b.id);
  if (todo.length === 0) {
    out.push("  所有补丁都已落地 / nothing to do");
    return out.join("\n");
  }
  out.push(`  未落地 ${todo.length} 条（按 7 分类排，能动手的在前面）`);
  for (const row of todo) {
    const mark = CHECK_ACTIONABLE.has(row.category) ? "✗" : "·";
    out.push(`    ${mark} [#${String(row.id).padEnd(2)}] ${row.category.padEnd(9)} ${row.name}`);
    out.push(`         ${row.reason}`);
    for (const file of row.files || []) {
      if (file.kind === "applied") continue;
      out.push(`         ${file.kind.padEnd(9)} ${file.path || "(无路径)"}`);
    }
  }
  const actionable = todo.filter((row) => CHECK_ACTIONABLE.has(row.category)).length;
  out.push("");
  out.push(`  其中 ${actionable} 条重打一次有救 / ${actionable} worth a re-apply`);
  return out.join("\n");
}

/** --status --json / --check --json：机器可读。旧 key 全部保留，新增 patch_tally 与 rows。 */
function buildJsonReport(state, mode) {
  return {
    mode: mode === "--check" ? "check" : "status",
    read_only: mode === "--check",
    surface: state.surface,
    ai_base: state.ai_base,
    dsh_home: state.dsh_home,
    files: state.files,
    patch_status: state.patch_status,
    patch_tally: state.patch_tally,
    rows: state.patch_rows,
    patches_applied: state.patches_applied,
    patches_pending: state.patches_pending,
    patches_skipped: state.patches_skipped,
    patches_ready: state.patches_ready,
    patches_na: state.patches_na,
    patches_total: state.patches_total,
    display_total: state.display_total,
    has_backup: state.has_backup,
    shim_cmd: state.shim_cmd,
    shim_ps1: state.shim_ps1,
    shim_bin: state.shim_bin,
    patch_cache: state.patch_cache,
  };
}

async function main() {
  const mode = args.find((a) => ["--apply", "--revert", "--uninstall", "--status", "--check", "--edit", "--help"].includes(a));
  const jsonOut = args.includes("--json");

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-purge 用法:
  dsh-purge --status          显示状态
  dsh-purge --status --json   显示状态（机器可读，含 patch_tally 与 rows）
  dsh-purge --check           只读自检：数清 7 类状态 + 未落地明细，不改任何文件
  dsh-purge --check --json    自检的机器可读输出（read_only: true）
  dsh-purge --apply           应用全部清洗（提示词+代码+shim+override）
  dsh-purge --revert          回滚还原
  dsh-purge --uninstall       卸载插件（已应用则先还原）
  dsh-purge --edit            编辑注入文件 prompt-inject.md
  dsh-purge --help            帮助
说明: --check / --status 全程只读；--check 即使有未落地项也返回 0，方便脚本解析。`);
    return;
  }

  // --check 与 --status --json 都只读。--check 强制 fresh，别把上一轮进程里的检测当结论。
  if (mode === "--check" || (jsonOut && !mode)) {
    const state = await core.gatherState({ fresh: true });
    console.log(jsonOut
      ? JSON.stringify(buildJsonReport(state, "--check"), null, 2)
      : printCheckReport(state));
    if (!state.ai_base) process.exit(1);
    return;
  }

  const state = await core.gatherState();
  if (jsonOut && mode === "--status") {
    console.log(JSON.stringify(buildJsonReport(state, "--status"), null, 2));
    return;
  }
  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: 把 DSH_BASE 指到含 dsh-agent-instructions/lib 的 @deepseek-ai 目录");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] 提示词和规则集都是空的，必须先添加提示词");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  宿主 / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  多宿主 / multi-host: ${hosts.length} 份 @deepseek-ai 已清洗`);
    }
    console.log(inject.source === "rule"
      ? "  - 使用当前规则集，不改写提示词文件"
      : "  - 使用已有提示词文件");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} 注入 / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} 已注入 / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} 不存在 / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ 未定位 shim 目录，跳过注入");
    }
    console.log("");
    console.log("全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ 已还原 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 还原失败 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 没有补丁备份可还原 / no patch backup");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
    console.log("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  已检测到补丁，已还原回原版。");
    else console.log("  未检测到已应用补丁，仍会清除插件文件。");
    if (result.override?.removed) console.log(`  已删除 ${result.override.path}`);
    const quarantined = (result.landed?.entries || []).filter((e) => e.result === "quarantined");
    if (result.landed?.quarantine_created && quarantined.length > 0) {
      console.log(`  已隔离 ${quarantined.length} 项到 ${result.landed.quarantine_root}（未删除，见其中的 RESTORE.txt）`);
    }
    const cleaned = (result.landed?.entries || []).filter((e) => e.result === "deleted").length;
    if (cleaned > 0) console.log(`  已清理插件自带文件 ${cleaned} 项`);
    if (result.stripped?.length) console.log(`  已从 profile 移除: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  卸载中止：还原失败，插件文件未删除。");
      process.exit(1);
    }
    console.log("");
    console.log("卸载完成。请重启 dsh。");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 已创建默认注入文件：${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → 已打开 ${r.editor} 编辑注入文件：${r.path}`);
    }
    console.log("  编辑完成后重启 dsh 生效。");
  } else {
    console.log("默认不清洗，使用 --apply 应用清洗。");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
