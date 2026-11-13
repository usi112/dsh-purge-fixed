/**
 * 补丁检测的报告层：只负责「怎么分、怎么数」，不碰任何写盘行为。
 *
 * 为什么单独拆出来：
 * 1) 改动前 patchStatus / gatherState 各自维护一套计数器（applied/pending/skipped/missing），
 *    面板、CLI、状态条再各数一遍，同一个宿主能数出三种口径；
 * 2) 旧口径只能表达「落地 / 待办 / 跳过」，说不清「部分落地」「产物被弄脏」「包压根没装」，
 *    用户看到 ✗ 不知道是版本不对还是文件丢了。
 * 所以这里给每条补丁定一份 7 分类的行，再由调用方决定：
 * - 新字段（patch_tally / patch_rows）用 7 分类；
 * - 旧字段（patches_applied 等）仍走 legacyPatchStatusOfRow 还原成旧字符串，数值一个都不变。
 *
 * 判定本身不在这里做：文件读取与「打没打上」的判断都留在 core.js，
 * 这里复用 filePatchOutcome，保证分类与 apply / revert 看到的是同一套语义。
 */

import { filePatchOutcome } from "./core.js";

/** 七类判定。顺序即面板 / CLI / JSON 的展示顺序。 */
export const PATCH_ROW_CATEGORIES = Object.freeze([
  "applied",
  "pending",
  "partial",
  "drifted",
  "no_needle",
  "no_file",
  "no_pkg",
]);

/** 非 applied 时给面板 / CLI 的一句原因。写短句，面板宽度有限。 */
export const CATEGORY_REASONS = Object.freeze({
  applied: "已落地",
  pending: "锚点还在，待应用",
  partial: "多文件补丁只落地了一部分",
  drifted: "命中 forbid 标记：产物被别的改动弄脏，需重打",
  no_needle: "原文对不上（宿主版本不同或已被别的补丁改写）",
  no_file: "目标文件登记了但读不到（被删 / 正在替换）",
  no_pkg: "这套宿主没有该包，补丁无处落地",
  na: "当前宿主不需要该补丁",
});

function toLf(text) {
  return typeof text === "string" ? text.replace(/\r\n/g, "\n") : "";
}

/* ───────────────────────── 声明式字段（引擎只读，不认 id） ─────────────────────────
 *
 * 为什么要有这一节：改动前「这条补丁怎么判」散在 core.js 里按 id 认——
 * isIdentityLayoutPatch(4/25/26)、isApprovalSentencePatch(5/11/12)、patch.id === 42……
 * 等于每加一条补丁都要改引擎，且没人能从补丁表看出它凭什么算落地。
 * 现在语义一律写在补丁表上，core.js 只调用这里的读取器：
 *
 * - kind: "replace"（默认）锚点替换，替完锚点消失；
 *         "append" 追加/插入型：产物里锚点还在，marker 命中即算落地，
 *                  写后复核不要求锚点消失，且自带 skipIfMarked 语义；
 *         "marker" 没有锚点可替，待做与否只看 markers。
 * - markers / markersAny / forbid / softSettle / skipIfMarked / strictFiles / optional
 *   都是补丁自己声明的判定参数，引擎不改写、不推断。
 */

const PATCH_KINDS = new Set(["replace", "append", "marker"]);

/** 补丁类型。没写 kind 的老补丁按 replace 处理，行为与改动前完全一致。 */
export function patchKindOf(patch) {
  const kind = patch && patch.kind;
  return PATCH_KINDS.has(kind) ? kind : "replace";
}

/** append 型天然带 skipIfMarked：锚点还在，重放会一层层叠上去。 */
export function patchSkipsWhenMarked(patch) {
  if (!patch) return false;
  return patch.skipIfMarked === true || patchKindOf(patch) === "append";
}

/**
 * 布局软结算：官方副本布局不同 / 审批句已被上游改写时，「没有残留锚点」也算落地。
 * 只认补丁表上的 softSettle 字段；老补丁表没写这个字段时，用历史上按 id 特判的那一批兜底。
 * 那个 id 列表是**兼容包装**，只为了让外部传进来的旧补丁表行为不变，不要往里加新 id。
 */
const LEGACY_SOFT_SETTLE_IDS = Object.freeze([4, 25, 26, 5, 11, 12]);

export function patchIsSoftSettle(patch) {
  if (!patch) return false;
  if (typeof patch.softSettle === "boolean") return patch.softSettle;
  return LEGACY_SOFT_SETTLE_IDS.includes(patch.id);
}

/**
 * 「已落地」的终态判定：core 的旧状态字符串（applied / already / off）与报告行的
 * category 共用这一份，别在 core.js 里再写第二套。
 * 接受状态字符串或报告行 / 应用报告行（行上有 status 或 category）。
 */
const SETTLED_STATUSES = new Set(["applied", "already", "off"]);

export function isSettled(rowOrStatus) {
  const status = typeof rowOrStatus === "string"
    ? rowOrStatus
    : (rowOrStatus && (rowOrStatus.status || rowOrStatus.category)) || "";
  return SETTLED_STATUSES.has(status);
}

/**
 * forbid 是补丁自己写的负向断言（「产物 / 前提必须是另一个样子」）。
 * 命中说明这个文件已经被别的补丁或用户改动弄脏，先报漂移而不是「待应用」。
 * 只读 patch 数据，不再自己维护一份标记表。
 */
export function hasForbiddenMarker(text, patch) {
  const list = patch && Array.isArray(patch.forbid) ? patch.forbid : null;
  if (!list || list.length === 0) return false;
  const hay = toLf(text);
  return list.some((marker) => hay.includes(toLf(marker)));
}

/**
 * 单个目标文件的判定。
 * @param {{key?:string,path?:string,text?:string|null,error?:string|null,missing?:boolean,registered?:boolean}} file
 * @param {object} patch
 * @returns {{kind:string,outcome:string|null,reason:string}}
 */
export function classifyPatchFile(file, patch) {
  if (!file || file.missing) {
    // 键在 targetFiles 里没登记 = 这套宿主压根没装那个包；
    // 登记了但路径此刻解析不出来 = 文件级缺失。两者修法不同，面板上不能混成一句「缺失」。
    const kind = file && file.registered ? "no_file" : "no_pkg";
    return { kind, outcome: null, reason: kind };
  }
  // 读失败按「待应用」计：与改动前 patchStatus 里的 pending += 1 保持同一口径。
  if (file.error) return { kind: "pending", outcome: "pending", reason: "read_error" };
  const outcome = filePatchOutcome(file.text, patch, file.path || "");
  if (hasForbiddenMarker(file.text, patch)) {
    return { kind: "drifted", outcome, reason: "forbid" };
  }
  if (outcome === "applied") return { kind: "applied", outcome, reason: "markers" };
  if (outcome === "pending") return { kind: "pending", outcome, reason: "needle" };
  return { kind: "no_needle", outcome, reason: "no_needle" };
}

/**
 * 一条补丁归到哪一类。优先级是「先脏、后部分、再单态」：
 * drift 必须压在最前面——文件已经不该是这个样子，先重打才有意义，报「待应用」会误导。
 * no_pkg 不进判定：包没装 ≠ 没打完（旧实现里的 missing 同样只累加、不参与判定），
 * 否则「多包补丁 + 其中一个包这套宿主没装」会被误报成「只落地了一半」。
 */
function rowCategory(counts) {
  const considered = counts.applied + counts.pending + counts.drifted
    + counts.no_needle + counts.no_file;
  // 一个可判定文件都没有（整包缺失、键全落空）：按「包不在」报，别报成已落地。
  if (considered === 0) return "no_pkg";
  if (counts.drifted > 0) return "drifted";
  if (counts.applied > 0) return considered - counts.applied > 0 ? "partial" : "applied";
  if (counts.pending > 0) return "pending";
  if (counts.no_needle > 0) return "no_needle";
  return "no_file";
}

/**
 * 由「一条补丁 + 它所有目标文件」生成一行报告。
 * @param {{patch:object,applies?:boolean,files:Array<object>}} target
 */
export function buildPatchRow(target) {
  const patch = target.patch || {};
  const files = (target.files || []).map((file) => ({ ...file, ...classifyPatchFile(file, patch) }));
  const counts = { applied: 0, pending: 0, drifted: 0, no_needle: 0, no_file: 0, no_pkg: 0 };
  // 旧计数只看 filePatchOutcome 的三种结果。改组里原样保留一份，
  // 好让 patches_* / patch_status 这些旧字段逐项还原，不改任何数值。
  const legacy = { applied: 0, pending: 0, skipped: 0 };
  for (const file of files) {
    if (Object.prototype.hasOwnProperty.call(counts, file.kind)) counts[file.kind] += 1;
    if (file.outcome === "applied") legacy.applied += 1;
    else if (file.outcome === "pending") legacy.pending += 1;
    else if (file.outcome === "skipped") legacy.skipped += 1;
  }
  const applies = target.applies !== false;
  const category = applies ? rowCategory(counts) : "na";
  return {
    id: patch.id,
    name: patch.name || "",
    layer: patch.layer || "",
    layer_en: patch.layer_en || "",
    category,
    // status 先与 category 对齐；core 让 hooksDeny 注解锁之后会把它覆盖成最终状态。
    status: category,
    applies,
    counts,
    legacy,
    files,
    reason: CATEGORY_REASONS[category] || "",
  };
}

export function buildPatchRows(targets) {
  return (targets || []).map((target) => buildPatchRow(target));
}

/**
 * 7 分类计数。na 是第 8 个桶：它不属于 7 分类，但必须计入 total，
 * 否则 patch_tally.total 对不上 ALL_PATCHES.length，「加总等于总数」这条验收就不成立。
 */
export function tallyPatchRows(rows) {
  const out = {
    applied: 0, pending: 0, partial: 0, drifted: 0,
    no_needle: 0, no_file: 0, no_pkg: 0, na: 0, total: 0,
  };
  for (const row of rows || []) {
    out.total += 1;
    const key = row && row.category ? row.category : "na";
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] += 1;
    else out.na += 1;
  }
  return out;
}

/**
 * 把分类结果还原成改动前 patchStatus 的字符串状态。
 * 顺序必须与旧实现逐字一致：pending → applied → unmatched / skipped → optional?na:missing_file。
 * 旧实现里 missing 只累加、不参与判定，这里同样不使用它。
 */
export function legacyPatchStatusOfRow(row, patch) {
  const c = (row && row.legacy) || { applied: 0, pending: 0, skipped: 0 };
  if (c.pending > 0) return "pending";
  if (c.applied > 0) return "applied";
  if (c.skipped > 0) return patch && patch.strictFiles ? "unmatched" : "skipped";
  return patch && patch.optional ? "na" : "missing_file";
}

/** 面板 / JSON 只带路径与判定，不带文件正文（正文动辄几十万字符，塞进 JSON 会把通道撑爆）。 */
export function publicPatchRow(row) {
  return {
    id: row.id,
    name: row.name,
    layer: row.layer,
    layer_en: row.layer_en,
    category: row.category,
    status: row.status,
    applies: row.applies,
    counts: { ...row.counts },
    files: (row.files || []).map((file) => ({
      key: file.key,
      path: file.path,
      kind: file.kind,
      reason: file.reason,
    })),
    reason: row.reason,
  };
}
