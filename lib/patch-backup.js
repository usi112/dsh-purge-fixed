/**
 * 补丁备份层：写前快照 → manifest → 可校验还原。
 *
 * 为什么不继续只靠旁边的 .dshpurge.bak：
 * 1) .bak 是「旁挂」的，它不记录自己属于哪份宿主、哪一次 apply。两个 @deepseek-ai
 *    （web + 桌面剖面）同时在线时，拿 A 的 .bak 盖 B 的文件，谁也不知道；
 * 2) 一批文件改到一半失败，.bak 只能一条一条试，说不清「哪些回来了、哪些没回来」；
 * 3) 没有 sha256，还原完也没法断言「字节真的回到原样」，只能凭看起来像。
 *
 * 所以这里给每一次真实写盘做一份快照：manifest.json 记宿主根、表面、dsh 版本、
 * 每个文件的 sha256 与字节数；files/ 存原始字节；restore.sh 给没有 node 的场景兜底。
 *
 * 这一层只管「存 / 取 / 校验」，不判断补丁语义：写盘前后的事都留在 core.js。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

/** 快照目录名（在 $DSH_HOME/dsh-purge 下）。 */
const BACKUP_ROOT_NAME = "patch-backup";
const MANIFEST_NAME = "manifest.json";
/** manifest 版本号：以后字段有增删时，老备份还能被认出来。 */
export const BACKUP_SCHEMA = 1;
/** 宿主根之外的条目放这个前缀下（profile 里的 client.js 等）。 */
const EXTERNAL_PREFIX = "_external";

export function sha256Of(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 默认 $DSH_HOME：显式传 > 环境变量 > ~/.dsh。只看环境，不去猜宿主布局。 */
export function defaultHome(home = "") {
  if (home && String(home).trim()) return path.normalize(String(home).trim());
  const env = process.env.DSH_HOME;
  if (env && String(env).trim()) return path.normalize(env.trim());
  return path.join(os.homedir(), ".dsh");
}

export function backupRootDir(home = "") {
  return path.join(defaultHome(home), "dsh-purge", BACKUP_ROOT_NAME);
}

/** 根路径比较：Windows 大小写不敏感，去掉末尾分隔符。 */
export function normalizeRoot(root) {
  const p = path.normalize(String(root || ""));
  const trimmed = p.length > 1 ? p.replace(/[\\/]+$/, "") : p;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

export function sameRoot(left, right) {
  if (!left || !right) return false;
  return normalizeRoot(left) === normalizeRoot(right);
}

function stampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 同一秒内连续两次 apply 也不能互相覆盖，撞名就加 -2 / -3。 */
function uniqueStampDir(rootDir, stamp) {
  let dir = path.join(rootDir, stamp);
  let n = 2;
  while (fs.existsSync(dir)) {
    dir = path.join(rootDir, `${stamp}-${n}`);
    n += 1;
  }
  return dir;
}

/**
 * 文件在快照里的相对路径：宿主根内保持原相对结构（files/<包>/<文件>），
 * 根之外的（profile 里的 client.js、密封 bin）落到 _external/ 下，避免 .. 逃逸。
 */
export function relPathFor(root, fp) {
  const rel = path.relative(root, fp);
  if (rel && rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join("/");
  }
  const norm = String(fp).replace(/\\/g, "/").replace(/^\/+/, "");
  return `${EXTERNAL_PREFIX}/${norm.replace(/:/g, "_")}`;
}

/** 从宿主根里能读到的 dsh 版本；读不到就留空，别为了版本号把 apply 卡住。 */
export function detectDshVersion(root) {
  const candidates = [
    path.join(root, "dsh", "package.json"),
    path.join(root, "dsh", "node_modules", "@deepseek-ai", "dsh", "package.json"),
    path.join(root, "dsh-base", "package.json"),
  ];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (pkg && typeof pkg.version === "string" && pkg.version) {
        return { version: pkg.version, name: typeof pkg.name === "string" ? pkg.name : "", source: file };
      }
    } catch {
      /* 下一个候选 */
    }
  }
  return { version: "", name: "", source: "" };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * restore.sh：没有 node 时（宿主被换掉、CLI 起不来）还能用 bash 手还原。
 * 脚本自身也做 root 与 sha256 校验，行为和 restoreBackup 一致。
 */
function buildRestoreScript(manifest) {
  const root = manifest.root;
  const lines = [
    "#!/usr/bin/env bash",
    `# 由 dsh-purge 生成的补丁快照还原脚本（快照 ${manifest.created_at}）`,
    `# 宿主根 / root: ${root}`,
    `# 文件数 / files: ${manifest.file_count}`,
    "# 用法 / usage: bash restore.sh [目标宿主根]   例: bash restore.sh /tmp/host-fixture/node_modules/@deepseek-ai",
    "set -uo pipefail",
    'HERE="$(cd "$(dirname "$0")" && pwd)"',
    `ROOT="\${1:-${root}}"`,
    `EXPECT=${shellQuote(root)}`,
    'if [ "$(cd "$ROOT" 2>/dev/null && pwd)" != "$(cd "$EXPECT" 2>/dev/null && pwd)" ]; then',
    '  echo "rootMismatch: 备份属于 $EXPECT，不接受 $ROOT；拒绝还原" >&2',
    "  exit 2",
    "fi",
    "OK=0; SKIP=0; BAD=0",
  ];
  for (const entry of manifest.files) {
    const src = `${path.posix.join("files", entry.rel)}`;
    // 根外条目只能回它记录的绝对路径；根内条目跟着 $ROOT 走，换目录演练也成立。
    const dst = entry.external ? shellQuote(entry.path) : `"$ROOT"/${shellQuote(entry.rel)}`;
    lines.push(
      `# ${entry.rel}`,
      `SRC="$HERE"/${shellQuote(src)}`,
      `DST=${dst}`,
      `GOT="$(sha256sum "$SRC" 2>/dev/null | cut -d' ' -f1)"`,
      `if [ "$GOT" != ${shellQuote(entry.sha256)} ]; then echo "bad-backup $SRC" >&2; BAD=$((BAD+1))`,
      `elif [ "$(sha256sum "$DST" 2>/dev/null | cut -d' ' -f1)" = ${shellQuote(entry.sha256)} ]; then SKIP=$((SKIP+1))`,
      `else mkdir -p "$(dirname "$DST")"; cp -p "$SRC" "$DST" && OK=$((OK+1)) || { echo "write-failed $DST" >&2; BAD=$((BAD+1)); }`,
      "fi",
    );
  }
  lines.push(
    'echo "restored=$OK skipped=$SKIP failed=$BAD"',
    "[ \"$BAD\" -eq 0 ]",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * 写前快照。
 * @param {{root:string, files:Array<{path:string,data:Buffer}>, home?:string, surface?:string, reason?:string}} input
 *   只该传「这次真会改」的文件；没改的文件进快照等于制造噪音。
 * @returns {Promise<{dir:string, manifest:object}>}
 */
export async function createBackup(input = {}) {
  const root = path.normalize(String(input.root || ""));
  if (!root) throw new Error("createBackup: root 不能为空");
  let list = Array.isArray(input.files) ? input.files : [];
  list = list.filter((f) => f && f.path && Buffer.isBuffer(f.data));
  // 同一条路径只留第一份：多补丁命中同一文件时，第一份才是 apply 之前的原始字节。
  const seen = new Set();
  const entries = [];
  for (const f of list) {
    const fp = path.normalize(f.path);
    if (seen.has(fp)) continue;
    seen.add(fp);
    entries.push({ path: fp, data: f.data, rel: f.rel || relPathFor(root, fp) });
  }

  const rootDir = backupRootDir(input.home);
  await fsp.mkdir(rootDir, { recursive: true });
  const dir = uniqueStampDir(rootDir, stampNow());
  const filesDir = path.join(dir, "files");
  await fsp.mkdir(filesDir, { recursive: true });

  const manifestFiles = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const data = entry.data;
    const sha = sha256Of(data);
    totalBytes += data.length;
    // rel 已经把根外路径规整成 _external/…，这里不再区分：一律按 rel 落盘。
    const dst = path.join(filesDir, entry.rel.split("/").join(path.sep));
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.writeFile(dst, data);
    manifestFiles.push({
      path: entry.path,
      rel: entry.rel,
      sha256: sha,
      bytes: data.length,
      external: entry.rel.startsWith(`${EXTERNAL_PREFIX}/`),
    });
  }

  const manifest = {
    schema: BACKUP_SCHEMA,
    created_at: new Date().toISOString(),
    stamp: path.basename(dir),
    reason: String(input.reason || ""),
    root,
    surface: String(input.surface || ""),
    dsh_version: String(input.dshVersion || input.version || ""),
    file_count: manifestFiles.length,
    total_bytes: totalBytes,
    files: manifestFiles,
  };
  const manifestPath = path.join(dir, MANIFEST_NAME);
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  await fsp.rename(tmp, manifestPath);
  try {
    await fsp.writeFile(path.join(dir, "restore.sh"), buildRestoreScript(manifest), { mode: 0o755 });
  } catch {
    /* restore.sh 只是兜底，写不出来不影响 manifest 还原 */
  }
  return { dir, manifest };
}

/** 读一份 manifest，坏掉就返回 null，不让半截 JSON 把还原流程带偏。 */
export async function readManifest(dir) {
  try {
    const raw = await fsp.readFile(path.join(dir, MANIFEST_NAME), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema !== BACKUP_SCHEMA || !Array.isArray(parsed.files)) return null;
    if (!parsed.root) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 列出所有快照，最新的排在前面。
 * 只读 manifest，不读文件内容：面板 / CLI 调用它不该把宿主拖慢。
 */
export async function listBackups(options = {}) {
  const rootDir = backupRootDir(options.home);
  let names = [];
  try {
    names = await fsp.readdir(rootDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const dir = path.join(rootDir, name);
    let st;
    try {
      st = await fsp.stat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const manifest = await readManifest(dir);
    out.push({
      dir,
      stamp: name,
      mtime_ms: st.mtimeMs,
      ok: Boolean(manifest),
      root: manifest?.root || "",
      surface: manifest?.surface || "",
      dsh_version: manifest?.dsh_version || "",
      created_at: manifest?.created_at || "",
      file_count: manifest?.file_count ?? 0,
      total_bytes: manifest?.total_bytes ?? 0,
    });
  }
  // 目录名就是时间戳，同秒撞名带 -2，按名字倒序即可近似「最新在前」。
  out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  return out;
}

/** 某一份宿主根下最新的快照；跨宿主的快照绝不拿来用（那正是 rootMismatch 的来源）。 */
export async function latestBackupForRoot(root, options = {}) {
  const all = await listBackups(options);
  return all.find((b) => b.ok && sameRoot(b.root, root)) || null;
}

/** 备份条目的落盘路径（相对快照目录）。 */
function backupEntryPath(dir, rel) {
  return path.join(dir, "files", ...String(rel).split("/"));
}

/** 还原目标：根内条目按 root 重算，根外条目只能回到记录的绝对路径。 */
function restoreTargetPath(manifest, entry, root) {
  if (entry.external) return path.normalize(entry.path);
  return path.normalize(path.join(root, ...String(entry.rel).split("/")));
}

/**
 * 从快照还原。
 * 校验顺序：manifest 可读 → root 一致 → 备份字节 sha256 → 目标字节是否已经一致 → 写后再验一次。
 * 任一文件没过校验就计入 missed，其余文件照样还原（单条坏掉不连坐）。
 *
 * @param {string} dir 快照目录
 * @param {{root?:string, only?:Set<string>|Array<string>, dryRun?:boolean}} options
 * @returns {Promise<{ok:boolean, dir:string, reason:string, manifestRoot:string, rootMismatch:boolean,
 *   restored:string[], skipped:string[], missed:Array<{path:string,reason:string}>, dryRun:boolean}>}
 */
export async function restoreBackup(dir, options = {}) {
  const result = {
    ok: false,
    dir: String(dir || ""),
    reason: "",
    manifestRoot: "",
    rootMismatch: false,
    restored: [],
    skipped: [],
    missed: [],
    dryRun: options.dryRun === true,
  };
  const manifest = await readManifest(dir);
  if (!manifest) {
    result.reason = "manifest_unreadable";
    return result;
  }
  result.manifestRoot = manifest.root;
  const targetRoot = options.root ? path.normalize(String(options.root)) : path.normalize(manifest.root);
  if (!sameRoot(manifest.root, targetRoot)) {
    // 跨宿主还原一律拒绝：这份字节属于另一份 @deepseek-ai，照写就是把新宿主改成旧代码。
    result.reason = "root_mismatch";
    result.rootMismatch = true;
    return result;
  }
  const only = options.only == null
    ? null
    : new Set(Array.from(options.only).map((p) => path.normalize(String(p))));
  // except 给「启动自愈不许碰 client.js」这类例外用（#63：copy 会改 mtime）。
  const except = options.except == null
    ? null
    : new Set(Array.from(options.except).map((p) => path.normalize(String(p))));

  let bad = 0;
  for (const entry of manifest.files) {
    const target = restoreTargetPath(manifest, entry, targetRoot);
    if (only && !only.has(target)) continue;
    if (except && except.has(target)) continue;
    const src = backupEntryPath(dir, entry.rel);
    let srcBuf;
    try {
      srcBuf = await fsp.readFile(src);
    } catch {
      result.missed.push({ path: target, reason: "backup_missing" });
      bad += 1;
      continue;
    }
    if (sha256Of(srcBuf) !== entry.sha256) {
      result.missed.push({ path: target, reason: "backup_corrupt" });
      bad += 1;
      continue;
    }
    let current = null;
    try {
      current = await fsp.readFile(target);
    } catch {
      current = null;
    }
    if (current && sha256Of(current) === entry.sha256) {
      // 已经是原始字节：不写，别白改 mtime（client-hmr 会跟着重载）。
      result.skipped.push(target);
      continue;
    }
    if (result.dryRun) {
      result.restored.push(target);
      continue;
    }
    // tmp 名只算一次：清理也必须用同一个名字，否则失败时会留一个 .restore 残片在宿主里。
    const tmp = `${target}.${process.pid}.${Date.now()}.restore`;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(tmp, srcBuf);
      await fsp.rename(tmp, target);
    } catch (e) {
      try { await fsp.unlink(tmp); } catch { /* ignore */ }
      result.missed.push({ path: target, reason: `write_failed:${e && e.message ? e.message : e}` });
      bad += 1;
      continue;
    }
    const back = await fsp.readFile(target).catch(() => null);
    if (!back || sha256Of(back) !== entry.sha256) {
      result.missed.push({ path: target, reason: "sha256_mismatch_after_write" });
      bad += 1;
      continue;
    }
    result.restored.push(target);
  }
  result.ok = bad === 0;
  if (!result.ok) result.reason = "partial";
  return result;
}

/**
 * 还原后复核：确认清单里的文件现在真的是原始字节。
 * 调用方（core.applyPatches 的整批回滚）用它算 rollbackMissed。
 */
export async function verifyRestored(dir) {
  const manifest = await readManifest(dir);
  if (!manifest) return { ok: false, missed: [{ path: dir, reason: "manifest_unreadable" }], checked: 0 };
  const missed = [];
  for (const entry of manifest.files) {
    const target = restoreTargetPath(manifest, entry, manifest.root);
    const buf = await fsp.readFile(target).catch(() => null);
    if (!buf) {
      missed.push({ path: target, reason: "target_missing" });
      continue;
    }
    if (sha256Of(buf) !== entry.sha256) missed.push({ path: target, reason: "sha256_mismatch" });
  }
  return { ok: missed.length === 0, missed, checked: manifest.files.length };
}

export const patchBackupIo = {
  createBackup,
  restoreBackup,
  verifyRestored,
  listBackups,
  latestBackupForRoot,
  readManifest,
};
