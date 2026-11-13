# dsh-purge 1.1.76+upstream.1.1.71 — a fixed fork of upstream 1.1.71

This is a fork I put together for my own phone. Upstream [dsh-purge](https://deepseek.stream/plugins/dsh-purge)
is by 小杨 (MIT) and works on desktop; on DSH Go (Android + proot) it broke the moment it was installed.
I fixed what broke, and added native UI plugins because the web UI simply doesn't exist inside the Flutter app.

Two different things live in this plugin, and they behave differently:

- **Prompt injection** — a persona and rule block written into the system prompt each turn, so the model
  refuses less. Active as soon as it is installed.
- **Code patches (84)** — optional rewrites of the DSH source tree that remove approval prompts and the
  sandbox's file-write restriction. You have to run `--apply` yourself.

Tested on: DSH Go app 1.0.15, DSH 0.2.2-rc.1, Node 24.22.1, proot Ubuntu 24.04. Desktop and web install
fine, but were not tested as hard.

Version `1.1.76+upstream.1.1.71`: the part after `+` is the upstream release this fork is based on; the
leading number is this fork's own release counter. They are not the same thing. Rules and examples live in
[docs/versioning.md](docs/versioning.md); wording or doc-only changes do not bump the version.

Upstream credit and the original LICENSE are kept. The original repo `YuJunZhiXue/dsh-purge` is currently
unreachable, so every change is listed in [CHANGELOG-fixes.md](CHANGELOG-fixes.md) as the upstream
attribution policy requires. No jailbreak rule text was modified in this fork.

## Read this before you install

- It is a jailbreak plugin: it suppresses refusals through the system prompt.
- `--apply` rewrites DSH source files. After that, DSH stops asking for approval and stops blocking writes
  you never read first.
- One consequence: the model can overwrite files it never read. That is what one of the patches is for,
  not a bug.
- Every changed file gets a `<filename>.dshpurge.bak`; `--revert` restores byte-for-byte.
- Do not use it on a machine holding data you care about.

## Why the mobile port needed work

1. Upstream writes `{{cwd}}` into the prompt; 0.2.2-rc.1 only registers `provider` and `model`, so every
   turn died with an unknown-variable error.
2. Two red-team preset rows did not match the new host, the whole preset was marked broken, and the mode
   disappeared from the picker.
3. The plugin UI is a web UI, and DSH Go is Flutter-native, so there was nothing to look at.

The first two were text fixes. The third needed new plugins, which is what `native-ui/` is.

## What changed since 1.1.71

One crash plus a pile of drift caused by the newer host. 11 files in total, listed one by one in
CHANGELOG-fixes.md. The short version:

- all five `{{cwd}}` occurrences handled: real path when available, static text otherwise
- `postPrompt` no longer goes through host interpolation
- escaping had a boundary bug (`{{{cwd}}}` slipped through); now judged per brace run
- red-team preset: dead rows removed, the leaf constraint moved to `maxDepth`
- self-heal no longer inserts the same line twice
- six patches that no longer matched got new anchors taken from the real source
- version declaration moved from `dshTarget` to `engines.dsh`, so incompatibility shows at install time
- uninstall leaves nothing behind; your own files go to a quarantine directory with `RESTORE.txt`
- revert removes `.bak` files that are byte-identical to the original
- zip paths use posix separators, so Android does not flatten the tree

## Environment

Node >= 22, DSH `>=0.2.1-rc.2 <0.3.0-0`. On the phone: `DSH_HOME=/root/.dsh`, engine under `/opt/dsh`.

## Install A: Desktop / Web

```sh
# from the unpacked directory
dsh plugin --profile web add ./

# confirm you got this build
md5sum "$DSH_HOME/profiles/web/node_modules/dsh-purge/lib/core.js"
# expect: 66479dbe1716c69ade88ac851331b19a
```

Then **restart DSH**.

## Install B: DSH Go (Android)

Three things differ from desktop:

1. The engine runs inside **proot**: `DSH_HOME=/root/.dsh`, engine at `/opt/dsh`.
2. **The DSH Go app has no terminal page**, and its plugin page only installs npm packages from the
   marketplace → **the install commands must be run by the agent inside DSH** (or any shell that can
   reach that proot).
3. The native UI requires the **dsh-go bridge** (built into the local engine; usually absent on remote hosts).

```sh
# have the DSH agent run these, after unpacking the archive into phone storage
cd /sdcard/Download/<unpacked-dir>
dsh plugin --profile web add ./

md5sum "$DSH_HOME/profiles/web/node_modules/dsh-purge/lib/core.js"
# expect: 66479dbe1716c69ade88ac851331b19a
```

Then **restart the engine** (App → Engine → Restart).

### Native mobile UI (optional)

The web UI is invisible on the phone, so these two plugins put the same information into the native app:

- `local-purge-ui` — a "Purge" button above the input plus a status strip. Tap it to see which patches
  did not land and why; apply or revert from the same panel.
- `local-purge-more` — a "Purge content" button with three panels: prompt, rules, skills.

```sh
mkdir -p "$DSH_HOME/dsh-go/plugins"
cp -a native-ui/local-purge-ui native-ui/local-purge-more "$DSH_HOME/dsh-go/plugins/"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-purge-ui"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-purge-more"
```

They install as `link:`, so keep the directories around. Restart the engine and the two buttons show up.

They only render UI and read/write local files; they never rewrite host code on their own. "Apply" asks for
a second confirmation and does the same thing as `dsh-purge --apply`.

---

## Usage

```sh
dsh-purge --status      # show state: which patches are applied, inject file status
dsh-purge --apply       # enable code-level patches (rewrites host source, keeps .bak)
dsh-purge --revert      # restore the host byte-for-byte
dsh-purge --uninstall   # uninstall (your content is quarantined, not deleted)
dsh-purge --edit        # edit the inject text
```

**Important**: after `--apply` you **must restart DSH** (the engine reads source into memory at startup).
Disabling the plugin in the app does **not** undo the patches — they are on-disk changes; use `--revert`.

```sh
dsh-purge --status --json   # machine-readable: patch_tally (7 categories + na + total) and per-patch rows
dsh-purge --check           # dry run: what apply would touch, and which patches no longer match
```

---

## Patch status

Every patch is classified from all of its target files, then summed into one snapshot (`patch_tally`).
The CLI, the phone panel and the status strip all read that same snapshot, so they cannot disagree.

| Status | Meaning | What it used to be called |
|---|---|---|
| `applied` | Already patched; nothing to do | `applied` |
| `pending` | Original text still there; not applied yet | `pending` |
| `partial` | Multi-file patch only landed on some files | `skipped` (partly applied) |
| `drifted` | The file was changed elsewhere; re-applying now would conflict | did not exist |
| `no_needle` | File readable, but the sentence to replace is gone | `skipped`, `unmatched` |
| `no_file` | Target file registered but unreadable right now | `missing_file` |
| `no_pkg` | This machine simply does not ship the package | `missing_file` |
| `na` | Not needed here (separate bucket, still counted in the total) | `na` |

The old six names did not disappear; `skipped` was split into `partial` / `drifted` / `no_needle`, and
`missing_file` into `no_file` / `no_pkg`. One "skipped" used to cover four very different situations:
re-apply, half-applied, version drift, package absent.

Legacy fields (`patches_applied`, `patches_pending`, `patches_skipped`, `patches_na`, `patches_total`,
`patch_status`, `display_*`) keep their old values, so existing scripts still read.

### Why a patch did not land

Each patch also carries a `reason` and an `advice`. Both are built by `explainPatchRow()` in
`lib/patch-report.js` from the row's own data: how many files fall into each bucket, which files they are,
and what the patch itself declares (`strictFiles` / `softSettle` / `kind`). If something cannot be derived
— a host version, say — it is left out rather than guessed.

Patches are also grouped by layer (identity / approval / sandbox / tools / UI / other) in the phone panel,
one header line per layer with `applied/total` plus up to six rows per layer.

### Apply receipt and one-command regression

- `gatherState().patch_receipt` — what the last apply actually did: timestamp, origin, files touched
  (≤20 shown + total), counts, whether it had to roll back, and the backup directory. Built only from
  the newest manifest plus current bytes on disk; `null` with a reason when there is nothing to report.
- `node scripts/patch-regression.mjs --host <…>/node_modules/@deepseek-ai` — hash the tree, apply,
  revert, compare byte-for-byte, apply again and compare for idempotency. Refuses any path under
  `/opt/`, prints PASS/FAIL with a failing-file list, and `--json` for machines.

---

## Uninstall / revert

```sh
dsh-purge --revert       # restore host code first
dsh-purge --uninstall    # then uninstall the plugin
dsh plugin --profile web remove dsh-purge
```

`--uninstall` **never silently deletes your content**:
- Plugin-owned state (`$DSH_HOME/dsh-purge/`) → deleted
- Your edited `prompt-inject.md`, your own skills/presets → moved to
  `$DSH_HOME/dsh-purge-uninstalled-<timestamp>/` with `manifest.json` and `RESTORE.txt`

---

## FAQ

**Q: After restarting, every turn reports `unknown prompt variable`.**
The profile's system-prompt config still carries a variable the host doesn't register. Force a reinstall:

```sh
dsh plugin --profile web remove dsh-purge
dsh plugin --profile web add ./
md5sum "$DSH_HOME/profiles/web/node_modules/dsh-purge/lib/core.js"
```
(`pnpm` sometimes skips reinstalling from the same path, hence the remove first.)

**Q: Red-team mode is not in the mode picker.**
Check `$DSH_HOME/redteam/preset-declare.json` — `ok` should be `true`; the `broken` field names the
offending row.

**Q: I ran `--apply` and want to undo it.**
`dsh-purge --revert`, then restart.

**Q: I disabled the plugin but the patches are still active.**
Disabling only stops the plugin from loading. Patches rewrite host source and require `--revert`.

---

## Credits & license

- **Original project**: `dsh-purge` · author **小杨** · MIT License (see [LICENSE](LICENSE))
- **Original repo**: `https://github.com/YuJunZhiXue/dsh-purge` (currently unreachable)
- Upstream requires attribution when reusing its name, ideas, code or prompts. This fork therefore keeps
  the original LICENSE verbatim and credits the author at the top of this README and in the changelog.
- Fixes in this fork are released under the same MIT terms. **Upstream's disclaimers and
  compliance-use statements still apply** — see [README.upstream.zh-CN.md](README.upstream.zh-CN.md).

## Upstream docs

The complete upstream documentation (UI preview, how it works, red-team workbench) is preserved:
- [README.upstream.md](README.upstream.md) (English)
- [README.upstream.zh-CN.md](README.upstream.zh-CN.md) (Chinese)
- [release-notes.md](release-notes.md) (version history)
