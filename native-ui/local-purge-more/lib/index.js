// local-purge-more —— 把 dsh-purge 的三块内容搬进 dsh-go 原生界面。
//
// 为什么要有它：dsh-purge 自带的页面是 **Harness 网页版**的，手机 App 用 Flutter 原生界面，
// 那些页面在这台手机上看不到。这个本地小插件把三块内容搬到原生面板：
//   1) 提示词  —— $DSH_HOME/prompt-inject.md：路径 / 大小 / 随包默认还是自定义 / 前 800 字预览，
//                  可「恢复随包默认」「复制当前文案」。
//   2) 规则集  —— $DSH_HOME/rules/：列出规则套、当前生效的是哪套，可「切换规则」「复制正文」。
//   3) 技能库  —— $DSH_HOME/redteam/skills/*.md：列出红队技能、和随包副本比有没有被动过，可「复制正文」。
// 输入框上方还有一个胶囊「存为注入」：把输入框里的文字存成注入文案（二次确认 + 自动备份）。
//
// 做法与 local-purge-ui 一致：不自己实现业务逻辑，直接调用 dsh-purge 自己导出的函数
// （core.installOverride / rules.listRules / rules.activateRule …），dsh-purge 目录按 profiles 动态找，
// 不硬编码绝对路径。只在装了 dsh-go 桥接的主机上出现，不联网。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const name = 'local-purge-more'

const HOME = process.env.DSH_HOME || path.join(process.env.HOME || os.homedir() || '/root', '.dsh')

/** 复制类效果的上限（协议规定 8000 字）。 */
const COPY_LIMIT = 8000
/** 提示词预览字数。 */
const PREVIEW_CHARS = 800

// ─────────────────────────── dsh-purge ───────────────────────────

/** 定位已安装的 dsh-purge 包目录（引擎自己的 profile 里那份）。不写死绝对路径。 */
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

let cachedPurge = null

/** 动态加载 dsh-purge 的核心模块（Node 按 URL 缓存，与引擎里那份是同一实例）。 */
async function loadPurge() {
  if (cachedPurge) return cachedPurge
  const dir = findPurgeDir()
  if (!dir) throw new Error('没找到 dsh-purge 插件目录')
  const core = await import(pathToFileURL(path.join(dir, 'lib', 'core.js')).href)
  let rules = null
  try {
    rules = await import(pathToFileURL(path.join(dir, 'lib', 'rules.js')).href)
  } catch { /* rules 模块缺失时，规则集面板走只读回退 */ }
  cachedPurge = { dir, core, rules }
  return cachedPurge
}

// ─────────────────────────── 小工具 ───────────────────────────

const loc = (event) => String(event?.locale || '').startsWith('en')

function humanBytes(n) {
  const v = Number(n) || 0
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
  if (v >= 1024) return `${Math.round(v / 1024)} KB`
  return `${v} B`
}

/** 提示语一律短句、全角标点，超长只截断，不吐英文异常。 */
function toastText(text) {
  const t = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim()
  if (!t) return '没成功，也没给出原因'
  return t.length > 38 ? `${t.slice(0, 37)}…` : t
}

function humanError(error) {
  const raw = String(error && error.message ? error.message : error)
  if (!raw) return '出了点问题，原因不明'
  if (/ENOENT|no such file/i.test(raw)) return '文件不在了，可能被删或没装'
  if (/EACCES|EPERM|permission denied/i.test(raw)) return '没有权限读写这个文件'
  if (/没找到 dsh-purge/.test(raw)) return '没找到 dsh-purge，先装上它'
  return raw
}

function readTextBounded(file, max) {
  try {
    const st = fs.statSync(file)
    const size = Number(st.size) || 0
    const buf = fs.readFileSync(file)
    let text = buf.toString('utf8')
    let truncated = false
    if (max && text.length > max) {
      text = text.slice(0, max)
      truncated = true
    }
    return { exists: true, size, text, truncated, mtime: Number(st.mtimeMs) || 0 }
  } catch {
    return { exists: false, size: 0, text: '', truncated: false, mtime: 0 }
  }
}

/** 先看长度，够短就直接比内容；太长只报长度，免得白读几 MB。 */
function sameContent(a, b) {
  try {
    const sa = fs.statSync(a)
    const sb = fs.statSync(b)
    if (Number(sa.size) !== Number(sb.size)) return false
    if (Number(sa.size) > 512 * 1024) return 'by-size'
    const ha = createHash('sha256').update(fs.readFileSync(a)).digest('hex')
    const hb = createHash('sha256').update(fs.readFileSync(b)).digest('hex')
    return ha === hb
  } catch {
    return false
  }
}

function stamp(ms) {
  const n = Number(ms) || 0
  if (!n) return '—'
  try {
    return new Date(n).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
}

// ─────────────────────── 数据缓存与刷新 ───────────────────────

const caches = new Map()

/**
 * 读一次数据，ttlMs 内重复要就用缓存。
 * 只给写操作后的跨面板 patch 用：那时要顺手算出别的面板的新几行，靠这份缓存省掉重算。
 * 打开面板不走这里 —— 面板必须看到刚刚的磁盘状态。
 */
function cached(key, ttlMs, load) {
  const now = Date.now()
  const hit = caches.get(key)
  if (hit && now - hit.at < ttlMs) return Promise.resolve(hit.value)
  return Promise.resolve()
    .then(load)
    .then((value) => {
      caches.set(key, { at: Date.now(), value })
      return value
    })
}

function dropCache(...keys) {
  for (const key of keys) caches.delete(key)
}

/** 三个面板的视图里各异、但 patch 时要跟着改的字段。 */
async function crossPatches(source) {
  const out = {}
  const tasks = []
  if (source !== 'prompt-panel') {
    tasks.push(cached('prompt', 4000, collectPrompt).then((v) => {
      out.promptSummary = v.summary
      out.promptPreview = v.preview
      out.promptSource = v.source
    }))
  }
  if (source !== 'rules-panel') {
    tasks.push(cached('rules', 4000, collectRules).then((v) => {
      out.rulesSummary = v.summary
      out.rulesOptions = v.options
      out.rulesList = v.list
    }))
  }
  if (source !== 'skills-panel') {
    tasks.push(cached('skills', 4000, collectSkills).then((v) => {
      out.skillsSummary = v.summary
    }))
  }
  const settled = await Promise.allSettled(tasks)
  for (const r of settled) {
    if (r.status === 'rejected') out.lastError = humanError(r.reason)
  }
  return out
}

// ─────────────────────── 面板 1：提示词 ───────────────────────

function readPromptFile(max) {
  return readTextBounded(path.join(HOME, 'prompt-inject.md'), max)
}

/** 判定来源要拿全量文本比对；视图只用前 800 字，绝不拿截断过的文本去比。 */
function fileMatches(file, text) {
  if (!text) return false
  try {
    const st = fs.statSync(file)
    const size = Number(st.size) || 0
    if (size !== Buffer.byteLength(text, 'utf8')) return false
    return fs.readFileSync(file, 'utf8').trim() === text.trim()
  } catch {
    return false
  }
}

async function collectPrompt() {
  const { core } = await loadPurge()
  const rule = await activeRuleLabel()
  const file = path.join(HOME, 'prompt-inject.md')
  const info = readPromptFile(PREVIEW_CHARS)
  let bundled = ''
  try {
    bundled = String(core.defaultOverrideText() || '').trim()
  } catch { /* 加密槽读不出来就按自定义显示 */ }
  let source
  if (!info.exists) source = '文件不存在'
  else if (!String(info.text || '').trim()) source = '空文件'
  else if (fileMatches(file, bundled)) source = '随包默认'
  else source = '用户自定义'

  const pathText = file
  const sizeText = info.exists ? humanBytes(info.size) : '—'
  const timeText = info.exists ? stamp(info.mtime) : '—'
  const preview = info.exists
    ? (String(info.text || '').trim() || '（文件是空的）')
    : '（还没生成这个文件）'
  const summary = [
    `来源：${source}`,
    `大小：${sizeText}`,
    `路径：${pathText}`,
  ].join('\n')

  return {
    exists: info.exists,
    path: pathText,
    size: sizeText,
    source,
    rule,
    time: timeText,
    preview,
    note: info.exists
      ? '只显示前 800 字；「复制当前文案」最多带 8000 字。'
      : '还没这个文件：点「恢复随包默认」会写入一份随包默认文案。',
    result: '—',
    summary,
    previewField: preview,
    sourceField: source,
  }
}

/** 提示词面板上的「当前规则」一行：只读，读不到就说未启用。 */
async function activeRuleLabel() {
  try {
    const { rules } = await loadPurge()
    if (!rules || typeof rules.readActive !== 'function') return '未启用'
    const active = await rules.readActive(HOME)
    return active || '未启用'
  } catch {
    return '未启用'
  }
}

const PROMPT_PLACEHOLDER = {
  exists: true,
  path: path.join(HOME, 'prompt-inject.md'),
  size: '…',
  source: '正在读取…',
  rule: '…',
  time: '…',
  preview: '正在读取提示词…',
  note: '最多显示前 800 字。',
  result: '—',
  summary: '正在读取提示词…',
  previewField: '正在读取提示词…',
  sourceField: '正在读取…',
}

/** 复制当前注入文案（上限 8000 字）。 */
async function copyPrompt() {
  const info = readPromptFile(COPY_LIMIT + 1)
  if (!info.exists) return { toast: '还没有 prompt-inject.md' }
  const raw = String(info.text || '')
  if (!raw.trim()) return { toast: '提示词文件是空的' }
  const clipped = raw.length > COPY_LIMIT
  const text = clipped ? raw.slice(0, COPY_LIMIT) : raw
  return {
    copy: text,
    toast: clipped ? '已复制前 8000 字（原文更长）' : '注入文案已复制',
  }
}

/** 恢复随包默认：调 dsh-purge 自己的 installOverride(home, true)。 */
async function restoreDefault() {
  const { core } = await loadPurge()
  if (typeof core.installOverride !== 'function') throw new Error('dsh-purge 没导出 installOverride')
  const action = await core.installOverride(HOME, true)
  dropCache('prompt')
  return String(action || 'done')
}

/** 把输入框里的文字存成注入文案；写前先备份旧文件。 */
async function saveDraft(text) {
  const value = String(text == null ? '' : text)
  if (!value.trim()) return { ok: false, toast: '输入框是空的，先写点东西' }
  const file = path.join(HOME, 'prompt-inject.md')
  await fs.promises.mkdir(HOME, { recursive: true })
  let backed = false
  if (fs.existsSync(file)) {
    await fs.promises.copyFile(file, `${file}.bak`)
    backed = true
  }
  const body = value.endsWith('\n') ? value : `${value}\n`
  await fs.promises.writeFile(file, body, 'utf8')
  dropCache('prompt')
  return {
    ok: true,
    toast: backed ? '已存为注入文案（旧文件已备份）' : '已存为注入文案',
  }
}

// ─────────────────────── 面板 2：规则集 ───────────────────────

function rulesDirPath() {
  return path.join(HOME, 'rules')
}

/** rules 模块不在（或没导出）时，用文件系统凑出同样的列表。 */
function listRuleFilesFallback() {
  const dir = rulesDirPath()
  const out = []
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const id = entry.name.slice(0, -3)
      let size = 0
      try {
        size = fs.statSync(path.join(dir, entry.name)).size
      } catch { /* 读不到就当 0 */ }
      let name = id
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'))
        if (meta && typeof meta.name === 'string' && meta.name) name = meta.name
      } catch { /* 没 meta 就用 id */ }
      out.push({ id, name, size })
    }
  } catch { /* 目录不存在 */ }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

async function listRulesSafe() {
  const { rules } = await loadPurge()
  if (rules && typeof rules.listRules === 'function') {
    try {
      const listed = await rules.listRules(HOME)
      return Array.isArray(listed) ? listed : []
    } catch {
      return listRuleFilesFallback()
    }
  }
  return listRuleFilesFallback()
}

async function readActiveSafe() {
  const { rules } = await loadPurge()
  if (rules && typeof rules.readActive === 'function') {
    try {
      return await rules.readActive(HOME)
    } catch { /* 回退 */ }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(rulesDirPath(), 'state.json'), 'utf8'))
    return typeof parsed?.active === 'string' ? parsed.active : null
  } catch {
    return null
  }
}

async function collectRules() {
  await loadPurge()
  const dir = rulesDirPath()
  const listed = await listRulesSafe()
  const active = await readActiveSafe()

  const options = listed.map((r) => ({
    label: `${r.name || r.id} · ${humanBytes(r.size)}${r.id === active ? ' · 当前' : ''}`,
    value: r.id,
  }))
  // options 至少要有项才显示得出来；没有规则时放一条说明项，点它只会弹一句提示。
  const optionsForView = options.length > 0
    ? options
    : [{ label: '还没有规则集', value: '__none__' }]

  const list = []
  for (const r of listed) {
    const suffix = r.id === active ? '当前生效' : '未生效'
    list.push({
      title: `${r.name || r.id} · ${suffix}`,
      subtitle: `${r.id} · ${humanBytes(r.size)}`,
      trailing: '复制',
      icon: r.id === active ? 'check' : 'document',
      action: { id: 'rule-copy', args: { rule: r.id } },
    })
  }

  const summary = [
    `当前规则：${active || '未启用'}`,
    `数量：${listed.length} 套`,
    `目录：${dir}`,
  ].join('\n')

  return {
    active: active || '未启用',
    count: `${listed.length} 套`,
    dir,
    options: optionsForView,
    list,
    summary,
    hint: listed.length > 0
      ? '点下面切换：会把该套正文写进 AGENTS.md，原文件先备份。'
      : '还没有规则集：用 dsh-purge 自己建一套，或直接改 prompt-inject.md。',
  }
}

const RULES_PLACEHOLDER = {
  active: '正在读取…',
  count: '…',
  dir: rulesDirPath(),
  options: [{ label: '正在读取规则集…', value: '__loading__' }],
  list: [],
  summary: '正在读取规则集…',
  hint: '正在读取规则集…',
}

/** 切换规则：调 dsh-purge 自己的 activateRule。 */
async function switchRule(id) {
  const { rules } = await loadPurge()
  if (!rules || typeof rules.activateRule !== 'function') {
    throw new Error('这版 dsh-purge 没导出 activateRule，改不了')
  }
  if (typeof rules.validRuleId === 'function' && !rules.validRuleId(id)) {
    throw new Error('规则 id 不合法，停手了')
  }
  await rules.activateRule(HOME, id)
  dropCache('rules', 'prompt')
}

/** 复制某套规则正文（上限 8000 字）。 */
async function copyRule(id) {
  if (!id || id === '__none__') return { toast: '还没有规则集可复制' }
  const { rules } = await loadPurge()
  let text = null
  if (rules && typeof rules.readRule === 'function') {
    text = await rules.readRule(HOME, id)
  } else {
    try {
      text = fs.readFileSync(path.join(rulesDirPath(), `${id}.md`), 'utf8')
    } catch {
      text = null
    }
  }
  if (!text || !String(text).trim()) return { toast: '这套规则是空的' }
  const clipped = text.length > COPY_LIMIT
  return {
    copy: clipped ? text.slice(0, COPY_LIMIT) : text,
    toast: clipped ? '已复制前 8000 字（原文更长）' : '规则正文已复制',
  }
}

// ─────────────────────── 面板 3：技能库 ───────────────────────

function skillsDirPath() {
  return path.join(HOME, 'redteam', 'skills')
}

function listSkillFiles() {
  const dir = skillsDirPath()
  const out = []
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const id = entry.name.slice(0, -3)
      let size = 0
      try {
        size = fs.statSync(path.join(dir, entry.name)).size
      } catch { /* 读不到就当 0 */ }
      out.push({ id, size })
    }
  } catch { /* 目录不存在 */ }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/** 单个技能：和随包副本比。missing = 随包副本没有；by-size = 太大只比长度。 */
function skillDiff(file, bundledFile) {
  if (!fs.existsSync(bundledFile)) return 'missing'
  const same = sameContent(file, bundledFile)
  if (same === true) return 'same'
  if (same === 'by-size') return 'size-same'
  return 'diff'
}

async function collectSkills() {
  const { dir } = await loadPurge()
  const local = skillsDirPath()
  const bundled = path.join(dir, 'skills', 'redteam')
  const files = listSkillFiles()

  const list = []
  let sameCount = 0
  let diffCount = 0
  let missingBundled = 0
  for (const f of files) {
    const state = skillDiff(path.join(local, f.id + '.md'), path.join(bundled, f.id + '.md'))
    if (state === 'same' || state === 'size-same') sameCount += 1
    else if (state === 'diff') diffCount += 1
    else missingBundled += 1
    const sameText = state === 'same' ? '与随包一致'
      : state === 'size-same' ? '与随包长度一致'
        : state === 'diff' ? '与随包不同'
          : '随包无此副本'
    list.push({
      title: f.id,
      subtitle: `${humanBytes(f.size)} · ${sameText}`,
      trailing: '复制',
      icon: state === 'diff' ? 'warning' : 'document',
      action: { id: 'skill-copy', args: { skill: f.id } },
    })
  }

  const summary = [
    `技能：${files.length} 个`,
    `与随包一致：${sameCount} 个`,
    `被改过：${diffCount} 个${missingBundled ? ` · 随包无副本 ${missingBundled} 个` : ''}`,
    `目录：${local}`,
  ].join('\n')

  return {
    count: `${files.length} 个`,
    same: `${sameCount} 个`,
    diff: `${diffCount} 个${missingBundled ? `（+${missingBundled} 随包无副本）` : ''}`,
    dir: local,
    bundledDir: bundled,
    list,
    summary,
    hint: files.length > 0
      ? '随包副本在 dsh-purge 包内；「与随包不同」说明本机这份被改过或被修过。'
      : '还没有技能：重启一次引擎，dsh-purge 会把随包技能同步过来。',
  }
}

const SKILLS_PLACEHOLDER = {
  count: '…',
  same: '…',
  diff: '…',
  dir: skillsDirPath(),
  bundledDir: '…',
  list: [],
  summary: '正在读取技能库…',
  hint: '正在读取技能库…',
}

/** 复制某个技能正文（上限 8000 字）。 */
async function copySkill(id) {
  if (!id) return { toast: '没指定要哪个技能' }
  const info = readTextBounded(path.join(skillsDirPath(), `${id}.md`), COPY_LIMIT + 1)
  if (!info.exists || !String(info.text || '').trim()) return { toast: '这个技能是空的' }
  const raw = String(info.text)
  const clipped = raw.length > COPY_LIMIT
  return {
    copy: clipped ? raw.slice(0, COPY_LIMIT) : raw,
    toast: clipped ? '已复制前 8000 字（原文更长）' : '技能正文已复制',
  }
}

// ─────────────────────── 面板数据函数 ───────────────────────

/**
 * 先秒出占位 / 上次的缓存，再把真值推上去；返回取消函数。
 *
 * 注意：缓存那一帧只是「立刻有东西可看」，打开面板总会再读一次磁盘 ——
 * 否则外部改了文件（或刚在别的地方改过），20 秒内面板会一直显示旧值。
 */
function makeData(panelId, cacheKey, load) {
  return (scope, emit) => {
    let dead = false
    try {
      emit(caches.get(cacheKey)?.value || placeholderFor(panelId))
    } catch { /* 首帧发不出去也不致命 */ }
    Promise.resolve()
      .then(load)
      .then((value) => {
        if (!dead) {
          try {
            emit(value)
          } catch { /* 面板关了 */ }
        }
      })
      .catch((error) => {
        if (dead) return
        try {
          emit(failPatch(panelId, error))
        } catch { /* 面板关了 */ }
      })
    return () => { dead = true }
  }
}

function placeholderFor(panelId) {
  if (panelId === 'prompt-panel') return PROMPT_PLACEHOLDER
  if (panelId === 'rules-panel') return RULES_PLACEHOLDER
  return SKILLS_PLACEHOLDER
}

/** 出错时覆盖掉占位里的「正在读取…」，不留假象。 */
function failPatch(panelId, error) {
  const msg = humanError(error)
  if (panelId === 'prompt-panel') {
    return {
      source: '读取失败',
      rule: '—',
      size: '—',
      time: '—',
      preview: `读取失败：${msg}`,
      note: '可以先点「刷新」再试一次。',
      result: msg,
      summary: `读取失败：${msg}`,
      previewField: `读取失败：${msg}`,
      sourceField: '读取失败',
    }
  }
  if (panelId === 'rules-panel') {
    return {
      active: '读取失败',
      count: '—',
      options: [],
      list: [],
      summary: `读取失败：${msg}`,
      hint: `读取失败：${msg}`,
    }
  }
  return {
    count: '—',
    same: '—',
    diff: '—',
    list: [],
    summary: `读取失败：${msg}`,
    hint: `读取失败：${msg}`,
  }
}

/**
 * 写操作之后，把「本面板的新字段」和「别的面板要跟着变的那几行」合成一个 patch 推出去。
 *
 * 注意：这里返回的是 **数据**，不是效果。延后效果里必须显式写成
 * `{ patch: <数据>, toast: '…' }` —— 单给一个数据对象会被当成「没有任何效果」丢掉。
 * result 放最后合并，免得被缓存值盖掉。
 */
async function refreshAll(panelId, result) {
  const key = placeholderKeyOf(panelId)
  const loader = loaderOf(panelId)
  try {
    // 三个面板的缓存一起丢掉：写完 / 刷新之后，别的面板那几行显示的是新值还是 4 秒前的旧值，
    // 取决于这里有没有丢干净。只丢自己那份的话，「刷新」按钮看起来就像没生效。
    dropCache('prompt', 'rules', 'skills')
    const [here, cross] = await Promise.all([
      Promise.resolve().then(loader),
      crossPatches(panelId),
    ])
    return { patch: { ...here, ...cross, result } }
  } catch (error) {
    caches.delete(key)
    const msg = toastText(`刷新失败：${humanError(error)}`)
    return { patch: { result: msg }, toast: msg }
  }
}

function placeholderKeyOf(panelId) {
  if (panelId === 'prompt-panel') return 'prompt'
  if (panelId === 'rules-panel') return 'rules'
  return 'skills'
}

function loaderOf(panelId) {
  if (panelId === 'prompt-panel') return collectPrompt
  if (panelId === 'rules-panel') return collectRules
  return collectSkills
}

/**
 * 面板上的「刷新」：原来回的是 `() => ({ refresh: true })`——那只是让视图重取一次，
 * 数据还走 4 秒缓存，等于没刷新。这里改成丢缓存 → 真读一遍 → 用 patch 把新数据推回面板。
 */
async function manualRefresh(panelId, event) {
  const text = loc(event) ? 'Refreshed' : '已刷新'
  const fresh = await refreshAll(panelId, text)
  return { ...fresh, toast: fresh.toast || text }
}

// ─────────────────────── 面板定义 ───────────────────────

function promptView() {
  return {
    type: 'stack',
    title: '提示词',
    children: [
      {
        type: 'keyValue',
        items: [
          ['路径', { $: 'data.path' }],
          ['大小', { $: 'data.size' }],
          ['来源', { $: 'data.source' }],
          ['当前规则', { $: 'data.rule' }],
          ['修改时间', { $: 'data.time' }],
        ],
      },
      { type: 'callout', text: { $: 'data.result' }, tone: 'info' },
      {
        type: 'text',
        text: {
          $: 'data.note',
        },
        tone: 'muted',
      },
      { type: 'text', text: { $: 'data.preview' } },
      { type: 'confirm', id: 'prompt-draft-save', confirmLabel: '写入注入', cancelLabel: '再想想' },
      { type: 'text', text: '「写入注入」把输入框里的文字存成注入文案（旧文件先备份）。', tone: 'muted' },
      { type: 'confirm', id: 'prompt-restore', confirmLabel: '恢复默认', cancelLabel: '再想想' },
      {
        type: 'actions',
        items: [
          { label: '复制当前文案', action: 'prompt-copy', icon: 'copy' },
          { label: '刷新', action: 'refresh', icon: 'refresh' },
        ],
      },
      { type: 'text', text: '「恢复默认」会用随包文案覆盖这个文件。', tone: 'muted' },
    ],
  }
}

function rulesView() {
  return {
    type: 'stack',
    title: '规则集',
    children: [
      {
        type: 'keyValue',
        items: [
          ['当前规则', { $: 'data.active' }],
          ['数量', { $: 'data.count' }],
          ['目录', { $: 'data.dir' }],
        ],
      },
      { type: 'callout', text: { $: 'data.hint' }, tone: 'info' },
      { type: 'options', id: 'switch-rule', options: { $: 'data.options' } },
      { type: 'actions', items: [{ label: '刷新', action: 'refresh', icon: 'refresh' }] },
      { type: 'list', items: { $: 'data.list' } },
      { type: 'text', text: '点上面任意一套即切换生效。', tone: 'muted' },
    ],
  }
}

function skillsView() {
  return {
    type: 'stack',
    title: '技能库',
    children: [
      {
        type: 'keyValue',
        items: [
          ['技能数', { $: 'data.count' }],
          ['与随包一致', { $: 'data.same' }],
          ['与随包不同', { $: 'data.diff' }],
          ['目录', { $: 'data.dir' }],
        ],
      },
      { type: 'callout', text: { $: 'data.hint' }, tone: 'info' },
      { type: 'actions', items: [{ label: '刷新', action: 'refresh', icon: 'refresh' }] },
      { type: 'list', items: { $: 'data.list' } },
    ],
  }
}

// ─────────────────────── 入口 ───────────────────────

export function apply(ctx) {
  // 只在装了 dsh-go 桥接的主机上出现（手机本机引擎有）；写 ['dshGo']，不写 ['dshGo?']。
  ctx.inject(['dshGo'], (ctx) => {
    // ── 胶囊「存为注入」：不在胶囊上直接写文件，而是打开面板由面板里的确认按钮来写。 ──
    // 这样「二次确认」用的是视图里的 confirm 组件（App 一定支持），输入框文字也只在
    // 用户在面板里按下「写入」时读一次。
    ctx.dshGo.on('prompt-draft-confirm', (scope, event) => ([
      { open: 'panel:prompt-panel' },
      { toast: loc(event) ? 'Confirm in the panel' : '在面板里点「写入」确认' },
    ]))

    // ── 面板 1：提示词 ──
    ctx.dshGo.panel('prompt-panel', {
      view: promptView,
      data: makeData('prompt-panel', 'prompt', collectPrompt),
      actions: {
        // 视图里的 confirm 组件：value 是 { confirmed: true|false }
        'prompt-draft-save': (scope, event) => {
          if (event?.value?.confirmed !== true) return { toast: loc(event) ? 'Cancelled' : '已取消' }
          const draft = String(scope?.draft || '')
          if (!draft.trim()) return { toast: '输入框是空的，先写点东西' }
          return {
            pending: { label: '正在写入…', timeoutMs: 60_000 },
            result: async () => {
              try {
                const out = await saveDraft(draft)
                const fresh = await refreshAll('prompt-panel', out.toast)
                return { toast: out.toast, ...fresh }
              } catch (error) {
                const msg = toastText(`存失败：${humanError(error)}`)
                return { toast: msg, result: msg }
              }
            },
          }
        },
        'prompt-restore': (scope, event) => {
          if (event?.value?.confirmed !== true) return { toast: loc(event) ? 'Cancelled' : '已取消' }
          return {
            pending: { label: '正在恢复默认…', timeoutMs: 60_000 },
            result: async () => {
              try {
                const action = await restoreDefault()
                const result = action === 'wrote' ? '已恢复随包默认' : `已按随包默认处理（${action}）`
                return await refreshAll('prompt-panel', result)
              } catch (error) {
                const msg = toastText(`恢复失败：${humanError(error)}`)
                return { toast: msg, result: msg }
              }
            },
          }
        },
        'prompt-copy': async (scope, event) => {
          try {
            const out = await copyPrompt()
            return out
          } catch (error) {
            return { toast: toastText(`复制失败：${humanError(error)}`) }
          }
        },
        refresh: (scope, event) => manualRefresh('prompt-panel', event),
      },
    })

    // ── 面板 2：规则集 ──
    ctx.dshGo.panel('rules-panel', {
      view: rulesView,
      data: makeData('rules-panel', 'rules', collectRules),
      actions: {
        'switch-rule': (scope, event) => {
          const id = String(event?.value?.value ?? event?.value ?? '')
          if (!id || id === '__none__' || id === '__loading__') {
            return { toast: loc(event) ? 'Nothing to switch' : '还没有规则集可切换' }
          }
          return {
            pending: { label: '正在切换规则…', timeoutMs: 60_000 },
            result: async () => {
              try {
                await switchRule(id)
                const fresh = await refreshAll('rules-panel', `已切到「${id}」`)
                return { toast: `已切到「${id}」`, ...fresh }
              } catch (error) {
                const msg = toastText(`切换失败：${humanError(error)}`)
                return { toast: msg, hint: msg }
              }
            },
          }
        },
        'rule-copy': async (scope, event) => {
          try {
            return await copyRule(String(event?.value?.rule || ''))
          } catch (error) {
            return { toast: toastText(`复制失败：${humanError(error)}`) }
          }
        },
        refresh: (scope, event) => manualRefresh('rules-panel', event),
      },
    })

    // ── 面板 3：技能库 ──
    ctx.dshGo.panel('skills-panel', {
      view: skillsView,
      data: makeData('skills-panel', 'skills', collectSkills),
      actions: {
        'skill-copy': async (scope, event) => {
          try {
            return await copySkill(String(event?.value?.skill || ''))
          } catch (error) {
            return { toast: toastText(`复制失败：${humanError(error)}`) }
          }
        },
        refresh: (scope, event) => manualRefresh('skills-panel', event),
      },
    })
  })
}
