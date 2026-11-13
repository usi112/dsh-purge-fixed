// local-purge-ui —— 在 dsh-go 原生界面里操作 dsh-purge。
//
// 为什么要有它：dsh-purge 自带的「清洗」页是 **Harness 网页版**的界面，手机 App 用的是
// Flutter 原生界面，所以那个页面在这台手机上看不到。这个本地小插件把同样的操作搬到原生界面：
//   · 输入框上方一个「清洗」胶囊 → 打开面板
//   · 面板里看状态（已清洗几条 / 注入文案 / 红队模式 / 宿主目录），一键「应用清洗」「还原」
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

let cachedState = null
let cachedAt = 0
const CACHE_MS = 20_000

const PLACEHOLDER = {
  state: '正在读取…',
  patches: '…',
  host: '…',
  inject: '…',
  redteam: '…',
  hint: '正在读取宿主状态…',
  summary: '正在读取状态…',
  why: [],
  detail: [],
}

/** 读一次状态；20 秒内重复打开面板直接用缓存（免得每次点开都等几秒）。 */
async function collectCached() {
  const now = Date.now()
  if (cachedState && now - cachedAt < CACHE_MS) return cachedState
  const value = await collect()
  cachedState = value
  cachedAt = Date.now()
  return value
}
/** 汇总成面板要推的数据（字段名与 view 里的 data.* 对应）。 */
async function collect() {
  const { core } = await loadPurge()
  return withPinnedHost(async (resolvedHost) => {
    const state = await core.gatherState()
    const hostFull = resolvedHost || String(state.ai_base || '')
    const hostOk = isRealHost(hostFull)
    const total = Number(state.patches_total) || 0
    const applied = Number(state.patches_applied) || 0
    const pending = Number(state.patches_pending) || 0
    const prompt = readPromptInfo()
    const redteam = readRedteamPhase()
    const marked = hostOk ? detectApplied(hostFull) : { backups: 0, approvalBypass: false }

    let injectText = '缺失'
    if (prompt.exists) {
      const custom = state.override_status && state.override_status !== 'default'
      injectText = `${custom ? '已自定义' : '随包默认'} · ${humanBytes(prompt.size)}`
    }

    const naCount = Number(state.patches_na) || 0
    const skippedCount = Number(state.patches_skipped) || 0
    const missingCount = Object.values(state.patch_status || {}).filter((v) => v === 'missing_file').length
    // patches_skipped 已经把 missing_file 算进去了，不要再加一次
    const notApplied = skippedCount || missingCount
    const patchesText = hostOk && total
      ? `${applied}/${total} 已生效 · 待 ${pending} · 不适用 ${naCount}`
      : '—'
    // 逐条明细：把分组行还原成「哪条 / 为什么没生效」，供面板列表显示。
    const statusById = state.patch_status || {}
    const nameById = new Map()
    for (const p of core.ALL_PATCHES || []) nameById.set(Number(p.id), String(p.name || `#${p.id}`))
    const reasonOf = (st) => (st === 'na' ? '本机不适用' : st === 'missing_file' ? '文件缺失' : '宿主已改写法')
    const rows = Array.isArray(state.display_patches) ? state.display_patches : []
    const detail = []
    for (const row of rows) {
      if (row.status === 'applied' || row.status === 'already') continue
      const ids = Array.isArray(row.ids) ? row.ids : [row.id]
      for (const id of ids) {
        const st = statusById[id] || row.status
        if (st === 'applied' || st === 'already') continue
        detail.push({ title: nameById.get(Number(id)) || `#${id}`, subtitle: reasonOf(st), tone: st === 'na' ? undefined : 'warn' })
      }
    }
    const detailShown = detail.slice(0, 20)
    const detailMore = detail.length > detailShown.length ? `…另有 ${detail.length - detailShown.length} 条` : ''

    const why = [
      { title: `宿主版本变了、找不到原文：${notApplied} 条`, subtitle: '这些补丁要替换的句子在 DSH 0.2.2-rc.1 里已改写法，搜索串对不上；不是失败。' },
      { title: `本机不适用：${naCount} 条`, subtitle: '面向桌面端 / Windows / 你没装的可选功能包（如 hooks-claude-code、preset-liangshen）。' },
      { title: `已生效：${applied} 条`, subtitle: '包含全部审批、沙箱、身份相关的补丁 —— 破甲靠的就是这些。' },
    ]
    if (detailMore) why.push({ title: detailMore, subtitle: '面板一次最多列 20 条，完整清单可用「复制状态」。' })
    let hint
    let stateText
    if (!hostOk) {
      stateText = '未定位宿主'
      hint = `⚠ 没定位到引擎正在用的宿主目录（${hostFull || '空'}），已停用「应用清洗」以免打到错的地方。`
    } else if (marked.approvalBypass) {
      stateText = '已应用'
      hint = '已应用补丁：审批提示被关掉、文件写入沙箱放开。重启引擎后生效；随时可点「还原」。'
    } else if (marked.backups > 0) {
      stateText = `半应用（${marked.backups} 个备份）`
      hint = `宿主里还留着 ${marked.backups} 个补丁备份，但审批直通没写进去 —— 可能是上次应用到一半。建议点「还原」再重来。`
    } else {
      stateText = '未应用'
      hint = '尚未应用：现在只有「提示词注入」在生效，审批提示仍然正常开着。'
    }

    const summary = [
      `真实状态：${stateText}`,
      `补丁计数：${patchesText}`,
      `宿主目录：${hostFull || '未定位'}${hostOk ? '' : '（不是可用宿主）'}`,
      `注入文案：${injectText}（${prompt.file}）`,
      `红队模式：${redteam.text}`,
    ].join('\n')

    return {
      state: stateText,
      patches: patchesText,
      why,
      detail: detailShown,
      host: hostFull || '未定位',
      inject: injectText,
      redteam: redteam.text,
      hint,
      summary,
    }
  })
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
  return String(event?.locale || '').startsWith('en')
}

export function apply(ctx) {
  // 只在装了 dsh-go 桥接的主机上出现（手机本机引擎有）；写 ['dshGo']，不写 ['dshGo?']。
  ctx.inject(['dshGo'], (ctx) => {
    // 胶囊：点一下直接开面板
    ctx.dshGo.on('purge-open', () => ({ open: 'panel:purge-panel' }))

    ctx.dshGo.panel('purge-panel', {
      view: () => ({
        type: 'stack',
        title: 'dsh-purge 清洗',
        children: [
          {
            type: 'keyValue',
            items: [
              ['真实状态', { $: 'data.state' }],
              ['补丁计数', { $: 'data.patches' }],
              ['宿主目录', { $: 'data.host' }],
              ['注入文案', { $: 'data.inject' }],
              ['红队模式', { $: 'data.redteam' }],
            ],
          },
          { type: 'callout', text: { $: 'data.hint' }, tone: 'info' },
          { type: 'confirm', id: 'apply', confirmLabel: '应用清洗', cancelLabel: '再想想' },
          {
            type: 'actions',
            items: [
              { label: '还原', action: 'revert', icon: 'restart' },
              { label: '刷新', action: 'refresh', icon: 'refresh' },
              { label: '复制状态', action: 'copy-status', icon: 'copy' },
            ],
          },
          { type: 'list', items: { $: 'data.why' } },
          { type: 'text', text: '没生效的逐条明细', tone: 'muted' },
          { type: 'list', items: { $: 'data.detail' } },
          { type: 'text', text: '应用后需重启引擎才生效。', tone: 'muted' },
        ],
      }),

      data: (scope, emit) => {
        let dead = false
        emit(cachedState || PLACEHOLDER)
        collectCached()
          .then((value) => { if (!dead) emit(value) })
          .catch((error) => {
            if (dead) return
            emit({
              patches: '—',
              host: '—',
              inject: '—',
              redteam: '—',
              hint: `读取状态失败：${String(error && error.message ? error.message : error)}`,
              summary: '读取状态失败',
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
                const patch = await collect()
                const naTotal = r.skipped + r.na + r.missing
                const tail = naTotal > 0 ? ` · 不适用 ${naTotal} 条` : ''
                return {
                  toast: `已生效 ${r.applied} 条${tail} · 重启引擎后生效`,
                  patch,
                }
              } catch (error) {
                const patch = await collect().catch(() => undefined)
                const msg = String(error && error.message ? error.message : error)
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
              const patch = await collect()
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

        refresh: () => ({ refresh: true }),

        'copy-status': async (scope, event) => {
          try {
            const value = await collectCached()
            const text = `${value.summary}\n\n${value.hint}`
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
