#!/usr/bin/env node
/**
 * 补丁一键回归 / one-shot patch regression.
 *
 * 一条命令回答一个问题：「这批补丁现在还能安全地打上去、并且还能干干净净退回来吗？」
 *
 *   ① 记整棵宿主树 sha256（基线）
 *   ② apply
 *   ③ 记录这次改了哪些文件、计数、有没有整批回滚
 *   ④ revert（走 manifest 快照还原，与面板/CLI 的 revert 同一套 backup 层）
 *   ⑤ 与 ① 逐文件比对：必须 0 差异
 *   ⑥ 再 apply 一次，与 ③ 比对：必须 0 差异（幂等）
 *   ⑦ PASS / FAIL + 失败文件清单
 *
 * 退出码：0 通过 · 1 失败 · 2 拒绝执行或用法错误。
 *
 * 为什么自己写哈希而不是信 apply 的返回值：
 * apply 的 report 只说「我以为我写了什么」，这里要的是「盘上到底变成了什么」。
 * 两边都对上才算过，任何一边撒谎都能被 ⑤ / ⑥ 抓住。
 *
 * 为什么只接受 /tmp 之类的副本：
 * 脚本会真的写盘。真引擎 /opt/dsh 一次都不许写，所以路径里出现 /opt/ 直接退出 2，
 * 连 --help 之外的任何阶段都不进。这条防呆不看参数顺序、不看大小写、不信任相对路径。
 *
 * 补丁表以后改了，这个脚本会怎么提醒你（不需要改脚本）：
 *   · 补丁总数/指纹变了 → 输出里的 patches.fingerprint 与 patches.total 跟着变，和上一次 PASS 的记录一眼就能对上号；
 *   · 新补丁写坏（写后复核失败 / 整批回滚）→ ② 阶段就出现 verifyFailures / rolledBack，直接 FAIL；
 *   · 新补丁写了没被快照覆盖的文件 → ④ 还原后 ⑤ 有残留，FAIL 并列出残留文件；
 *   · 新补丁不幂等（第二次 apply 还会再改）→ ⑥ 差异，FAIL 并列出文件；
 *   · 宿主升级后补丁锚点不在了 → ③ 的变化数会掉到 0，脚本按「空转」判 FAIL，提示换一份未打补丁的副本。
 *
 * 零外部依赖：只用 node 内置模块 + 仓库自己的 lib/（不需要 npm install）。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** 失败清单一次最多列这么多条，其余只报总数（别把终端刷掉）。 */
const MAX_LIST = 20;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

// ───────────────────────────── 参数 ─────────────────────────────

function usage() {
  return `补丁一键回归 / patch regression

用法 / usage:
  node scripts/patch-regression.mjs --host <@deepseek-ai 目录> [--home <DSH_HOME>] [--json]

参数 / options:
  --host <dir>   必填。演练用的 @deepseek-ai 宿主副本，例如
                 /tmp/host-copy/node_modules/@deepseek-ai
  --home <dir>   DSH_HOME（备份快照写在这里）。默认 <host>/../../patch-regress-home
  --json         stdout 只输出一份 JSON，给 CI / 脚本读
  --keep-applied 结束时不再还原（默认会把宿主退回基线，方便下一轮重跑）
  --label <name> 输出里带一个标签，便于对照多次运行的记录
  --help         这份帮助

退出码 / exit codes:
  0 通过 · 1 失败 · 2 拒绝执行或用法错误

硬约束：路径里出现 /opt/ 直接退出 2。真引擎 /opt/dsh 一次都不许写。`;
}

function parseArgs(argv) {
  const out = { host: "", home: "", json: false, keepApplied: false, label: "", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const take = () => {
      const v = argv[i + 1];
      if (v == null || String(v).startsWith("--")) return "";
      i += 1;
      return String(v);
    };
    if (a === "--host") out.host = take();
    else if (a === "--home") out.home = take();
    else if (a === "--label") out.label = take();
    else if (a === "--json") out.json = true;
    else if (a === "--keep-applied") out.keepApplied = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) return { ...out, bad: a };
  }
  return out;
}

/** 只要路径里出现 /opt/ 就拒绝：真引擎就在那儿，这个脚本会真写盘。 */
function looksLikeRealEngine(p) {
  const norm = String(p || "").replace(/\\/g, "/").toLowerCase();
  if (!norm) return false;
  if (norm === "/opt" || norm.startsWith("/opt/")) return true;
  return /(^|\/)opt\/(dsh|deepseek|harness)(\/|$)/.test(norm);
}

/** 能拿到的最"真"路径：符号链接要跟到底，别让 /tmp/x → /opt/dsh 蒙过去。 */
function realish(p) {
  const abs = path.resolve(String(p || ""));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function refuse(message) {
  console.error(`[patch-regression] 拒绝执行 / refused: ${message}`);
  process.exit(2);
}

// ───────────────────────────── 工具 ─────────────────────────────

function sha256Of(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

function fmtMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 失败清单：前 MAX_LIST 条 + 总数。 */
function capList(list) {
  const arr = Array.isArray(list) ? list : [];
  return {
    shown: arr.slice(0, MAX_LIST),
    total: arr.length,
    truncated: arr.length > MAX_LIST,
  };
}

/**
 * 整棵树的指纹：相对路径 → sha256 + 字节数。
 * 只走普通文件与目录；符号链接按链接目标内容读（readFile 会跟），坏的直接记 <unreadable>。
 */
async function snapshotTree(root) {
  const map = new Map();
  let bytes = 0;
  const walk = async (dir) => {
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      map.set(`${path.relative(root, dir) || "."}/<unreadable-dir>`, { sha256: `error:${e.code || e.message}`, bytes: 0 });
      return;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of ents) {
      const fp = path.join(dir, ent.name);
      let st;
      try {
        st = await fsp.lstat(fp);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(fp);
        continue;
      }
      if (st.isSymbolicLink()) {
        // 链出去的目录不跟（会和宿主外的树纠缠）；链出去的文件照内容算，改没改一目了然。
        let target = "";
        try {
          target = await fsp.readlink(fp);
        } catch {
          target = "";
        }
        let buf = null;
        try {
          buf = await fsp.readFile(fp);
        } catch {
          buf = null;
        }
        const rel = path.relative(root, fp).split(path.sep).join("/");
        map.set(rel, buf
          ? { sha256: sha256Of(buf), bytes: buf.length, link: target }
          : { sha256: `symlink:${target}`, bytes: 0, link: target });
        continue;
      }
      if (!st.isFile()) continue;
      const rel = path.relative(root, fp).split(path.sep).join("/");
      let buf = null;
      try {
        buf = await fsp.readFile(fp);
      } catch (e) {
        map.set(rel, { sha256: `unreadable:${e.code || e.message}`, bytes: st.size });
        continue;
      }
      bytes += buf.length;
      map.set(rel, { sha256: sha256Of(buf), bytes: buf.length });
    }
  };
  await walk(root);
  return { map, files: map.size, bytes, at: nowIso() };
}

/** 两份快照的差异：改内容 / 新增 / 删除，各自成清单。 */
function diffSnapshots(before, after) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [rel, info] of after.map) {
    const prev = before.map.get(rel);
    if (!prev) {
      added.push({ path: rel, bytes: info.bytes });
      continue;
    }
    if (prev.sha256 !== info.sha256) {
      changed.push({ path: rel, bytes_before: prev.bytes, bytes_after: info.bytes });
    }
  }
  for (const [rel, info] of before.map) {
    if (!after.map.has(rel)) removed.push({ path: rel, bytes: info.bytes });
  }
  const total = changed.length + added.length + removed.length;
  return {
    total,
    changed: capList(changed),
    added: capList(added),
    removed: capList(removed),
    changed_total: changed.length,
    added_total: added.length,
    removed_total: removed.length,
  };
}

/** apply 报告的规整版：只留能判断的东西，别把整张 rows 复制进输出。 */
function summarizeApply(report) {
  const rows = Array.isArray(report) ? report : [];
  const by = {};
  for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
  const failures = rows
    .filter((r) => !["applied", "already", "skipped", "na", "missing_file", "pattern_not_found"].includes(r.status))
    .map((r) => ({ patch_id: r.patch_id, name: r.name, status: r.status }));
  return {
    rows: rows.length,
    counts: by,
    applied: rows.filter((r) => r.status === "applied").length,
    already: rows.filter((r) => r.status === "already").length,
    skipped: rows.filter((r) => r.status === "skipped" || r.status === "na" || r.status === "missing_file").length,
    applied_ids: rows.filter((r) => r.status === "applied").map((r) => r.patch_id).sort((a, b) => a - b),
    rolled_back: report?.rolledBack === true,
    rollback_missed: (report?.rollbackMissed || []).map((m) => m.path || String(m)),
    backup: report?.backup ? { dir: path.basename(String(report.backup.dir)), files: report.backup.files } : null,
    backup_failed: report?.backupFailed === true,
    write_errors: (report?.writeErrors || []).map((e) => ({ path: e.path, reason: e.reason })),
    verify_failures: (report?.verifyFailures || []).map((e) => ({ path: e.path, reason: e.reason })),
    unexpected_rows: capList(failures),
  };
}

/** 补丁表指纹：id+名字的哈希。表一变，这个值就变——不用改脚本也能看出「跑的是哪一版规则」。 */
function patchFingerprint(patches) {
  const text = patches.map((p) => `${p.id}\u0000${p.name}`).join("\u0001");
  return sha256Of(Buffer.from(text, "utf8")).slice(0, 16);
}

// ───────────────────────────── 主流程 ─────────────────────────────

function log(quiet, line = "") {
  if (!quiet) console.log(line);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.bad) {
    console.error(`[patch-regression] 不认识的参数 / unknown option: ${args.bad}`);
    console.error(usage());
    process.exit(2);
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.host) {
    console.error("[patch-regression] 缺 --host（演练用的 @deepseek-ai 宿主副本）");
    console.error(usage());
    return 2;
  }

  // ── 防呆：先把「不许碰」的地方挡在外面，再谈文件系统 ──
  const hostPath = path.resolve(args.host);
  const hostReal = realish(hostPath);
  const homePath = args.home
    ? path.resolve(args.home)
    : path.join(path.dirname(path.dirname(hostPath)), "patch-regress-home");
  const homeReal = realish(homePath);
  for (const [label, p] of [
    ["--host", hostPath], ["--host(real)", hostReal],
    ["--home", homePath], ["--home(real)", homeReal],
  ]) {
    if (looksLikeRealEngine(p)) {
      refuse(`${label} 指向真引擎（${p}）：回归会真写盘，只接受 /opt 之外的副本。\n` +
        "  先复制一份再跑：cp -a /opt/dsh/node_modules/@deepseek-ai /tmp/host-copy/node_modules/@deepseek-ai");
    }
  }
  if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isDirectory()) {
    console.error(`[patch-regression] --host 不是目录：${hostPath}`);
    return 2;
  }
  const pkgs = fs.readdirSync(hostPath, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (pkgs.length === 0) {
    console.error(`[patch-regression] --host 里没有包目录，不像 @deepseek-ai 宿主：${hostPath}`);
    return 2;
  }
  // home 落在宿主里会把备份也算进基线，判定就虚了：直接拒绝，让人换个位置。
  const relHome = path.relative(hostPath, homePath);
  if (relHome === "" || (!relHome.startsWith("..") && !path.isAbsolute(relHome))) {
    console.error(`[patch-regression] --home 不能放在 --host 里（会把备份算进基线）：${homePath}`);
    return 2;
  }

  // core.js 的 findDshHome() 认 DSH_HOME；备份快照要落在副本里，绝不写用户的 ~/.dsh。
  process.env.DSH_HOME = homePath;
  await fsp.mkdir(homePath, { recursive: true });

  const quiet = args.json;
  const mod = await import(path.join(REPO_ROOT, "lib", "core.js"));
  const backupMod = await import(path.join(REPO_ROOT, "lib", "patch-backup.js"));
  const { applyPatches, ALL_PATCHES } = mod;

  const startedAt = Date.now();
  const phase = (name, ms) => ({ name, ms: Math.round(ms) });
  const phases = [];
  const warnings = [];
  const failures = { apply_errors: [], revert_residual: [], idempotency: [], revert_errors: [], misc: [] };
  const result = {
    ok: false,
    mode: "patch-regression",
    label: args.label || "",
    host: hostPath,
    home: homePath,
    started_at: nowIso(),
    patches: { total: ALL_PATCHES.length, fingerprint: patchFingerprint(ALL_PATCHES) },
    phases: [],
    apply1: null,
    changes1: null,
    revert: null,
    revert_diff: null,
    apply2: null,
    idempotent_diff: null,
    final_state: null,
    warnings,
    failures,
    elapsed_ms: 0,
  };

  // 仓库自己的 cordis.patch.yml 不该被一次回归改掉：记一下，变了就提醒（apply 内部会顺手修一遍 YAML）。
  const repoYaml = path.join(REPO_ROOT, "cordis.patch.yml");
  const repoYamlBefore = await fsp.readFile(repoYaml).then(sha256Of).catch(() => "");

  log(quiet, "补丁一键回归 / patch regression");
  log(quiet, `  宿主 / host   ${hostPath}`);
  log(quiet, `  DSH_HOME      ${homePath}`);
  log(quiet, `  补丁 / patches ${ALL_PATCHES.length} 条  fingerprint ${result.patches.fingerprint}`);
  log(quiet, "");

  // ①② 基线 + 第一次 apply
  let t = Date.now();
  const baseline = await snapshotTree(hostPath);
  phases.push(phase("baseline", Date.now() - t));
  log(quiet, `  ① 基线 / baseline  ${baseline.files} 文件 ${fmtBytes(baseline.bytes)}`);

  t = Date.now();
  let apply1;
  try {
    apply1 = await applyPatches(hostPath, ALL_PATCHES, { preserveClientBundles: false, forApply: true });
  } catch (e) {
    phases.push(phase("apply1", Date.now() - t));
    result.phases = phases;
    failures.apply_errors.push({ path: hostPath, reason: `apply_threw:${e && e.message ? e.message : e}` });
    result.elapsed_ms = Date.now() - startedAt;
    return finish(result, args);
  }
  phases.push(phase("apply1", Date.now() - t));
  result.apply1 = summarizeApply(apply1);
  const a1 = result.apply1;
  log(quiet, `  ② apply  applied ${a1.applied}  already ${a1.already}  skipped/na/missing ${a1.skipped}` +
    `  rolledBack=${a1.rolled_back}` + (a1.backup ? `  备份 ${a1.backup.dir}（${a1.backup.files} 文件）` : ""));
  for (const e of a1.write_errors) failures.apply_errors.push({ path: e.path, reason: `write:${e.reason}` });
  for (const e of a1.verify_failures) failures.apply_errors.push({ path: e.path, reason: `verify:${e.reason}` });
  for (const m of a1.rollback_missed) failures.apply_errors.push({ path: m, reason: "rollback_missed" });
  if (a1.backup_failed) failures.apply_errors.push({ path: hostPath, reason: "backup_failed（没快照就没写盘）" });
  if (a1.rolled_back) failures.apply_errors.push({ path: hostPath, reason: "rolled_back（写后复核失败，整批已回滚）" });

  // ③ 变化
  t = Date.now();
  const after1 = await snapshotTree(hostPath);
  const changes1 = diffSnapshots(baseline, after1);
  phases.push(phase("diff-after-apply", Date.now() - t));
  result.changes1 = changes1;
  log(quiet, `  ③ 变化 / changed  ${changes1.total} 文件（改 ${changes1.changed_total} / 增 ${changes1.added_total} / 删 ${changes1.removed_total}）`);

  // ④ revert：走 backup 层的 manifest 快照还原，与面板/CLI 的 revert 同一条路径。
  //    不用 revertAllHosts()：它会自己枚举宿主，跑在别人机器上时可能把真引擎也列进来。
  t = Date.now();
  let restore = null;
  const latest = await backupMod.latestBackupForRoot(hostPath, { home: homePath }).catch(() => null);
  if (latest?.ok) {
    restore = await backupMod.restoreBackup(latest.dir, { root: hostPath });
  } else if (changes1.total > 0) {
    failures.revert_errors.push({ path: hostPath, reason: "找不到本次 apply 的快照，无法还原" });
  } else {
    warnings.push("没有可用的快照：本次 apply 一个字节都没写，跳过还原");
  }
  phases.push(phase("revert", Date.now() - t));
  result.revert = restore
    ? {
      dir: path.basename(latest.dir),
      ok: restore.ok === true,
      restored: restore.restored.length,
      skipped: restore.skipped.length,
      missed: capList(restore.missed.map((m) => ({ path: m.path, reason: m.reason }))),
      reason: restore.reason || "",
    }
    : null;
  if (restore) {
    log(quiet, `  ④ revert  restored ${restore.restored.length}  skipped ${restore.skipped.length}  missed ${restore.missed.length}`);
    for (const m of restore.missed) failures.revert_errors.push({ path: m.path, reason: m.reason });
    if (!restore.ok) failures.revert_errors.push({ path: hostPath, reason: `revert_partial:${restore.reason}` });
  }

  // ⑤ 与基线逐文件比对：必须 0 差异
  t = Date.now();
  const afterRevert = await snapshotTree(hostPath);
  const revertDiff = diffSnapshots(baseline, afterRevert);
  phases.push(phase("diff-after-revert", Date.now() - t));
  result.revert_diff = revertDiff;
  log(quiet, `  ⑤ 与基线比对 / vs baseline  ${revertDiff.total} 差异 ${revertDiff.total === 0 ? "✓" : "✗"}`);
  const collectDiff = (diff, bucket) => {
    for (const c of diff.changed.shown) bucket.push({ path: c.path, reason: "内容与基线不同" });
    for (const a of diff.added.shown) bucket.push({ path: a.path, reason: "还原后多出来的文件" });
    for (const r of diff.removed.shown) bucket.push({ path: r.path, reason: "还原后少掉的文件" });
    for (const extra of [
      [diff.changed_total, diff.changed.shown.length, "内容与基线不同"],
      [diff.added_total, diff.added.shown.length, "还原后多出来的文件"],
      [diff.removed_total, diff.removed.shown.length, "还原后少掉的文件"],
    ]) {
      if (extra[0] > extra[1]) bucket.push({ path: `(另有 ${extra[0] - extra[1]} 个文件)`, reason: extra[2] });
    }
  };
  collectDiff(revertDiff, failures.revert_residual);

  // ⑥ 再 apply 一次，与第一次比对（幂等）
  t = Date.now();
  let apply2;
  try {
    apply2 = await applyPatches(hostPath, ALL_PATCHES, { preserveClientBundles: false, forApply: true });
  } catch (e) {
    phases.push(phase("apply2", Date.now() - t));
    failures.misc.push({ path: hostPath, reason: `第二次 apply 抛错:${e && e.message ? e.message : e}` });
    apply2 = null;
  }
  if (apply2) {
    const after2 = await snapshotTree(hostPath);
    phases.push(phase("apply2", Date.now() - t));
    result.apply2 = summarizeApply(apply2);
    const a2 = result.apply2;
    log(quiet, `  ⑥ 再 apply  applied ${a2.applied}  already ${a2.already}  rolledBack=${a2.rolled_back}`);
    const idemDiff = diffSnapshots(after1, after2);
    result.idempotent_diff = idemDiff;
    log(quiet, `     与第一次比对 / vs apply#1  ${idemDiff.total} 差异 ${idemDiff.total === 0 ? "✓" : "✗"}`);
    collectDiff(idemDiff, failures.idempotency);
    // 补丁级也要一致：第二次该写入的补丁集合与第一次相同，否则说明中间有状态被吃掉了。
    const ids1 = a1.applied_ids.join(",");
    const ids2 = a2.applied_ids.join(",");
    if (ids1 !== ids2) {
      const only1 = a1.applied_ids.filter((id) => !a2.applied_ids.includes(id));
      const only2 = a2.applied_ids.filter((id) => !a1.applied_ids.includes(id));
      failures.idempotency.push({
        path: `(补丁集合不同)`,
        reason: `只有第一次写: [${only1.join(", ")}] · 只有第二次写: [${only2.join(", ")}]`,
      });
    }
    if (a2.rolled_back) failures.apply_errors.push({ path: hostPath, reason: "第二次 apply 整批回滚" });
    for (const e of a2.verify_failures) failures.apply_errors.push({ path: e.path, reason: `verify#2:${e.reason}` });

    // ⑦ 收尾：默认把宿主退回基线，下一轮重跑才有意义（否则「什么都没改」会被当成通过）。
    if (!args.keepApplied) {
      const latest2 = await backupMod.latestBackupForRoot(hostPath, { home: homePath }).catch(() => null);
      if (latest2?.ok) {
        const r2 = await backupMod.restoreBackup(latest2.dir, { root: hostPath });
        if (!r2.ok) failures.revert_errors.push({ path: hostPath, reason: `收尾还原不完整:${r2.reason}` });
      }
    }
    const finalSnap = await snapshotTree(hostPath);
    const finalDiff = diffSnapshots(baseline, finalSnap);
    result.final_state = args.keepApplied
      ? { kept_applied: true, files: finalSnap.files }
      : { kept_applied: false, diff_vs_baseline: finalDiff.total };
    log(quiet, args.keepApplied
      ? "  ⑦ 按 --keep-applied 保留已应用状态"
      : `  ⑦ 已退回基线 / restored baseline（${finalDiff.total} 差异）`);
  }

  // 空转检查放最后判定：补丁在宿主上一个字节都没写，等于什么都没测。
  if (changes1.total === 0) {
    failures.misc.push({
      path: hostPath,
      reason: "这次 apply 没改动任何文件（宿主可能已经打过补丁）：换成未打补丁的副本再跑，否则 PASS 是假的",
    });
  }

  const repoYamlAfter = await fsp.readFile(repoYaml).then(sha256Of).catch(() => "");
  if (repoYamlBefore && repoYamlAfter && repoYamlBefore !== repoYamlAfter) {
    warnings.push("仓库自带的 cordis.patch.yml 在这次回归里被改写了（apply 的 YAML 清洗），跑完记得看一眼 git status");
  }

  result.phases = phases;
  result.elapsed_ms = Date.now() - startedAt;
  return finish(result, args);
}

/** 汇总判定 + 输出。任何一类失败非空就是 FAIL。 */
function finish(result, args) {
  const buckets = Object.entries(result.failures).filter(([, list]) => (list || []).length > 0);
  result.ok = buckets.length === 0;

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...result, exit_code: result.ok ? 0 : 1 }, null, 2)}\n`);
  } else {
    console.log("");
    if (result.ok) {
      console.log(`PASS — 一次回归 ${fmtMs(result.elapsed_ms)}  ·  补丁 ${result.patches.total} 条 · fingerprint ${result.patches.fingerprint}`);
    } else {
      console.log(`FAIL — 一次回归 ${fmtMs(result.elapsed_ms)}  ·  补丁 ${result.patches.total} 条 · fingerprint ${result.patches.fingerprint}`);
      const labels = {
        apply_errors: "apply 阶段（写盘/复核/回滚）",
        revert_errors: "revert 阶段（还原本身）",
        revert_residual: "revert 之后与基线不一致",
        idempotency: "第二次 apply 与第一次不一致",
        misc: "其他",
      };
      for (const [key, list] of buckets) {
        console.log("");
        console.log(`  ✗ ${labels[key] || key}：${list.length} 条`);
        for (const item of list.slice(0, MAX_LIST)) {
          console.log(`      ${item.path}`);
          if (item.reason) console.log(`        ${item.reason}`);
        }
        if (list.length > MAX_LIST) console.log(`      …另有 ${list.length - MAX_LIST} 条`);
      }
    }
    for (const w of result.warnings || []) console.log(`  ⚠ ${w}`);
    console.log("");
    console.log("  阶段耗时 / phases: " + (result.phases || []).map((p) => `${p.name}=${fmtMs(p.ms)}`).join("  "));
  }
  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(typeof code === "number" ? code : 0))
  .catch((e) => {
    console.error("[patch-regression] 未捕获错误:", e);
    process.exit(1);
  });
