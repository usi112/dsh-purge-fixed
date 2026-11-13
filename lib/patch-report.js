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

/**
 * 分类的兜底短句。只在 explainPatchRow 拿不到行数据时（例如外部只传了 category）使用：
 * 真正的面板 / CLI 文案由 explainPatchRow 按真实数据拼，见下文「每条补丁的原因」一节。
 */
export const CATEGORY_REASONS = Object.freeze({
  applied: "已经打过了",
  pending: "原文还在，等应用",
  partial: "多文件补丁只改了一部分",
  drifted: "内容被别处改过（碰到禁用标记），需要重打",
  no_needle: "找不到原文（宿主换了写法，或被别的补丁改过）",
  no_file: "目标文件读不到（被删了，或正在被替换）",
  no_pkg: "这台机器没装这个包，补丁用不上",
  na: "这台机器不需要这条补丁",
});

/* ───────────────────────── 按层分组（只管展示顺序，不改任何判定） ─────────────────────────
 *
 * 为什么还要再叠一层：补丁表上的 layer 只有「提示词 / 代码 / 工具 / 0.1.5、0.2.0 兼容」这几个值，
 * 按它分组等于按实现手段分类。用户想知道的是「身份句改掉没」「审批还拦不拦」「沙箱还挡不挡写」，
 * 所以这里按语义分 6 层：身份 / 审批 / 沙箱 / 工具 / 界面 / 其他。
 *
 * 依据必须是数据：只看补丁自己声明的 name 和它要改的包（row.files[].key），不按 id 列表硬编码
 * （硬编码上次加补丁就得改这里）。先看名字，名字认不出来再看目标包，都认不出来落进「其他」——
 * 认不出来就说认不出来，不猜。
 *
 * 这一层只影响展示：计数、判定、apply/revert 全都不读它。
 */
export const PATCH_LAYERS = Object.freeze([
  { key: "identity", zh: "身份", en: "Identity" },
  { key: "approval", zh: "审批", en: "Approval" },
  { key: "sandbox", zh: "沙箱", en: "Sandbox" },
  { key: "tools", zh: "工具", en: "Tools" },
  { key: "ui", zh: "界面", en: "UI" },
  { key: "other", zh: "其他", en: "Other" },
]);

const LAYER_NAME_RULES = Object.freeze([
  ["approval", /approval|permission|auto_review|tool_ask/],
  ["sandbox", /sandbox|fs_fence|fs_observation|escalation/],
  ["identity", /identity|persona|scope_intro|workspace_context/],
  ["tools", /tool_|hooks_|subagent|shell_|bash|toolset|read_caps|run_code|fetch/],
  ["ui", /web_|desktop|rewind|session_log|settings|client|deliverable|plan_mode|overlay/],
]);

const LAYER_KEY_RULES = Object.freeze([
  ["approval", /approval|permission-?presets|auto-?review/],
  ["sandbox", /sandbox|^fs-|escalation/],
  ["tools", /tool-|hooks-/],
  ["ui", /web-app|conversation-client|desktop-shell|^settings$/],
]);

/** 这条补丁属于哪一层（键）。只读 name 与目标包键。 */
export function patchLayerKey(row) {
  const name = String((row && row.name) || "").toLowerCase();
  for (const [key, rule] of LAYER_NAME_RULES) if (rule.test(name)) return key;
  const keys = (Array.isArray(row && row.files) ? row.files : [])
    .map((file) => String((file && file.key) || "").toLowerCase());
  for (const [key, rule] of LAYER_KEY_RULES) if (keys.some((k) => k && rule.test(k))) return key;
  return "other";
}

export function patchLayerOf(row) {
  const key = patchLayerKey(row);
  return PATCH_LAYERS.find((layer) => layer.key === key) || PATCH_LAYERS[PATCH_LAYERS.length - 1];
}

/**
 * 按层折行：每层带上「已生效 / 总数」与层内所有行（顺序沿用入参顺序）。
 * 守恒：每条行恰好进一个桶，所以 sum(total) === rows.length，面板和 CLI 都能拿它核对。
 */
export function groupRowsByLayer(rows) {
  const buckets = new Map(PATCH_LAYERS.map((layer) => [layer.key, { ...layer, applied: 0, total: 0, rows: [] }]));
  for (const row of Array.isArray(rows) ? rows : []) {
    const layer = patchLayerOf(row);
    const bucket = buckets.get(LAYER_KEY_SAFE(layer.key));
    bucket.rows.push(row);
    bucket.total += 1;
    // 只认「磁盘上真的已经是新写法」：na / 待应用 / 漂移都不算生效。
    if (row && row.category === "applied") bucket.applied += 1;
  }
  return PATCH_LAYERS.map((layer) => buckets.get(layer.key));
}

function LAYER_KEY_SAFE(key) {
  return PATCH_LAYERS.some((layer) => layer.key === key) ? key : "other";
}

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

/* ───────────────────── 每条补丁的原因（一句原因 + 一句怎么处理） ─────────────────────
 *
 * 为什么要有这一节：面板和 CLI 以前只写状态码（pending / drifted / no_needle），
 * 用户看到 ✗ 时，分不清是「点一下就好」还是「版本对不上、不用管」，每次都得问人。
 *
 * 规矩：能写进文案的每一样东西都必须来自行上的真实数据 ——
 *   · row.counts（各分类各几个文件）
 *   · row.files[].kind / .path / .key（到底哪几个文件、缺的是哪个包）
 *   · 补丁自己声明的 strictFiles / softSettle / kind
 *   · row.status 与 row.category 不一致时（钩子旁路关掉会把状态改成 pending/skipped）
 * 推不出来的（例如宿主版本号）不写，绝不编一个数字填进去。
 *
 * 每条原因后面再给一句「怎么处理」：可以再打一次 / 不用管 / 需要你自己确认。
 * 这三个词是给用户做决定用的，不是分类码，所以只在这三种里选。
 */
const ADVICE = Object.freeze({
  apply: { zh: "可以再打一次", en: "Can apply" },
  ignore: { zh: "不用管", en: "Leave it" },
  manual: { zh: "需要你自己确认", en: "Needs a look" },
});

/** 建议对应的语气：能动手的用 warn 提醒，需要人看的用 bad，可忽略的用 muted。 */
export const ADVICE_TONES = Object.freeze({ apply: "warn", ignore: "muted", manual: "bad" });

/** 只在行上没有文件明细时用的兜底英文短句（老快照 / 外部只传了 category）。 */
const CATEGORY_REASONS_EN = Object.freeze({
  applied: "Already applied",
  pending: "The anchor is still there; apply to land it",
  partial: "A multi-file patch landed only partly",
  drifted: "This patch's forbid marker is present: the file was altered elsewhere",
  no_needle: "The anchor text is not in the host (different version or already rewritten)",
  no_file: "A registered target file is unreadable",
  no_pkg: "This host does not ship the target package",
});

/** 分类对应的语气（面板每条明细用）。 */
export const CATEGORY_TONES = Object.freeze({
  applied: "good",
  pending: "warn",
  partial: "warn",
  drifted: "bad",
  no_needle: "muted",
  no_file: "warn",
  no_pkg: "muted",
  na: "muted",
});

function isEnLocale(locale) {
  return String(locale || "").toLowerCase().startsWith("en");
}

/**
 * 文件的一句话称呼：取路径最后三段（包名 / lib / 文件名），没有路径就退回包键。
 * 面板一行放不下绝对路径，但只写文件名又不知道是哪个包，所以取这三段。
 */
function fileLabel(file) {
  const fp = String((file && file.path) || "").trim();
  if (fp) {
    const parts = fp.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.slice(-3).join("/");
  }
  const key = String((file && file.key) || "").trim();
  return key || "";
}

/** 把一组文件写成「a、b 等 N 个」；去重、限量，保证一句话读得完。 */
function labelsOf(files, limit, en) {
  const names = [];
  for (const file of files) {
    const label = fileLabel(file);
    if (label && !names.includes(label)) names.push(label);
  }
  if (names.length === 0) return en ? "the target files" : "登记的文件";
  const shown = names.slice(0, limit);
  const rest = names.length - shown.length;
  if (rest > 0) {
    return `${shown.join(en ? ", " : "、")}${en ? ` +${rest}` : ` 等 ${names.length} 个`}`;
  }
  return shown.join(en ? ", " : "、");
}

/**
 * 一条补丁的「为什么没生效」+「下一步」。
 * @param {object} row 报告行（至少要有 category / counts / files；buildPatchRow 出来的行最全）
 * @param {string} locale "zh" | "en"
 * @returns {{category:string,reason:string,advice:string,advice_code:string,advice_tone:string}}
 */
export function explainPatchRow(row, locale = "zh") {
  const en = isEnLocale(locale);
  const counts = (row && row.counts) || {};
  const files = Array.isArray(row && row.files) ? row.files : [];
  const num = (key) => Number(counts[key]) || 0;
  const applied = num("applied");
  const pending = num("pending");
  const drifted = num("drifted");
  const noNeedle = num("no_needle");
  const noFile = num("no_file");
  const noPkg = num("no_pkg");
  const total = files.length;
  const category = String((row && row.category) || "na");
  const status = String((row && row.status) || category);
  const strict = row && row.strict === true;
  const soft = row && row.soft === true;
  const kind = String((row && row.kind) || "");
  const kindFiles = (name) => files.filter((file) => file && file.kind === name);
  const softNote = soft
    ? (en ? " (soft match: a different official layout also counts)" : "（软补丁：官方布局不同也算过）")
    : "";

  const pick = (code, zh, english) => ({
    category,
    reason: en ? english : zh,
    advice: ADVICE[code][en ? "en" : "zh"],
    advice_code: code,
    advice_tone: ADVICE_TONES[code],
  });

  // 行上没有文件明细（老快照、或外部只给了 category）：退回分类短句。
  // 这种时候绝不能写「0 个文件」，那会变成一句假话。
  if (total === 0) {
    const codeByCategory = {
      applied: "ignore", pending: "apply", partial: "apply", drifted: "manual",
      no_needle: "ignore", no_file: "manual", no_pkg: "ignore",
    };
    const code = codeByCategory[category] || "ignore";
    return pick(code, CATEGORY_REASONS[category] || "未生效", CATEGORY_REASONS_EN[category] || "Not applied");
  }

  // 不适用：这条补丁在当下宿主面本来就不该打。
  if (category === "na") {
    return pick("ignore",
      "这条补丁在这台机器上用不上，不用等它生效。",
      "This patch does not apply on this host.");
  }

  if (category === "pending") {
    if (kind === "append") {
      return pick("apply",
        `${pending} 个文件里还缺这条增补补丁的标记，点「应用清洗」补上。`,
        `The append marker is not in ${pending} file(s) yet; Apply will add it.`);
    }
    return pick("apply",
      `${pending} 个文件里的原文还在，点「应用清洗」就能打上。${softNote}`,
      `The original text is still there in ${pending} file(s); Apply will land it.${softNote}`);
  }

  if (category === "partial") {
    const mismatched = noNeedle + noFile;
    if (mismatched > 0) {
      const tail = pending > 0
        ? (en ? `, ${pending} still to write` : `，还有 ${pending} 个没打`)
        : "";
      return pick(pending > 0 ? "apply" : "manual",
        `这条补丁要改 ${total} 个文件：其中 ${mismatched} 个找不到原文${tail}。`,
        `This patch touches ${total} file(s); ${mismatched} no longer match the anchor${tail}.`);
    }
    return pick("apply",
      `这条补丁要改 ${total} 个文件：${applied} 个已经改好，还有 ${pending} 个没打（再点一次「应用清洗」就补齐）。`,
      `Touches ${total} file(s): ${applied} landed, ${pending} still to write. Apply again to finish.`);
  }

  if (category === "drifted") {
    return pick("manual",
      `「${labelsOf(kindFiles("drifted"), 2, en)}」里的内容已经被别处改过（碰到了这条补丁的禁用标记），再打会冲突；建议先「还原」，再重新应用。`,
      `${labelsOf(kindFiles("drifted"), 2, en)} was changed elsewhere (this patch's forbid marker is present); restore first, then apply again.`);
  }

  if (category === "no_needle") {
    const where = labelsOf(kindFiles("no_needle"), 2, en);
    if (strict) {
      return pick("manual",
        `「${where}」里找不到这条补丁要改的原文，而它要求严格匹配，得你自己确认一下宿主版本。`,
        `The anchor is missing in ${where} and this patch is strict-matched; the host version needs a human check.`);
    }
    return pick("ignore",
      `这条补丁要找的原句在「${where}」里已经不存在了（宿主换了写法，或被别的补丁改过）。这不是失败，可以不用处理。${softNote}`,
      `The anchor text is gone from ${where} (different host version, or another patch already rewrote it). Not a failure.${softNote}`);
  }

  if (category === "no_file") {
    return pick("manual",
      `补丁登记了要改的文件，但现在读不到（${labelsOf(kindFiles("no_file"), 2, en)}），可能在升级时被换掉了。`,
      `A registered target file is unreadable (${labelsOf(kindFiles("no_file"), 2, en)}); it may have been replaced by an upgrade.`);
  }

  if (category === "no_pkg") {
    return pick("ignore",
      `这台机器没装它要改的包（${labelsOf(kindFiles("no_pkg"), 2, en)}），这条补丁用不上，不用管。`,
      `This host does not ship the package(s) it targets (${labelsOf(kindFiles("no_pkg"), 2, en)}).`);
  }

  // applied：磁盘上已经是新写法。状态被开关改掉时（钩子旁路关掉会把状态标成 pending / skipped）要说清楚，
  // 否则用户会看到「已生效 0 条」以为全没打上。
  const noPkgNote = noPkg > 0
    ? (en ? `; ${noPkg} package(s) are absent here` : `；另有 ${noPkg} 个包这台机器没装`)
    : "";
  if (status !== "applied" && status !== category) {
    const statusWord = status === "off" ? (en ? "off" : "关闭") : status;
    return pick("ignore",
      `${applied} 个文件已经是新写法了，只是「钩子拦截旁路」开关关着，所以这条显示成「${statusWord}」，不用重打。`,
      `The ${applied} file(s) already hold the new text; only the hooks-deny switch is off, so it reads as "${statusWord}". Nothing to redo.`);
  }
  return pick("ignore",
    `${applied} 个文件都已经是新写法，这条补丁已经打上了${noPkgNote}。`,
    `${applied} file(s) already hold the new text${noPkgNote}.`);
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
  const row = {
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
    // 判定用到的声明式字段也留一份：面板要按 en / 最新状态重算原因时，手上得有这些数据。
    strict: patch.strictFiles === true,
    soft: patchIsSoftSettle(patch),
    kind: patchKindOf(patch),
    reason: "",
    advice: "",
    advice_code: "ignore",
    advice_tone: "muted",
  };
  const layer = patchLayerOf(row);
  row.layer_key = layer.key;
  row.layer_group = layer.zh;
  row.layer_group_en = layer.en;
  const explained = explainPatchRow(row, "zh");
  row.reason = explained.reason;
  row.advice = explained.advice;
  row.advice_code = explained.advice_code;
  row.advice_tone = explained.advice_tone;
  return row;
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
    // 语义层（身份 / 审批 / 沙箱 / 工具 / 界面 / 其他）：面板按它分组，CLI 的 JSON 也能直接读。
    layer_key: row.layer_key,
    layer_group: row.layer_group,
    layer_group_en: row.layer_group_en,
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
    // 一句原因 + 一句怎么处理（可以再打一次 / 不用管 / 需要你自己确认）。行上没有时（老快照）退回分类短句。
    reason: row.reason || CATEGORY_REASONS[row.category] || "",
    advice: row.advice || "",
    advice_code: row.advice_code || "ignore",
    advice_tone: row.advice_tone || ADVICE_TONES.ignore,
    strict: row.strict === true,
    soft: row.soft === true,
    kind: row.kind || "replace",
  };
}
