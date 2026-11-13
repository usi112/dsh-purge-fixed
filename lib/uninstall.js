import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";
import * as hostctl from "./host.js";
import * as rules from "./rules.js";
import * as updater from "./update.js";
import { clearDrillGrant } from "./drill-grant.js";

export function wasApplied(state) {
  if (!state) return false;
  if (state.has_backup) return true;
  if (Number(state.patches_applied) > 0) return true;
  return [state.shim_cmd, state.shim_ps1, state.shim_bin].includes("patched");
}

export function shouldDeletePluginTree(dir, dshHome = core.findDshHome()) {
  if (!dir) return false;
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    real = path.resolve(dir);
  }
  const n = real.replace(/[/\\]+/g, "/").toLowerCase();
  if (n.includes("/node_modules/dsh-purge")) return true;
  let home;
  try {
    home = fs.realpathSync(dshHome);
  } catch {
    home = path.resolve(dshHome);
  }
  const homeN = home.replace(/[/\\]+/g, "/").toLowerCase();
  return n.startsWith(`${homeN}/profiles/`);
}

export function stripPluginFromPackage(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  let changed = false;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (pkg[key] && Object.prototype.hasOwnProperty.call(pkg[key], "dsh-purge")) {
      delete pkg[key]["dsh-purge"];
      changed = true;
    }
  }
  for (const key of ["bundles", "plugins"]) {
    if (!Array.isArray(pkg[key])) continue;
    const next = pkg[key].filter((item) => {
      if (typeof item === "string") return item !== "dsh-purge" && !item.startsWith("dsh-purge@");
      const id = item && (item.id || item.name);
      return id !== "dsh-purge";
    });
    if (next.length !== pkg[key].length) {
      pkg[key] = next;
      changed = true;
    }
  }
  return changed;
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(fp, value) {
  fs.writeFileSync(fp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pkgMentionsPurge(pkg) {
  if (!pkg) return false;
  if (pkg.dependencies?.["dsh-purge"] || pkg.devDependencies?.["dsh-purge"]) return true;
  for (const key of ["bundles", "plugins"]) {
    if (!Array.isArray(pkg[key])) continue;
    if (pkg[key].some((item) => {
      if (typeof item === "string") return item === "dsh-purge" || item.startsWith("dsh-purge@");
      return item && (item.id === "dsh-purge" || item.name === "dsh-purge");
    })) return true;
  }
  return false;
}

export function listInstalledProfiles(dshHome = core.findDshHome()) {
  const root = path.join(dshHome, "profiles");
  if (!fs.existsSync(root)) return [];
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const pkgPath = path.join(dir, "package.json");
    const pkg = readJson(pkgPath);
    const nm = path.join(dir, "node_modules", "dsh-purge");
    if (!pkgMentionsPurge(pkg) && !fs.existsSync(nm)) continue;
    const spec = pkg?.dependencies?.["dsh-purge"] || pkg?.devDependencies?.["dsh-purge"] || "";
    out.push({ name, dir, spec: String(spec || ""), pkgPath, hasModule: fs.existsSync(nm) });
  }
  return out;
}

async function unlinkIfExists(fp) {
  try {
    await fsp.unlink(fp);
    return true;
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
}

async function rmIfExists(fp) {
  try {
    await fsp.rm(fp, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function removeOverride(dshHome) {
  const fp = core.findOverrideFile(dshHome);
  const ok = await unlinkIfExists(fp);
  return { path: fp, removed: ok };
}

async function resetRules(dshHome) {
  const reset = await rules.resetToOriginal(dshHome);
  const dir = rules.rulesDir(dshHome);
  const removedDir = await rmIfExists(dir);
  return { ...reset, rules_dir: dir, rules_dir_removed: removedDir };
}

function collectCleanupDirs(profiles, dshHome) {
  const seen = new Set();
  const cleanup = [];
  const remember = (dir) => {
    if (!dir) return;
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      real = path.resolve(dir);
    }
    const key = real.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    cleanup.push(real);
  };

  for (const p of profiles) {
    const nm = path.join(p.dir, "node_modules", "dsh-purge");
    if (!fs.existsSync(nm)) continue;
    let real;
    try {
      real = fs.realpathSync(nm);
    } catch {
      real = path.resolve(nm);
    }
    if (shouldDeletePluginTree(real, dshHome)) remember(real);
    if (path.resolve(nm).toLowerCase() !== real.toLowerCase()) remember(nm);
  }

  const dataDir = path.join(dshHome, "dsh-purge");
  remember(dataDir);

  const root = updater.pluginRoot();
  if (shouldDeletePluginTree(root, dshHome)) remember(root);

  return cleanup;
}

function unregisterProfiles(profiles) {
  const stripped = [];
  const errors = [];
  for (const p of profiles) {
    try {
      const pkg = readJson(p.pkgPath) || {};
      if (stripPluginFromPackage(pkg)) {
        writeJson(p.pkgPath, pkg);
        stripped.push(p.name);
      }
    } catch (e) {
      errors.push({ profile: p.name, error: String(e && e.message ? e.message : e) });
    }
  }
  return { stripped, errors };
}

export async function uninstallPurge() {
  const state = await core.gatherState();
  const applied = wasApplied(state);
  const dshHome = state.dsh_home || core.findDshHome();
  const report = {
    ok: true,
    applied,
    reverted: false,
    needRestart: true,
    patches: null,
    shim: null,
    flash: null,
    override: null,
    rules: null,
    landed: null,
    landedOk: null,
    quarantine_root: "",
    quarantine_dirs: [],
    profiles: [],
    cleanup: [],
    errors: [],
  };

  try {
    if (state.ai_base) {
      report.patches = await core.revertAll(state.ai_base);
      if (applied) report.reverted = true;
    }
  } catch (e) {
    report.errors.push(`revert patches: ${e.message || e}`);
  }
  if (applied && (report.patches?.errors?.length || report.errors.some((e) => /^revert patches:/.test(e)))) {
    report.ok = false;
    report.needRestart = false;
    report.cleanup = [];
    return report;
  }

  try {
    report.shim = await core.revertAllShims();
    if (state.shim_cmd === "patched" || state.shim_ps1 === "patched" || state.shim_bin === "patched") {
      report.reverted = true;
    }
  } catch (e) {
    report.errors.push(`revert shims: ${e.message || e}`);
  }

  try {
    report.flash = core.revertCmdFlash(state.ai_base, dshHome);
  } catch (e) {
    report.errors.push(`revert flash: ${e.message || e}`);
  }

  try {
    report.override = await removeOverride(dshHome);
  } catch (e) {
    report.errors.push(`remove override: ${e.message || e}`);
  }

  try {
    report.rules = await resetRules(dshHome);
  } catch (e) {
    report.errors.push(`reset rules: ${e.message || e}`);
  }

  const profiles = listInstalledProfiles(dshHome);
  report.profiles = profiles.map((p) => p.name);
  const unreg = unregisterProfiles(profiles);
  report.stripped = unreg.stripped;
  report.errors.push(...unreg.errors.map((x) => `${x.profile}: ${x.error}`));
  if (unreg.errors.length) {
    report.ok = false;
    report.needRestart = false;
    report.cleanup = [];
    report.drillGrantCleared = false;
    return report;
  }

  try {
    report.drillGrantCleared = clearDrillGrant(dshHome);
  } catch (e) {
    report.ok = false;
    report.needRestart = false;
    report.cleanup = [];
    report.errors.push(`clear drill grant: ${e.message || e}`);
    return report;
  }

  // 落地文件清理：插件状态直接删，可能含用户内容的移进隔离目录（不静默删）。
  // 放在还原/反注册之后：任何一步失败都不动落地文件，与原有「插件文件未删除」语义一致。
  try {
    report.landed = await runLandedCleanup(dshHome, { profiles });
    report.landedOk = report.landed.ok;
    report.quarantine_root = report.landed.quarantine_created ? report.landed.quarantine_root : "";
    report.quarantine_dirs = report.landed.quarantine_dirs || [];
    report.errors.push(...report.landed.errors);
  } catch (e) {
    report.landedOk = false;
    report.landed = { ok: false, entries: [], errors: [messageOf(e)], log: [] };
    report.errors.push(`landed cleanup: ${messageOf(e)}`);
  }

  report.cleanup = collectCleanupDirs(profiles, dshHome);
  return report;
}

// ---------------------------------------------------------------------------
// 落地文件清理 / landed-file cleanup（1.1.71 卸载不彻底：$DSH_HOME 里留下落地件）
//
// 清理分两类，安全第一：
//   plugin_state —— 插件自有状态与可重建件：$DSH_HOME/dsh-purge/**、profile 里的
//                   .bin/dsh-purge shim、与随包副本逐字节一致的 skills/预设落地件。
//                   经过上面的判定后可以删。
//   user_content —— 可能承载用户内容：prompt-inject.md、$DSH_HOME/redteam/ 数据、
//                   $DSH_HOME/.agent-presets/redteam/。**默认移动到隔离目录**
//                   （$DSH_HOME/dsh-purge-uninstalled-<ts>/，保持原相对路径），
//                   只有证明「与插件内置默认/随包副本一致」才删；移动可在回收站里
//                   原样取回，绝不静默删除用户内容。
//
// 幂等：路径不存在记为 absent，不算错。异常不吞：进 report.errors 与 report.log，
// 并把该条记为 error（report.ok=false），其余条目继续走完。
// 官方 skills 目录（$DSH_HOME/skills/**，用户自己的 Skill）从设计上不删，只记 keep。
// ---------------------------------------------------------------------------

/** 插件自有状态目录（与 rules.js purgeStateDir / drill-grant.js 同一约定）。 */
const PURGE_STATE_DIRNAME = "dsh-purge";
/** 隔离目录前缀：$DSH_HOME/dsh-purge-uninstalled-<ts>/ */
const QUARANTINE_PREFIX = "dsh-purge-uninstalled-";
/** 演练台数据目录名。 */
const REDTEAM_DIRNAME = "redteam";
/** 演练台预设落地相对路径（lib/redteam/index.js + core.js 同一约定）。 */
const AGENT_PRESET_REL = [".agent-presets", "redteam"];
/** profile 里由 npm/pnpm 按 bin 字段建的 shim。 */
const PURGE_BIN_NAMES = ["dsh-purge", "dsh-purge.cmd", "dsh-purge.ps1"];
/**
 * redteam/ 下由随包 setup.sh 自己写的标记与日志（scripts/redteam-setup.sh 里
 * MARKER / LOG）：内容不含用户稿，属于可重建的插件状态，直接删。
 * 其余未知条目（toolkit/、engagements/、preset-declare.json …）一律隔离。
 */
const REDTEAM_PLUGIN_STATE = new Set([".setup-complete", "setup.log"]);

function messageOf(error) {
  return String(error && error.message ? error.message : error);
}

function safeLstat(target) {
  if (!target) return null;
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function isDirSync(target) {
  const st = safeLstat(target);
  return Boolean(st && st.isDirectory());
}

/** 隔离目录名：$DSH_HOME/dsh-purge-uninstalled-<YYYYMMDD-HHMMSS>，同名往后排号。 */
export function timestampSlug(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function quarantineDirFor(dshHome, stamp = timestampSlug()) {
  const home = path.resolve(String(dshHome ?? ""));
  const base = path.join(home, `${QUARANTINE_PREFIX}${stamp}`);
  let candidate = base;
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

/** 隔离目录清单：上次卸载留下的回收站，一律不碰（那是用户的恢复来源）。 */
export function listQuarantineDirs(dshHome) {
  const home = path.resolve(String(dshHome ?? ""));
  let names = [];
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(QUARANTINE_PREFIX))
    .map((n) => path.join(home, n))
    .filter(isDirSync)
    .sort();
}

/**
 * 拒绝危险 home：空值、根目录、层级太浅（/ 或 /root）、用户主目录本身。
 * 真机 /root/.dsh 与自测 /tmp/fake-home-* 都通过。
 */
export function assertSafeDshHome(dshHome) {
  const raw = String(dshHome ?? "").trim();
  if (!raw) throw new Error("refusing landed cleanup: DSH_HOME is empty");
  const home = path.resolve(raw);
  const root = path.parse(home).root;
  const segments = home.slice(root.length).split(path.sep).filter(Boolean);
  if (home === root || segments.length < 2) {
    throw new Error(`refusing landed cleanup: DSH_HOME is too shallow (${home})`);
  }
  if (home === path.resolve(os.homedir())) {
    throw new Error("refusing landed cleanup: DSH_HOME points at the user home directory");
  }
  return home;
}

/** 目标必须严格位于 home 之内；等于 home 或在外面的返回 ""。 */
function relInside(home, target) {
  const rel = path.relative(home, path.resolve(String(target ?? "")));
  if (!rel || path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) return "";
  return rel;
}

/** 插件包根：优先用 updater 记的那一份，失败再按本文件位置推。 */
function pluginPackageRoot() {
  try {
    const fromUpdater = updater.pluginRoot();
    if (fromUpdater && fs.existsSync(fromUpdater)) return fromUpdater;
  } catch {
    /* 落到下面 */
  }
  try {
    // fileURLToPath 而不是 URL.pathname：带空格 / 中文的安装路径会被百分号编码。
    return path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  } catch {
    return "";
  }
}

function bytesEqual(a, b) {
  try {
    const x = fs.readFileSync(a);
    const y = fs.readFileSync(b);
    return x.length === y.length && x.equals(y);
  } catch {
    return false;
  }
}

function fileEquals(a, b, normalize) {
  if (!normalize) return bytesEqual(a, b);
  try {
    return normalize(fs.readFileSync(a, "utf8")) === normalize(fs.readFileSync(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * 打包时 `{{REDTEAM_SKILLS_DIR}}` 由 lib/redteam/index.js 的 renderSkillsDir 换成
 * `!!js dshHomePath('redteam/skills')`，旧包名 tools 行也会被 renderToolsPackage 改写。
 * 比对落地预设前先把这两处机械改写归一化，避免「明明没改也被判成用户稿」。
 * 其它自愈改动（repairDelegation 等）不归一化 —— 判不一致时走隔离，宁保守不误删。
 */
function normalizePresetText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("{{REDTEAM_SKILLS_DIR}}").join("!!js dshHomePath('redteam/skills')")
    .split("dsh-redteam-mode/tools").join("dsh-purge/redteam/tools");
}

/** target 整棵树是否与随包副本一致（文件集合 + 内容）。符号链接一律判不一致。 */
function treeMatches(target, source, normalize) {
  const t = safeLstat(target);
  const s = safeLstat(source);
  if (!t || !s) return false;
  if (t.isDirectory() !== s.isDirectory()) return false;
  if (t.isFile()) return fileEquals(target, source, normalize);
  if (!t.isDirectory()) return false;
  let tn;
  let sn;
  try {
    tn = fs.readdirSync(target).sort();
    sn = fs.readdirSync(source).sort();
  } catch {
    return false;
  }
  if (tn.length !== sn.length || tn.some((n, i) => n !== sn[i])) return false;
  return tn.every((n) => treeMatches(path.join(target, n), path.join(source, n), normalize));
}

/**
 * 把 target 拆成「可删」与「要隔离」两类条目：整棵树与随包副本一致 → 删整棵；
 * 否则逐层下钻，只删一致的文件，把改过 / 多出来的东西隔离。
 */
function planRegenerable(target, source, normalize, kind, out) {
  if (!safeLstat(target)) return;
  if (!safeLstat(source)) {
    out.push({ path: target, action: "quarantine", kind: "user_content", reason: "no_bundled_copy_to_compare" });
    return;
  }
  if (treeMatches(target, source, normalize)) {
    out.push({ path: target, action: "delete", kind, reason: "matches_bundled_copy" });
    return;
  }
  const st = safeLstat(target);
  if (st.isFile()) {
    out.push({ path: target, action: "quarantine", kind: "user_content", reason: "differs_from_bundled_copy" });
    return;
  }
  if (!st.isDirectory()) {
    out.push({ path: target, action: "quarantine", kind: "user_content", reason: "not_a_plain_file" });
    return;
  }
  let names = [];
  try {
    names = fs.readdirSync(target);
  } catch (error) {
    out.push({ path: target, action: "error", kind: "user_content", reason: `unreadable: ${messageOf(error)}` });
    return;
  }
  if (!names.length) {
    out.push({ path: target, action: "delete", kind: "plugin_state", reason: "empty_dir" });
    return;
  }
  const nextSource = safeLstat(source) && safeLstat(source).isDirectory() ? source : "";
  for (const name of names) {
    planRegenerable(path.join(target, name), nextSource ? path.join(nextSource, name) : "", normalize, kind, out);
  }
}

function shimLooksLikeOurs(fp, st) {
  try {
    if (st.isSymbolicLink()) return /dsh-purge/i.test(fs.readlinkSync(fp));
    const text = fs.readFileSync(fp, "utf8");
    return /dsh-purge/i.test(text);
  } catch {
    return false;
  }
}

/** profile 的 node_modules/.bin 里属于本插件的 shim（与 profile 是否登记无关）。 */
function findPurgeBinShims(home) {
  const out = [];
  const profilesRoot = path.join(home, "profiles");
  let names = [];
  try {
    names = fs.readdirSync(profilesRoot);
  } catch {
    return out;
  }
  for (const profile of names) {
    for (const shimName of PURGE_BIN_NAMES) {
      const fp = path.join(profilesRoot, profile, "node_modules", ".bin", shimName);
      const st = safeLstat(fp);
      if (!st || (!st.isFile() && !st.isSymbolicLink())) continue;
      if (!shimLooksLikeOurs(fp, st)) {
        out.push({ path: fp, ours: false, reason: "shim_not_recognized" });
        continue;
      }
      out.push({ path: fp, ours: true, reason: `profile ${profile}` });
    }
  }
  return out;
}

/** 卸载前记一份状态快照（只读）：写进隔离清单当证据，不参与删/隔离判定。 */
function readStateSnapshot(stateDir) {
  const snapshot = { files: [], installed_rev: "", channel: "" };
  let names = [];
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    return snapshot;
  }
  snapshot.files = names.sort();
  try {
    snapshot.installed_rev = fs.readFileSync(path.join(stateDir, "installed-rev"), "utf8").trim();
  } catch {
    /* 缺失就留空 */
  }
  try {
    snapshot.channel = fs.readFileSync(path.join(stateDir, "channel.json"), "utf8").trim();
  } catch {
    /* 缺失就留空 */
  }
  return snapshot;
}

/**
 * 只读清点：卸载会在 $DSH_HOME 里动哪些路径、各自删还是隔离。不做任何改动。
 * @returns {{home: string, items: Array<{path: string, action: string, kind: string, reason: string}>, state: object}}
 */
export function planLandedCleanup(dshHome, options = {}) {
  const home = assertSafeDshHome(dshHome);
  const items = [];
  const pkgRoot = pluginPackageRoot();

  // 1) 插件自有状态目录：installed-rev / last-cwd.txt / override-state.json /
  //    drill-grant.json / channel.json / cwd-selections.json / workspace-policy.json …
  const stateDir = path.join(home, PURGE_STATE_DIRNAME);
  const state = readStateSnapshot(stateDir);
  items.push({ path: stateDir, action: "delete", kind: "plugin_state", reason: "plugin_state_dir" });

  // 2) prompt-inject.md：只删「就是插件内置默认（或空落地文件）」，用户改过一律隔离。
  const overrideFile = core.findOverrideFile(home);
  if (fs.existsSync(overrideFile)) {
    let text = "";
    let readable = true;
    try {
      text = fs.readFileSync(overrideFile, "utf8");
    } catch {
      readable = false;
    }
    if (!readable) {
      items.push({ path: overrideFile, action: "quarantine", kind: "user_content", reason: "unreadable" });
    } else {
      let bundled = "";
      try {
        bundled = core.normalizeOverride(core.defaultOverrideText());
      } catch {
        bundled = "";
      }
      const norm = core.normalizeOverride(text);
      if (!norm) {
        items.push({ path: overrideFile, action: "delete", kind: "plugin_state", reason: "empty_landing_file" });
      } else if (bundled && norm === bundled) {
        items.push({ path: overrideFile, action: "delete", kind: "plugin_state", reason: "equals_builtin_default" });
      } else {
        // 不再用 looksLikePluginDefault 兜底：那段标记是格式的一部分，
        // 用户在默认稿上改过也会带着它们，凭它删就会静默吃掉用户正文。
        items.push({ path: overrideFile, action: "quarantine", kind: "user_content", reason: "possibly_user_edited" });
      }
    }
  }

  // 3) $DSH_HOME/redteam/：随包技能与 setup.sh 一致才删；靶标 engagements/、
  //    声明文件等一律隔离（可能含用户内容）。
  const redteamDir = path.join(home, REDTEAM_DIRNAME);
  if (fs.existsSync(redteamDir)) {
    const pkgSkills = pkgRoot ? path.join(pkgRoot, "skills", "redteam") : "";
    const pkgSetup = pkgRoot ? path.join(pkgRoot, "scripts", "redteam-setup.sh") : "";
    let names = [];
    try {
      names = fs.readdirSync(redteamDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const child = path.join(redteamDir, name);
      if (name === "skills" && pkgSkills && fs.existsSync(pkgSkills)) {
        planRegenerable(child, pkgSkills, null, "plugin_state", items);
      } else if (name === "setup.sh" && pkgSetup && fs.existsSync(pkgSetup)) {
        planRegenerable(child, pkgSetup, null, "plugin_state", items);
      } else if (REDTEAM_PLUGIN_STATE.has(name)) {
        items.push({ path: child, action: "delete", kind: "plugin_state", reason: "bundled_setup_marker" });
      } else {
        items.push({
          path: child,
          action: "quarantine",
          kind: "user_content",
          reason: name === "engagements" ? "user_engagements" : "redteam_data_maybe_user_authored",
        });
      }
    }
  }

  // 4) $DSH_HOME/.agent-presets/redteam/：与随包预设（归一化占位符后）一致才删。
  const presetTarget = path.join(home, ...AGENT_PRESET_REL);
  if (fs.existsSync(presetTarget)) {
    const presetSource = pkgRoot ? path.join(pkgRoot, "presets", "redteam") : "";
    planRegenerable(presetTarget, presetSource, normalizePresetText, "plugin_state", items);
  }

  // 5) profile 的 bin shim：认不出属于本插件的一律保留（不误删别人家的 shim）。
  for (const shim of findPurgeBinShims(home)) {
    items.push(shim.ours
      ? { path: shim.path, action: "delete", kind: "bin_shim", reason: shim.reason }
      : { path: shim.path, action: "keep", kind: "bin_shim", reason: "shim_not_recognized" });
  }

  // 6) 官方 skills 目录：用户自己的 Skill 不删（README「卸载插件不删用户 Skill」）。
  const userSkills = path.join(home, "skills", REDTEAM_DIRNAME);
  if (options.reportUserSkills !== false && fs.existsSync(userSkills)) {
    items.push({ path: userSkills, action: "keep", kind: "user_content", reason: "official_skills_dir_left_alone" });
  }

  // 7) $DSH_HOME/.env：随包 setup.sh 会建/改它（ENV_FILE），但里面可能有用户自己加的
  //    变量甚至密钥 —— 既不删也不搬走（搬走会弄坏用户环境），只在日志里点名。
  const envFile = path.join(home, ".env");
  if (options.reportUserEnv !== false && fs.existsSync(envFile)) {
    items.push({ path: envFile, action: "keep", kind: "user_content", reason: "env_file_may_hold_user_secrets" });
  }

  return { home, items, state };
}

/** 目标已存在时排号，避免两次隔离互相覆盖。 */
function uniqueDest(qroot, rel) {
  const base = path.join(qroot, rel);
  if (!fs.existsSync(base)) return base;
  const dir = path.dirname(base);
  const name = path.basename(base);
  let candidate = "";
  for (let n = 2; ; n += 1) {
    candidate = path.join(dir, `${name}.${n}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** 移动（同盘 rename，跨盘退回「复制 + 删源」）。符号链接按链接本身搬。 */
async function movePath(src, dest) {
  try {
    await fsp.rename(src, dest);
    return;
  } catch (error) {
    const code = error && error.code ? error.code : "";
    if (!["EXDEV", "EPERM", "ENOTSUP", "EACCES"].includes(code)) throw error;
  }
  const st = safeLstat(src);
  if (!st) throw new Error(`source vanished before move: ${src}`);
  if (st.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(src), dest);
  } else if (st.isDirectory()) {
    await fsp.cp(src, dest, { recursive: true, force: true });
  } else {
    await fsp.copyFile(src, dest);
  }
  await fsp.rm(src, { recursive: true, force: true });
}

/** 只删空目录（非递归），从最深处往上；home 本身、隔离目录及其父链不动。 */
async function pruneEmptyDirs(home, dirs, quarantineRoot) {
  const pruned = [];
  const seen = new Set();
  const list = dirs
    .filter(Boolean)
    .map((d) => path.resolve(d))
    .filter((d) => {
      const rel = relInside(home, d);
      if (!rel) return false;
      if (quarantineRoot && path.resolve(d) === path.resolve(quarantineRoot)) return false;
      if (seen.has(d)) return false;
      seen.add(d);
      return true;
    })
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const dir of list) {
    try {
      await fsp.rmdir(dir);
      pruned.push(dir);
    } catch {
      /* 非空 / 不存在 / 没权限：都留着，不算错 */
    }
  }
  return pruned;
}

function restoreText(manifest) {
  const lines = [
    "dsh-purge 卸载隔离目录 / quarantine from dsh-purge uninstall",
    "",
    `清理时间 ${manifest.created_at}`,
    `DSH_HOME ${manifest.dsh_home}`,
    "",
    "这里放的是卸载时从 $DSH_HOME 移出来的、可能承载你自己内容的文件（没有删除）。",
    "确认不再需要后，整份删掉即可；要接着用，按原路径搬回去（下面每行的 → 左边是原路径）。",
    "",
  ];
  for (const entry of manifest.entries) {
    lines.push(`  $DSH_HOME/${entry.from}  →  ${entry.to}`);
    lines.push(`      ${entry.reason}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * 执行落地文件清理：插件状态与可重建件直接删，可能含用户内容的一律移进隔离目录。
 * 幂等、缺失不报错；异常不吞，进 errors/log。
 * @param {string} dshHome DSH_HOME（真机 /root/.dsh；自测用 /tmp/fake-home-*）
 */
export async function runLandedCleanup(dshHome, options = {}) {
  const report = {
    ok: true,
    dsh_home: "",
    quarantine_root: "",
    quarantine_created: false,
    manifest: "",
    entries: [],
    errors: [],
    log: [],
  };

  let plan;
  try {
    plan = planLandedCleanup(dshHome, options);
  } catch (error) {
    report.ok = false;
    report.errors.push(`landed cleanup: ${messageOf(error)}`);
    report.log.push(`✗ 拒绝清理：${messageOf(error)}`);
    return report;
  }

  const home = plan.home;
  report.dsh_home = home;
  const qroot = quarantineDirFor(home, options.stamp);
  report.quarantine_root = qroot;
  const touchedDirs = [];
  let quarantined = 0;

  for (const item of plan.items) {
    const entry = { path: item.path, action: item.action, kind: item.kind, reason: item.reason, result: "" };
    entry.rel = relInside(home, item.path);

    if (item.action === "keep") {
      entry.result = "kept";
      report.log.push(`· 保留 ${entry.rel}（${item.reason}）`);
      report.entries.push(entry);
      continue;
    }
    if (item.action === "error") {
      report.ok = false;
      entry.result = "error";
      report.errors.push(`landed cleanup: ${entry.rel || item.path}: ${item.reason}`);
      report.log.push(`✗ ${entry.rel || item.path}: ${item.reason}`);
      report.entries.push(entry);
      continue;
    }
    if (!entry.rel) {
      report.ok = false;
      entry.result = "error";
      report.errors.push(`landed cleanup: refusing path outside DSH_HOME: ${item.path}`);
      report.log.push(`✗ 拒绝 DSH_HOME 之外的路径：${item.path}`);
      report.entries.push(entry);
      continue;
    }
    if (!safeLstat(item.path)) {
      entry.result = "absent"; // 幂等：第二次跑就是这里
      report.entries.push(entry);
      continue;
    }

    try {
      if (item.action === "delete") {
        await fsp.rm(item.path, { recursive: true, force: true });
        entry.result = "deleted";
        touchedDirs.push(path.dirname(item.path));
        report.log.push(`✓ 删除 $DSH_HOME/${entry.rel}（${item.reason}）`);
      } else if (item.action === "quarantine") {
        const dest = uniqueDest(qroot, entry.rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await movePath(item.path, dest);
        entry.result = "quarantined";
        entry.dest = dest;
        entry.dest_rel = path.relative(qroot, dest).split(path.sep).join("/");
        quarantined += 1;
        touchedDirs.push(path.dirname(item.path));
        report.log.push(`→ 隔离 $DSH_HOME/${entry.rel} → ${path.basename(qroot)}/${entry.dest_rel}（${item.reason}，未删除，可恢复）`);
      } else {
        entry.result = "error";
        report.ok = false;
        report.errors.push(`landed cleanup: unknown action ${item.action} for ${entry.rel}`);
        report.log.push(`✗ 未知动作 ${item.action}：${entry.rel}`);
      }
    } catch (error) {
      report.ok = false;
      entry.result = "error";
      report.errors.push(`landed cleanup: ${entry.rel}: ${messageOf(error)}`);
      report.log.push(`✗ ${entry.rel}: ${messageOf(error)}`);
    }
    report.entries.push(entry);
  }

  if (quarantined > 0) {
    const manifest = {
      tool: "dsh-purge",
      kind: "uninstall-quarantine",
      created_at: new Date().toISOString(),
      dsh_home: home,
      plugin_version: (() => {
        try {
          return updater.localVersion();
        } catch {
          return "";
        }
      })(),
      installed_rev: plan.state?.installed_rev || "",
      state_files: plan.state?.files || [],
      entries: report.entries
        .filter((e) => e.result === "quarantined")
        .map((e) => ({ from: e.rel, to: e.dest_rel, reason: e.reason })),
      note: "卸载隔离：未删除任何可能属于用户的内容，确认无需后可整份删除。",
    };
    try {
      await fsp.mkdir(qroot, { recursive: true });
      report.manifest = path.join(qroot, "manifest.json");
      await fsp.writeFile(report.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await fsp.writeFile(path.join(qroot, "RESTORE.txt"), restoreText(manifest), "utf8");
      report.quarantine_created = true;
      report.log.push(`隔离清单：${report.manifest}`);
    } catch (error) {
      report.ok = false;
      report.errors.push(`landed cleanup manifest: ${messageOf(error)}`);
      report.log.push(`✗ 隔离清单写入失败：${messageOf(error)}`);
    }
  }

  const pruned = await pruneEmptyDirs(home, touchedDirs, qroot);
  report.pruned_dirs = pruned.map((d) => path.relative(home, d).split(path.sep).join("/"));
  for (const rel of report.pruned_dirs) report.log.push(`✓ 清掉空目录 $DSH_HOME/${rel}`);

  // 隔离目录是用户的恢复来源，明确记一笔，回归时不会被当成「残留」。
  const leftovers = listQuarantineDirs(home);
  report.quarantine_dirs = leftovers;
  for (const dir of leftovers) {
    report.log.push(`· 保留隔离目录 ${path.relative(home, dir)}（未删除，可恢复；确认后自行删除）`);
  }

  return report;
}

export function scheduleCleanupRestart(opts = {}) {
  hostctl.scheduleCleanupRestart(opts);
}
