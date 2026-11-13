# dsh-purge 1.1.73 — Fixed Fork · Built for DSH Go

> 📱 **This fork is adapted and verified for [DSH Go] — the mobile DSH client (Android + proot Ubuntu).**
> Every fix and test was done on a real DSH Go phone (App 1.0.15 / DSH 0.2.2-rc.1 / Node 24.22.1),
> and it ships two **native mobile UI** plugins — the upstream release only has a *web* UI, which is
> invisible inside the Flutter-native DSH Go app.
> Desktop / Web works too, but was not tested as thoroughly.
>
> 🌐 [中文说明](README.md)

> **Derived from [`dsh-purge`](https://deepseek.stream/plugins/dsh-purge) 1.1.71, originally by 小杨 (MIT License).**
> The original repo `YuJunZhiXue/dsh-purge` is currently unreachable. This fork keeps the original
> `LICENSE` and author credit, as the upstream project's attribution policy requires.
> Every change is listed in [CHANGELOG-fixes.md](CHANGELOG-fixes.md).
>
> **This fork only contains compatibility and crash fixes — no jailbreak rule text was modified**
> (persona, the 18 scoped-rule groups, `Never Refuse`, refusal-phrase blocklists, house rules: all unchanged).

A [DeepSeek Harness](https://www.deepseek.com/harness/) (DSH) plugin. It does two things —
**please understand them separately**:

| | What | Default |
|---|---|---|
| **① Prompt injection** | Writes a "persona + rules" block into the system prompt each turn, so the model refuses less and answers more directly | **Active once installed** |
| **② Code-level patches (82)** | Rewrites DSH source files on disk: approval prompts → "never ask", approval requests auto-granted, sandbox `(deny file-write*)` → `(allow file-write*)`, etc. | **Disabled by default**, requires `--apply` |

---

## ⚠️ Read this before installing

1. **This is a jailbreak plugin.** It suppresses the model's refusal tendency through the system
   prompt and ships 18 scoped-rule groups.
2. **`--apply` rewrites DSH source files.** Once enabled: DSH will **not** ask for approval before
   dangerous operations, and will no longer block "overwrite a file you never read".
3. **The model may silently overwrite files it never read.** That is the stated goal of patch
   `FS_OBSERVATION_INTENT_FREE`, not a bug.
4. Every modified file gets a `<filename>.dshpurge.bak` backup; `--revert` restores **byte-for-byte**.
5. **Use it only on your own machine, at your own risk.** Do not enable the code patches on a machine
   holding important data or subject to compliance auditing.

---

## Why "built for DSH Go"

Upstream 1.1.71 was written for desktop. Moving it to DSH Go (mobile) surfaces three classes of problems,
all addressed here:

| Mobile problem | Symptom | Fix in this fork |
|---|---|---|
| **Different host version** | Upstream writes `{{cwd}}`, which DSH 0.2.2-rc.1 rejects → **every turn fails** | Replaced everywhere: real path or a static sentence |
| **Red-team preset disappears** | Two preset rows are incompatible with the new host → whole preset marked broken → hidden from the app's mode picker | Removed the dead rows; leaf constraint now handled by `maxDepth` |
| **No UI on mobile** | Upstream UI is a **web** UI; DSH Go ships a Flutter-native UI, so nothing shows | New `native-ui/` plugins: **2 capsules + 4 panels** |

Mobile paths also differ from desktop — see "Install B" for real measured values
(`DSH_HOME=/root/.dsh`, engine at `/opt/dsh`, and **the app has no terminal page**).

---

## What was fixed (vs. 1.1.71)

Upstream crashes **immediately after install** on DSH 0.2.2-rc.1 — every turn fails with
`unknown prompt variable "{{cwd}}"`. This fork changes **11 files** (details in
[CHANGELOG-fixes.md](CHANGELOG-fixes.md)):

| # | Problem | Impact | Fix |
|---|---|---|---|
| 1 | Writes `{{cwd}}` into the system prompt, but the host only registers `provider` / `model` | **Every conversation turn fails** | 5 sites: real path, or a fixed sentence |
| 2 | The `postPrompt` section is interpolated by the host | Any `{{...}}` in user `postPrompt` crashes too | Escape before handing to the host |
| 3 | Escaping had a boundary bug | `{{{cwd}}}`, `{{{{model}}}}` still slipped through | Rewritten as whole-brace-run detection with a final invariant |
| 4 | Two red-team preset rows are incompatible with the new host | **Red-team mode vanished from the picker** | Dead rows removed; `maxDepth: 1` keeps the leaf constraint |
| 5 | Self-heal inserted a duplicate line | Same instruction appeared twice | Marker matching now accepts escaped/unescaped |
| 6 | 6 patches no longer matched source | Silently inert (escalation, read/write bypass, complete-preset inject, …) | Anchors and markers rewritten against the new host |
| 7 | Version gate used `dshTarget` | Crashed at runtime instead of failing at install | Now `engines.dsh` range |
| 8 | Uninstall left residue | Inject file, skill library, preset dir remained | Own files deleted; **possibly-yours moved to a quarantine dir** with `RESTORE.txt` |
| 9 | Revert left stray backups | `.dshpurge.bak` files remained | Identical backups cleaned up |
| 10 | Zip distribution used backslash paths | Flattened when unpacked on Android/Linux | Repacked with posix paths |

Plus the optional `native-ui/` mobile plugins (not part of upstream).

---

## Verified environments

| Platform | Measured |
|---|---|
| **DSH Go (mobile)** | App **1.0.15** · DSH **0.2.2-rc.1** · Node **24.22.1** · proot Ubuntu 24.04 · `DSH_HOME=/root/.dsh` |
| Desktop / Web | DSH **0.2.2-rc.1** · Node **24.22.1** |

Requirements: **Node >= 22**, DSH `>=0.2.1-rc.2 <0.3.0-0`.

---

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

### Native mobile UI (optional, recommended)

`native-ui/` contains two plugins that bring the plugin UI into the **native mobile interface**:

| Plugin | Provides |
|---|---|
| `local-purge-ui` | "**Purge**" capsule above the input + panel: real state (reads `.bak` files and the approval marker, not counters), patch counts, host directory, inject text, red-team state, per-patch detail; actions: Apply (double confirm) / Revert / Refresh / Copy status |
| `local-purge-more` | "**Purge content**" capsule + 3 panels: Prompt (preview / write / restore default / copy), Rules (list / switch / copy), Skills (list / copy) |

```sh
mkdir -p "$DSH_HOME/dsh-go/plugins"
cp -a native-ui/local-purge-ui native-ui/local-purge-more "$DSH_HOME/dsh-go/plugins/"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-purge-ui"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-purge-more"
```

**Note**: these install as `link:` — **do not delete the directories**. Restart the engine and the two
buttons appear above the input box.

> These plugins only render UI and read/write local files. They **never** rewrite host code and never
> disable approvals. "Apply" needs a second confirmation and is equivalent to `dsh-purge --apply`.

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
