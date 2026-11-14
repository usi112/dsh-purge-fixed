/**
 * 写库前的校验与规范化（零依赖）。
 *
 * 从 core.js 抽出来的模块：这些函数决定"什么值允许进库"，
 * 是安全边界所在（路径穿越、非法枚举），值得单独一处、单独读、单独测。
 */

import { dirname, resolve, sep } from 'node:path'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'

export const WEBSHELL_TYPES = ['behinder', 'godzilla', 'antSword', 'antsword', 'custom']
export const WEBSHELL_STATUSES = ['online', 'offline', 'dead', 'unknown']

/**
 * 规范化马类型：大小写不敏感、允许中文别名（冰蝎/哥斯拉/蚁剑）。
 * 认不出就抛错而不是静默存原文 —— 面板的"用户连不上"红标、会话页的连接口令复制
 * 都按这个字段判断，存进去一个拼错的值不会报错，只会让这两处判定静默失效。
 * @param value - 原始值（可为空）。
 * @returns 规范化后的值或 null（空值合法 = 未声明）。
 */
export function normalizeShellType(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim()
  if (raw === '') return null
  const lower = raw.toLowerCase()
  if (/behinder|冰蝎/.test(lower)) return 'behinder'
  if (/godzilla|哥斯拉/.test(lower)) return 'godzilla'
  if (/antsword|蚁剑/.test(lower)) return 'antSword'
  if (lower === 'custom' || lower === 'custom-shell' || /自定义|自研/.test(raw)) return 'custom'
  throw new Error("webshell shell_type 非法：" + JSON.stringify(value)
    + '。交付要求是**冰蝎马（behinder）/ 哥斯拉马（godzilla）**（用户要能自己连上）；'
    + '其它类型请填 custom（只作临时中转，面板会标"用户连不上"）。')
}

/** 规范化马状态（界面按 online/offline/unknown 三态显示）。 */
export function normalizeShellStatus(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
  const aliases = { up: 'online', alive: 'online', down: 'offline', failed: 'offline', removed: 'dead' }
  const normalized = aliases[raw] || raw
  if (normalized === '') return 'online'
  if (!WEBSHELL_STATUSES.includes(normalized)) {
    throw new Error("webshell status 非法：" + JSON.stringify(value) + "。合法值只有 " + WEBSHELL_STATUSES.join(" / ") + "。")
  }
  return normalized
}


/**
 * 路径必须在允许的根目录内（防目录穿越）。
 *
 * 为什么需要：`readAttackFile` / `pocGet` 读的是**数据库里的 path 列**，
 * 而那个列是智能体自己经 `addAttackFile` / `savePoc` 写进去的 —— 也就是不可信输入。
 * 一旦填成 `/etc/passwd` 或 `~/.ssh/id_rsa`，面板点一下就把文件读到浏览器里了。
 * `deletePoc` 早有 startsWith 防护，读路径与写路径却漏了，这里补成一处共用实现。
 * @param target - 待校验的路径。
 * @param allowedRoots - 允许的根目录（数组）。
 * @returns 规范化后的绝对路径。
 * @throws 越界时抛错（调用方按"查不到"处理，不要静默返回内容）。
 */
export function assertPathWithin(target, allowedRoots) {
  const abs = resolve(String(target || ""))
  const roots = (allowedRoots || []).filter((r) => typeof r === "string" && r !== "").map((r) => resolve(r))
  const okFlag = roots.some((root) => abs === root || abs.startsWith(root + sep))
  if (!okFlag) {
    throw new Error("path outside allowed roots: " + abs
      + "（允许的根：" + roots.join(", ") + "）。这条记录的文件路径不在本靶标目录内，已拒绝读取。")
  }
  return abs
}

/**
 * 原子写文本（F6）：tmp → rename。截断写遇到断电/ENOSPC 会留下半截文件，
 * 状态文件半截的后果是「下次启动把它当空配置，再把整份覆盖掉」。
 * @param file - 目标路径。
 * @param text - 内容。
 */
export function writeTextAtomic(file, text) {
  const target = String(file || '')
  if (!target) throw new Error('writeTextAtomic: empty path')
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`
  try {
    writeFileSync(tmp, String(text), 'utf8')
    /* 留上一版好文件，坏 JSON 时还能捞回来（同目录，成本只有一份 KB 级副本）。 */
    try { if (existsSync(target)) copyFileSync(target, `${target}.bak`) } catch { /* 备份失败不挡写入 */ }
    renameSync(tmp, target)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
  return target
}

/** 原子写 JSON（缩进 2 + 结尾换行，与既有文件格式保持一致）。 */
export function writeJsonAtomic(file, value) {
  return writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

/**
 * 解析坏掉的 JSON 文件时调用：先把坏文件另存为 `.corrupt-<时间戳>`，
 * 再尝试从 `.bak` 恢复上一次的好内容。返回恢复出来的值或 null。
 */
export function recoverCorruptJson(file) {
  const target = String(file || '')
  if (!target) return null
  try {
    if (existsSync(target)) copyFileSync(target, `${target}.corrupt-${Date.now()}`)
  } catch { /* 隔离失败也要继续试 .bak */ }
  try {
    const bak = `${target}.bak`
    if (!existsSync(bak)) return null
    const parsed = JSON.parse(readFileSync(bak, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}
