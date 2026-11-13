// local-purge-ui —— 在 dsh-go 原生界面里操作 dsh-purge。
//
// 为什么要有它：dsh-purge 自带的「清洗」页是 **Harness 网页版**的界面，手机 App 用的是
// Flutter 原生界面，所以那个页面在这台手机上看不到。这个本地小插件把同样的操作搬到原生界面：
//   · 输入框上方一个「清洗」胶囊 → 打开面板
//   · 输入框上方一条状态条 → 一行读数（只读进程内缓存，不触发扫描）
//   · 面板里看状态（已生效 / 待应用 / 本机无目标 三个 metric + 按分类分组的原因明细），
//     一键「应用清洗」「还原」，并保留二次确认与 pending 流程
//
// 做法：面板动作直接调用 dsh-purge 自己导出的核心函数（与它自带的命令行 --apply / --revert
// 走同一条代码路径），不在本插件里重复实现补丁逻辑。只在有 dsh-go 桥接的主机上出现。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'local-purge-ui'

const HOME = process.env.DSH_HOME || path.join(process.env.HOME || os.homedir() || '/root', '.dsh')

/**
 * 定位「正在跑的引擎」真正在用的宿主目录（…/node_modules/@deepseek-ai）。
 *
 * 为什么不用 dsh-purge 的启发式发现：它会扫工作区，把形似宿主的目录（例如测试用的副本）
 * 也算成目标 —— 那会导致面板显示别人的状态、甚至把补丁打到错的目录上。
 * 这里改用 Node 解析：从引擎自己的入口文件解析 @deepseek-ai 包，得到的就是它正在用的那份。
 */
function resolveEngineHost() {
  const ids = [
    '@deepseek-ai/dsh-agent-instructions/package.json',
    '@deepseek-ai/dsh/package.json',
    '@deepseek-ai/dsh-base/package.json',
  ]
  const seeds = [process.argv[1], path.join(HOME, 'profiles', 'web', 'package.json')].filter(Boolean)
  for (const seed of seeds) {
    let req = null
    try {
      req = createRequire(path.isAbsolute(seed) ? seed : path.resolve(seed))
    } catch {
      continue
    }
    for (const id of ids) {
      try {
        const resolved = req.resolve(id)
        const base = path.dirname(path.dirname(resolved))
        if (isRealHost(base)) return base
      } catch { /* 换下一个 id / 种子 */ }
    }
  }
  // 兜底：dsh-go 的本机引擎固定在 /opt/dsh（解析失败时才用，且必须是真宿主）
  const appHost = '/opt/dsh/node_modules/@deepseek-ai'
  if (isRealHost(appHost)) return appHost
  return ''
}

/** 宿主目录必须同时有 agent-instructions 与 web-app，才认为是一个能打补丁的真宿主。 */
function isRealHost(base) {
  if (!base) return false
  try {
    return fs.statSync(path.join(base, 'dsh-agent-instructions', 'lib')).isDirectory()
      && fs.statSync(path.join(base, 'dsh-web-app', 'lib')).isDirectory()
  } catch {
    return false
  }
}

/**
 * 把 dsh-purge 的目标锁到引擎真正的宿主上：
 *   · 没设过 DSH_BASE 就临时设成解析出来的宿主（purge 的 findAiBase 优先读它）；
 *   · 调用期间用完还原，不影响引擎里其它流程。
 */
async function withPinnedHost(fn) {
  const host = resolveEngineHost()
  const previous = process.env.DSH_BASE
  const changed = Boolean(host) && !previous
  if (changed) process.env.DSH_BASE = host
  try {
    return await fn(changed ? host : previous || host)
  } finally {
    if (changed) delete process.env.DSH_BASE
  }
}

/** 定位已安装的 dsh-purge 包目录（引擎自己的 profile 里那份）。 */
function findPurgeDir() {
  const cands = []
  try {
    const profiles = path.join(HOME, 'profiles')
    for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) cands.push(path.join(profiles, entry.name, 'node_modules', 'dsh-purge'))
    }
  } catch { /* 没有 profiles 目录 */ }
  cands.push(
    path.join(HOME, 'dsh-go', 'plugins', 'dsh-purge'),
    path.join(HOME, 'node_modules', 'dsh-purge'),
  )
  for (const dir of cands) {
    try {
      if (fs.statSync(path.join(dir, 'lib', 'core.js')).isFile()) return dir
    } catch { /* 换下一个 */ }
  }
  return ''
}

let loaded = null

/** 动态加载 dsh-purge 的核心模块（Node 按 URL 缓存，与引擎里那份是同一实例）。 */
async function loadPurge() {
  if (loaded) return loaded
  const dir = findPurgeDir()
  if (!dir) throw new Error('没找到 dsh-purge 插件目录')
  const core = await import(pathToFileURL(path.join(dir, 'lib', 'core.js')).href)
  let rules = null
  try {
    rules = await import(pathToFileURL(path.join(dir, 'lib', 'rules.js')).href)
  } catch { /* rules 缺失时只影响「提示词是否为空」的预检 */ }
  loaded = { dir, core, rules }
  return loaded
}

function humanBytes(n) {
  const v = Number(n) || 0
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
  if (v >= 1024) return `${Math.round(v / 1024)} KB`
  return `${v} B`
}

function readPromptInfo() {
  const file = path.join(HOME, 'prompt-inject.md')
  try {
    const st = fs.statSync(file)
    return { file, size: st.size, exists: true }
  } catch {
    return { file, size: 0, exists: false }
  }
}

function readRedteamPhase() {
  try {
    const raw = fs.readFileSync(path.join(HOME, 'redteam', 'preset-declare.json'), 'utf8')
    const json = JSON.parse(raw)
    if (json.ok === true) return { text: '已注册', tone: 'good' }
    if (json.phase === 'registered-broken') return { text: '注册了但坏了', tone: 'bad' }
    return { text: String(json.phase || '未知'), tone: 'warn' }
  } catch {
    return { text: '未装 / 无记录', tone: 'muted' }
  }
}

/**
 * 精确判断「补丁到底应用没应用」——不看计数，看两处硬证据：
 *   1) 宿主里有没有 .dshpurge.bak 备份（应用时每个被改文件留一份，还原时删掉）；
 *   2) 审批直通那行有没有写进去（dsh-user-approval 里的 [dsh-purge] approval bypass 标记）。
 * 只看计数会把「无需改动的补丁」也算成已应用，从而骗人。
 */
function detectApplied(host) {
  const out = { backups: 0, approvalBypass: false }
  if (!host) return out
  try {
    const file = path.join(host, 'dsh-user-approval', 'lib', 'index.js')
    out.approvalBypass = fs.readFileSync(file, 'utf8').includes('[dsh-purge] approval bypass')
  } catch { /* 读不到就当没应用 */ }
  const stack = [host]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { stack.push(full); continue }
      if (entry.name.endsWith('.dshpurge.bak')) out.backups += 1
    }
  }
  return out
}

// ─────────────────────── 分类分组（面板明细） ───────────────────────

/**
 * 面板上的分组顺序与标题。key 必须与 lib/patch-report.js 的 PATCH_ROW_CATEGORIES 一致：
 * 7 分类里 applied 不进「未生效明细」，na 归到「本机无目标」那个 metric，不进明细。
 */
const DETAIL_GROUPS = Object.freeze([
  { key: 'pending', zh: '待应用', en: 'Pending', icon: 'clock' },
  { key: 'partial', zh: '部分命中', en: 'Partial', icon: 'warning' },
  { key: 'drifted', zh: '被覆盖', en: 'Drifted', icon: 'bug' },
  { key: 'no_needle', zh: '无目标句', en: 'No anchor', icon: 'search' },
  { key: 'no_file', zh: '文件缺失', en: 'File missing', icon: 'folder' },
  { key: 'no_pkg', zh: '本机无包', en: 'No package', icon: 'archive' },
])

/** 每组标题下的一句人话：告诉用户这一档该怎么处理，而不是只给一个红叉。 */
const GROUP_HINTS = Object.freeze({
  pending: ['锚点还在，点「应用清洗」就会落地。', 'Anchor found: Apply will land it.'],
  partial: ['多文件补丁只落地了一部分，建议重新应用一次。', 'Only part of a multi-file patch landed; apply again.'],
  drifted: ['产物被别的改动弄脏了，先还原再重新应用。', 'The file was altered elsewhere; restore, then apply again.'],
  no_needle: ['宿主版本不同或已被别的补丁改写，搜索串对不上。', 'Host text differs: the search anchor is not there.'],
  no_file: ['登记了目标文件但读不到，可能在升级中被替换。', 'A registered target file is unreadable right now.'],
  no_pkg: ['这套宿主没有该补丁指向的包，补丁无处落地。', 'This host does not ship the package this patch targets.'],
})

/** 每类最多列几条；列表总条数上限（协议：单个 list ≤ 50 条）。 */
const GROUP_LIMIT = 10
const LIST_LIMIT = 50

const isEn = (localeStr) => String(localeStr || '').startsWith('en')

/** 补丁名太长会把一行挤爆，这里按字符截断（中文一个字算一个）。 */
function shortName(row, en) {
  const name = String(row?.name || '').trim()
  if (!name) return en ? `Patch #${row?.id}` : `补丁 #${row?.id}`
  return name.length > 28 ? `${name.slice(0, 27)}…` : name
}

/** 一条补丁的一句话原因：优先用本插件自己的双语表，回落到 core 给的中文 reason。 */
function rowReason(row, en) {
  const key = String(row?.category || '')
  if (GROUP_HINTS[key]) return en ? GROUP_HINTS[key][1] : GROUP_HINTS[key][0]
  const fallback = String(row?.reason || '').trim()
  return fallback || (en ? 'Not applied' : '未生效')
}

/**
 * 把 patch_rows 折成面板那一个 list 的 items：
 *   每组一行小标题（含条数）→ 最多 10 条明细 → 「另有 N 条」。
 *
 * 为什么折进一个 list 而不是每组一个 list：空分组的 list 在 App 里会画成「暂无数据」，
 * 六组里五组空的时候整页都是占位符。合成一条时，空分组直接不出现，总条数还能自己卡在 50 以内。
 */
export function buildDetail(rows, locale) {
  const en = isEn(locale)
  const buckets = new Map(DETAIL_GROUPS.map((g) => [g.key, []]))
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.category || '')
    if (!buckets.has(key)) continue // applied / na 不进明细
    buckets.get(key).push(row)
  }
  const items = []
  let budget = LIST_LIMIT
  let skipped = 0
  for (const group of DETAIL_GROUPS) {
    const list = buckets.get(group.key) || []
    if (list.length === 0) continue
    // 一组至少要有「标题 + 1 条」的位置，否则整组折进 skipped。
    if (budget < 2) { skipped += list.length; continue }
    let take = Math.min(GROUP_LIMIT, list.length, budget - 2)
    if (take < 1) { skipped += list.length; continue }
    const rest = list.length - take
    if (rest > 0 && budget - (1 + take + 1) < 0) take = Math.max(1, budget - 3)
    items.push({
      title: `${en ? group.en : group.zh} · ${list.length}`,
      subtitle: en ? GROUP_HINTS[group.key][1] : GROUP_HINTS[group.key][0],
      icon: group.icon,
      tone: 'muted',
    })
    for (const row of list.slice(0, take)) {
      const item = { title: shortName(row, en), icon: 'document' }
      const reason = rowReason(row, en)
      if (reason) item.subtitle = reason
      if (group.key === 'drifted') item.tone = 'bad'
      else if (group.key === 'pending') item.tone = 'warn'
      items.push(item)
    }
    const left = list.length - take
    if (left > 0) {
      items.push({
        title: en ? `${left} more` : `另有 ${left} 条`,
        subtitle: en ? 'Copy status for the full list.' : '完整清单可用「复制状态」。',
        tone: 'muted',
        icon: 'more',
      })
    }
    budget -= 1 + take + (left > 0 ? 1 : 0)
  }
  if (skipped > 0) {
    items.push({
      title: en ? `${skipped} more not shown` : `另有 ${skipped} 条未列出`,
      subtitle: en ? 'The panel shows at most 50 rows.' : '面板一次最多 50 行。',
      tone: 'muted',
      icon: 'more',
    })
  }
  if (items.length === 0) {
    return [{
      title: en ? 'All applied' : '全部已生效',
      subtitle: en ? 'Nothing is left to write.' : '没有还需要写入的补丁。',
      tone: 'good',
      icon: 'check',
    }]
  }
  return items
}

/**
 * 老版本 core（没有 patch_tally / patch_rows）时的回落：
 * 把 display_patches + patch_status 折成同一套 row 结构，面板不至于变成空白。
 */
function legacyRows(state, en) {
  const statusById = state.patch_status || {}
  const nameById = new Map()
  const categoryOf = (status) => {
    if (status === 'applied' || status === 'already') return 'applied'
    if (status === 'pending') return 'pending'
    if (status === 'missing_file') return 'no_file'
    if (status === 'unmatched') return 'no_needle'
    if (status === 'na' || status === 'off') return 'na'
    return 'no_needle'
  }
  const out = []
  const tally = { applied: 0, pending: 0, partial: 0, drifted: 0, no_needle: 0, no_file: 0, no_pkg: 0, na: 0, total: 0 }
  for (const row of Array.isArray(state.display_patches) ? state.display_patches : []) {
    const ids = Array.isArray(row.ids) ? row.ids : [row.id]
    for (const id of ids) {
      const category = categoryOf(statusById[id] || row.status)
      if (tally[category] !== undefined) tally[category] += 1
      tally.total += 1
      out.push({ id, name: nameById.get(Number(id)) || `#${id}`, category })
    }
  }
  if (tally.total === 0) {
    // display_patches 也没有（未定位宿主）：干脆按旧计数给出三个 metric 的近似值。
    tally.applied = Number(state.patches_applied) || 0
    tally.pending = Number(state.patches_pending) || 0
    tally.na = Number(state.patches_na) || 0
    tally.total = Number(state.patches_total) || 0
  }
  return { rows: out, tally, en }
}

// ─────────────────────── 缓存与状态条快照 ───────────────────────

let cachedState = null
let cachedAt = 0
let cachedLocale = ''
const CACHE_MS = 20_000

const PLACEHOLDER = {
  m_applied: '…',
  m_pending: '…',
  m_idle: '…',
  m_applied_tone: 'muted',
  m_pending_tone: 'muted',
  m_idle_tone: 'muted',
  state: '正在读取…',
  patches: '…',
  host: '…',
  inject: '…',
  redteam: '…',
  hint: '正在读取宿主状态…',
  summary: '正在读取状态…',
  detail: [{ title: '正在读取明细…', tone: 'muted', icon: 'clock' }],
  detail_note: '正在统计未生效的补丁…',
}

/**
 * 状态条快照：只放「一行读得下的几个数」，由面板那次读取顺手更新。
 * 状态条本身**不读磁盘**——它每次都只是把这几个数读出来重画。
 */
let stripSnapshot = null

function remember(value) {
  cachedState = value
  cachedAt = Date.now()
  return value
}

function stripModel(localeStr) {
  const en = isEn(localeStr)
  const snap = stripSnapshot
  if (!snap) {
    return { text: en ? 'Purge · open panel' : '清洗 · 待读取', icon: 'wrench', tone: 'muted' }
  }
  if (!snap.hostOk) {
    return { text: en ? 'Purge · no host' : '清洗 · 未定位宿主', icon: 'warning', tone: 'warn' }
  }
  const head = en ? 'Purge' : '清洗'
  const tail = en ? `· ${snap.pending} left` : `· 待 ${snap.pending}`
  return {
    text: `${head} ${snap.applied}/${snap.total} ${tail}`,
    icon: snap.pending > 0 ? 'clock' : 'check',
    tone: snap.pending > 0 ? 'warn' : 'good',
  }
}

// ─────────────────────── 读状态 ───────────────────────

/** 读一次状态并按 locale 排版；fresh=true 时绕过两处缓存（手动刷新 / 写操作之后用）。 */
async function collect(options = {}) {
  const en = isEn(options.locale)
  const { core } = await loadPurge()
  return withPinnedHost(async (resolvedHost) => {
    if (options.fresh === true && typeof core.invalidatePatchCache === 'function') {
      // 手动刷新要看到「此刻的磁盘」，core 的 30 秒检测缓存必须一起丢。
      try { core.invalidatePatchCache() } catch { /* 老版本没有这个导出 */ }
    }
    const state = await core.gatherState(options.fresh === true ? { fresh: true } : undefined)
    const hostFull = resolvedHost || String(state.ai_base || '')
    const hostOk = isRealHost(hostFull)
    const prompt = readPromptInfo()
    const redteam = readRedteamPhase()
    const marked = hostOk ? detectApplied(hostFull) : { backups: 0, approvalBypass: false }

    // 新字段优先；老 core 没有就回落到 display_patches / 旧计数。
    const hasTally = state.patch_tally && typeof state.patch_tally === 'object'
    const fallback = hasTally ? null : legacyRows(state, en)
    const tally = hasTally ? state.patch_tally : fallback.tally
    const rows = hasTally && Array.isArray(state.patch_rows) ? state.patch_rows : fallback.rows

    const applied = Number(tally.applied) || 0
    const pending = Number(tally.pending) || 0
    const partial = Number(tally.partial) || 0
    const drifted = Number(tally.drifted) || 0
    const noNeedle = Number(tally.no_needle) || 0
    const noFile = Number(tally.no_file) || 0
    const noPkg = Number(tally.no_pkg) || 0
    const na = Number(tally.na) || 0
    const total = Number(tally.total) || Number(state.patches_total) || 0
    // 「本机无目标」= 这套宿主没装那个包 + 本机不需要该补丁：都是「这里没有它的位置」。
    const idle = noPkg + na
    const notApplied = total - applied

    let injectText = '缺失'
    if (prompt.exists) {
      const custom = state.override_status && state.override_status !== 'default'
      injectText = `${custom ? '已自定义' : '随包默认'} · ${humanBytes(prompt.size)}`
    }

    const patchesText = hostOk && total
      ? `${applied}/${total} 已生效 · 待 ${pending} · 部分 ${partial} · 被覆盖 ${drifted}`
      : '—'

    const detail = buildDetail(rows, en ? 'en' : 'zh')
    const detailNote = !hostOk
      ? (en ? 'No host found: open the engine and try again.' : '没定位到宿主：先确认引擎在跑，再点刷新。')
      : notApplied > 0
        ? (en ? `${notApplied} of ${total} not applied yet.` : `共 ${total} 条，${notApplied} 条还没生效。`)
        : (en ? `All ${total} patches applied.` : `${total} 条全部生效。`)

    let hint
    let stateText
    if (!hostOk) {
      stateText = en ? 'No host' : '未定位宿主'
      hint = en
        ? `⚠ No engine host found (${hostFull || 'empty'}); Apply is disabled to avoid hitting the wrong tree.`
        : `⚠ 没定位到引擎正在用的宿主目录（${hostFull || '空'}），已停用「应用清洗」以免打到错的地方。`
    } else if (marked.approvalBypass) {
      stateText = en ? 'Applied' : '已应用'
      hint = en
        ? 'Patches applied: approval prompt off, write sandbox opened. Restart the engine to take effect.'
        : '已应用补丁：审批提示被关掉、文件写入沙箱放开。重启引擎后生效；随时可点「还原」。'
    } else if (marked.backups > 0) {
      stateText = en ? `Half applied (${marked.backups} backups)` : `半应用（${marked.backups} 个备份）`
      hint = en
        ? `${marked.backups} patch backups are still there but the approval bypass is missing. Restore, then apply again.`
        : `宿主里还留着 ${marked.backups} 个补丁备份，但审批直通没写进去 —— 可能是上次应用到一半。建议点「还原」再重来。`
    } else {
      stateText = en ? 'Not applied' : '未应用'
      hint = en
        ? 'Not applied yet: only the prompt injection is active; the approval prompt still works normally.'
        : '尚未应用：现在只有「提示词注入」在生效，审批提示仍然正常开着。'
    }

    const cacheNote = state.patch_cache
      ? (state.patch_cache.hit
        ? (en ? `read from cache ${Math.round((Number(state.patch_cache.age_ms) || 0) / 1000)}s ago` : `读自缓存 ${Math.round((Number(state.patch_cache.age_ms) || 0) / 1000)} 秒前`)
        : (en ? 'freshly scanned' : '刚从磁盘扫描'))
      : (en ? 'unknown cache state' : '缓存状态未知')

    const summaryLines = [
      en ? `Real state: ${stateText}` : `真实状态：${stateText}`,
      en ? `Tally: applied ${applied} / pending ${pending} / partial ${partial} / drifted ${drifted}` : `分类计数：已生效 ${applied} · 待应用 ${pending} · 部分 ${partial} · 被覆盖 ${drifted}`,
      en ? `No text match ${noNeedle} · file missing ${noFile} · package absent ${noPkg} · not needed ${na}` : `无目标句 ${noNeedle} · 文件缺失 ${noFile} · 本机无包 ${noPkg} · 不适用 ${na}`,
      en ? `Total ${total} (${cacheNote})` : `合计 ${total} 条（${cacheNote}）`,
      en ? `Host: ${hostFull || 'not found'}` : `宿主目录：${hostFull || '未定位'}`,
      en ? `Prompt: ${injectText} (${prompt.file})` : `注入文案：${injectText}（${prompt.file}）`,
      en ? `Redteam preset: ${redteam.text}` : `红队模式：${redteam.text}`,
    ]

    stripSnapshot = { applied, pending, total, hostOk }

    return {
      m_applied: String(applied),
      m_pending: String(pending),
      m_idle: String(idle),
      m_applied_tone: hostOk ? (applied > 0 ? 'good' : 'muted') : 'muted',
      m_pending_tone: pending > 0 ? 'warn' : 'muted',
      m_idle_tone: 'muted',
      state: stateText,
      patches: patchesText,
      host: hostFull || (en ? 'not found' : '未定位'),
      inject: injectText,
      redteam: redteam.text,
      hint,
      detail,
      detail_note: detailNote,
      summary: summaryLines.join('\n'),
    }
  })
}

/** 读一次状态；同一 locale 下 20 秒内重复打开面板直接用缓存（免得每次点开都等几秒）。 */
async function collectCached(locale) {
  const key = isEn(locale) ? 'en' : 'zh'
  const now = Date.now()
  if (cachedState && cachedLocale === key && now - cachedAt < CACHE_MS) return cachedState
  const value = await collect({ locale })
  cachedLocale = key
  return remember(value)
}

/** 应用清洗：与插件自带命令行 --apply 同一路径，但目标锁死、不做启发式扫描。 */
async function runApply() {
  const { core, rules } = await loadPurge()
  return withPinnedHost(async (host) => {
    if (!isRealHost(host)) throw new Error('没定位到引擎正在用的宿主目录，已停手')
    if (rules && typeof rules.resolveInjectText === 'function') {
      const inject = rules.resolveInjectText(HOME)
      if (!inject || !inject.text) throw new Error('提示词是空的，先在插件里准备注入文案')
    }
    const before = await core.gatherState()
    const out = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      discover: false,
    })
    const report = Array.isArray(out?.report) ? out.report : []
    const appliedCount = report.filter((r) => r.status === 'applied').length
    const skipped = report.filter((r) => r.status === 'skipped' || r.status === 'pattern_not_found').length
    const na = report.filter((r) => r.status === 'na').length
    const missing = report.filter((r) => r.status === 'missing_file').length
    const failed = report.filter((r) => !['applied', 'already', 'skipped', 'pattern_not_found', 'na', 'missing_file'].includes(r.status)).length
    const shimDir = before?.shim_dir
    if (shimDir && typeof core.patchShim === 'function') {
      try { await core.patchShim(shimDir) } catch { /* shim 非关键 */ }
    }
    return {
      applied: appliedCount,
      already: report.filter((r) => r.status === 'already').length,
      skipped,
      na,
      missing,
      failed,
      hosts: Array.isArray(out?.hosts) ? out.hosts.length : 0,
    }
  })
}

/** 还原：与插件自带命令行 --revert 同一路径，同样不做启发式扫描。 */
async function runRevert() {
  const { core } = await loadPurge()
  return withPinnedHost(async (host) => {
    if (!isRealHost(host)) throw new Error('没定位到引擎正在用的宿主目录，已停手')
    const before = await core.gatherState()
    const out = await core.revertAllHosts({ discover: false })
    const reverted = Array.isArray(out?.reverted) ? out.reverted.length : 0
    const errors = Array.isArray(out?.errors) ? out.errors.length : 0
    const shimDir = before?.shim_dir
    if (shimDir && typeof core.revertShim === 'function') {
      try { await core.revertShim(shimDir) } catch { /* shim 非关键 */ }
    }
    return { reverted, errors }
  })
}

function loc(event) {
  return isEn(event?.locale)
}

// ─────────────────────── 视图 ───────────────────────

/** 面板上的固定文案：中英各一份，短、全角标点。 */
function panelText(localeStr) {
  return isEn(localeStr)
    ? {
        title: 'dsh-purge',
        applied: 'Applied',
        appliedCap: 'landed on disk',
        pending: 'Pending',
        idle: 'No target',
        idleCap: 'package absent / not needed',
        real: 'Real state',
        counts: 'Tally',
        host: 'Host dir',
        inject: 'Prompt',
        redteam: 'Redteam',
        detail: 'Not applied, grouped by reason',
        apply: 'Apply patches',
        cancel: 'Not now',
        revert: 'Restore',
        refresh: 'Refresh',
        copy: 'Copy status',
        foot: 'Restart the engine after applying.',
      }
    : {
        title: 'dsh-purge 清洗',
        applied: '已生效',
        appliedCap: '已落地到磁盘',
        pending: '待应用',
        idle: '本机无目标',
        idleCap: '无该包 / 不适用',
        real: '真实状态',
        counts: '分类计数',
        host: '宿主目录',
        inject: '注入文案',
        redteam: '红队模式',
        detail: '未生效的补丁（按原因分组）',
        apply: '应用清洗',
        cancel: '再想想',
        revert: '还原',
        refresh: '刷新',
        copy: '复制状态',
        foot: '应用后需重启引擎才生效。',
      }
}

export function apply(ctx) {
  // 只在装了 dsh-go 桥接的主机上出现（手机本机引擎有）；写 ['dshGo']，不写 ['dshGo?']。
  ctx.inject(['dshGo'], (ctx) => {
    // 胶囊：点一下直接开面板
    ctx.dshGo.on('purge-open', () => ({ open: 'panel:purge-panel' }))

    // 状态条：一行读数。只读上面那份进程内快照，任何情况下都不在这里扫磁盘。
    ctx.dshGo.strip('purge-strip', (scope, emit, caps) => {
      const locale = caps?.locale || ''
      let lastText = ''
      const push = () => {
        const model = stripModel(locale)
        if (model.text === lastText) return
        lastText = model.text
        try { emit(model) } catch { /* 状态条已经不在前台 */ }
      }
      push()
      // 面板读过之后快照会变；20 秒重画一次就够，不做任何 IO。
      const timer = setInterval(push, 20_000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    })

    ctx.dshGo.panel('purge-panel', {
      view: (scope, caps) => {
        const T = panelText(caps?.locale)
        return {
          type: 'stack',
          title: T.title,
          children: [
            {
              type: 'row',
              children: [
                { type: 'metric', label: T.applied, value: { $: 'data.m_applied' }, tone: { $: 'data.m_applied_tone' }, caption: T.appliedCap },
                { type: 'metric', label: T.pending, value: { $: 'data.m_pending' }, tone: { $: 'data.m_pending_tone' } },
                { type: 'metric', label: T.idle, value: { $: 'data.m_idle' }, tone: { $: 'data.m_idle_tone' }, caption: T.idleCap },
              ],
            },
            {
              type: 'keyValue',
              items: [
                [T.real, { $: 'data.state' }],
                [T.counts, { $: 'data.patches' }],
                [T.host, { $: 'data.host' }],
                [T.inject, { $: 'data.inject' }],
                [T.redteam, { $: 'data.redteam' }],
              ],
            },
            { type: 'callout', text: { $: 'data.hint' }, tone: 'info' },
            { type: 'confirm', id: 'apply', confirmLabel: T.apply, cancelLabel: T.cancel },
            {
              type: 'actions',
              items: [
                { label: T.revert, action: 'revert', icon: 'restart' },
                { label: T.refresh, action: 'refresh', icon: 'refresh' },
                { label: T.copy, action: 'copy-status', icon: 'copy' },
              ],
            },
            { type: 'text', text: T.detail, tone: 'muted' },
            { type: 'list', items: { $: 'data.detail' } },
            { type: 'text', text: { $: 'data.detail_note' }, tone: 'muted' },
            { type: 'text', text: T.foot, tone: 'muted' },
          ],
        }
      },

      data: (scope, emit, caps) => {
        let dead = false
        const locale = caps?.locale || ''
        emit(cachedState || PLACEHOLDER)
        collectCached(locale)
          .then((value) => { if (!dead) emit(value) })
          .catch((error) => {
            if (dead) return
            const en = isEn(locale)
            emit({
              m_applied: '—',
              m_pending: '—',
              m_idle: '—',
              patches: '—',
              host: '—',
              inject: '—',
              redteam: '—',
              hint: `${en ? 'Could not read state: ' : '读取状态失败：'}${String(error && error.message ? error.message : error)}`,
              summary: en ? 'Failed to read state' : '读取状态失败',
              detail: [{ title: en ? 'No data' : '没有数据', tone: 'muted', icon: 'warning' }],
              detail_note: en ? 'Check that dsh-purge is installed.' : '先确认 dsh-purge 已安装。',
            })
          })
        return () => { dead = true }
      },

      actions: {
        // confirm 组件：value 是 { confirmed: true|false }
        apply: (scope, event) => {
          if (event?.value?.confirmed !== true) {
            return { toast: loc(event) ? 'Cancelled' : '已取消' }
          }
          return {
            pending: {
              label: loc(event) ? 'Applying patches…' : '正在应用清洗（约 10 秒）',
              timeoutMs: 60_000,
            },
            result: async () => {
              try {
                const r = await runApply()
                cachedState = null
                const patch = await remember(await collect({ locale: event?.locale, fresh: true }))
                const naTotal = r.skipped + r.na + r.missing
                const tail = naTotal > 0
                  ? (loc(event) ? ` · ${naTotal} not applicable` : ` · 不适用 ${naTotal} 条`)
                  : ''
                return {
                  toast: (loc(event)
                    ? `${r.applied} applied${tail} · restart to take effect`
                    : `已生效 ${r.applied} 条${tail} · 重启引擎后生效`).slice(0, 40),
                  patch,
                }
              } catch (error) {
                const msg = String(error && error.message ? error.message : error)
                const patch = await collect({ locale: event?.locale, fresh: true }).catch(() => undefined)
                return patch
                  ? { toast: `应用失败：${msg}`.slice(0, 40), patch }
                  : { toast: `应用失败：${msg}`.slice(0, 40) }
              }
            },
          }
        },

        revert: (scope, event) => ({
          pending: { label: loc(event) ? 'Restoring…' : '正在还原（约 5 秒）', timeoutMs: 60_000 },
          result: async () => {
            try {
              const r = await runRevert()
              cachedState = null
              const patch = await remember(await collect({ locale: event?.locale, fresh: true }))
              return {
                toast: r.errors > 0
                  ? `还原完成，${r.errors} 个文件失败`
                  : `已还原 ${r.reverted} 个文件 · 重启引擎后恢复`,
                patch,
              }
            } catch (error) {
              const msg = String(error && error.message ? error.message : error)
              return { toast: `还原失败：${msg}`.slice(0, 40) }
            }
          },
        }),

        // 刷新：丢缓存 → 重新读 → 用 patch 把新数据推给面板。
        // 只回 {refresh:true} 等于让视图重取、数据还走 20 秒缓存，看起来像没刷新。
        refresh: async (scope, event) => {
          try {
            cachedState = null
            const patch = await remember(await collect({ locale: event?.locale, fresh: true }))
            return { patch, toast: loc(event) ? 'Refreshed' : '已刷新' }
          } catch (error) {
            const msg = String(error && error.message ? error.message : error)
            return { toast: `刷新失败：${msg}`.slice(0, 40) }
          }
        },

        'copy-status': async (scope, event) => {
          try {
            const value = await collectCached(event?.locale)
            const text = `${value.summary}\n\n${value.hint}\n\n${value.detail_note}`
            return { copy: text, toast: loc(event) ? 'Status copied' : '状态已复制' }
          } catch (error) {
            const msg = String(error && error.message ? error.message : error)
            return { toast: `读取失败：${msg}`.slice(0, 40) }
          }
        },
      },
    })
  })
}
