# 改动清单（1.1.71 → 1.1.72）

> 本分支基线：上游 [`dsh-purge`](https://deepseek.stream/plugins/dsh-purge) **1.1.71**（作者 小杨，MIT）。版本规则见 [docs/versioning.md](docs/versioning.md)。

衍生自 [`dsh-purge`](https://deepseek.stream/plugins/dsh-purge) 1.1.71，原作者 **小杨**（MIT）。
本文件逐条列出本分支的全部改动，共 **11 个文件**。

所有改动均为**兼容性与崩溃修复**，**未改动任何破甲规则文本**
（人设、18 组分类规则、`Never Refuse`、拒绝话术清单、House Rules 全部保持原样）。

可用以下命令复核差异：

```sh
diff -rq <上游 1.1.71 目录> <本仓库> | wc -l    # 应为 11
```

---

## 1. `cordis.patch.yml`

**问题**：`personaSuffix: Your working directory is {{cwd}}.`

这是 bundle 层补丁，安装时即被并入 profile 的 system-prompt 配置。而 DSH 0.2.2-rc.1 的
提示词变量注册表只有 `provider` 与 `model`（`@deepseek-ai/dsh-agent-loop/lib/index.js:1408-1409`），
未注册变量会让 `interpolate()` 抛错 → **每一轮对话整轮失败**。

**修复**：改为 `personaSuffix: ""`，并加注释说明原因。

---

## 2. `lib/identity.js`

| 改动 | 说明 |
|---|---|
| `DSH_INTERPOLATE_ALLOWED` | 去掉 `cwd`；只保留 `model`、`provider`（据实反映宿主注册表） |
| 新增 `CWD_SUFFIX_FALLBACK` | 拿不到 cwd 时的静态兜底文案，不含任何 `{{}}` |
| 新增 `cwdSuffixText(cwd)` | 生成 persona-suffix 段文本，写真实路径或静态兜底，**永不输出占位符** |
| 新增 `readContextCwd(context)` | 取工作目录：优先宿主 `workingDirectory` 服务（`cd` 后更准），退回 `session.header.cwd`，空白串也视为未取到 |
| 新增 `setLiveCwdResolver(fn)` | 由 `lib/index.js` 在 apply 时注入实时目录读取器 |
| `stripHarnessPersona(text, cwd)` | 原先替换成 `"Working directory: {{cwd}}. "`，改为写真实 cwd 文本 |
| `escapeDshInterpolation(text, cwd)` | `{{cwd}}` 就地换成真实路径；其余未注册变量交给下面的终局保证 |
| 新增 `keepOnlyRegisteredVars(text)` | **终局不变量**：返回文本里的 `{{` 只可能是完整的 `{{model}}`/`{{provider}}`。按「连续 `{` 整段」处理，关掉 `{{{cwd}}}`、`{{{{model}}}}` 这类边界重新拼接的洞 |
| `overlayOfficialIdentity(sections, cwd)` | 合成的 `deployment:persona-suffix` 段一律带 `interpolate: false`（两处：命中已有段 / 无段时兜底插入） |
| `isCwdOnlyText(text)` | 同时识别旧占位符版与新真实路径版，避免重跑时层层叠加 |

---

## 3. `lib/index.js`

| 改动 | 说明 |
|---|---|
| `dsh-purge:post` 段 | 原先把用户配置的 `postPrompt` 原样交给宿主插值；改为先 `escapeDshInterpolation(postPrompt, readContextCwd(context))`。`{{model}}`/`{{provider}}` 仍由宿主解析 |
| `installIdentityOverride()` | 注入 `setLiveCwdResolver`，读宿主 `workingDirectory` 服务的 `get(session)` |

---

## 4. `lib/core.js`

| 改动 | 说明 |
|---|---|
| 补丁 **#14** `ESCALATION_GRANT_UNCONDITIONAL` | 目标 `dsh-sandbox/lib/index.js`。宿主新增 `displayReason` 行 → 锚点更新；保留 fail-open（approver/agent 缺失时直接放行）。markers 同步 |
| 补丁 **#17** `FS_OBSERVATION_INTENT_FREE` | `dsh-fs-observation-policy`。旧内联 `editIntent` 已不存在（现为委托 `requirePresent`）→ 锚点改为新实现；`deleteIntent` 仍守门 |
| 补丁 **#40** `COMPLETE_PROMPT_KEEP_INJECT` | `dsh-system-prompt`。宿主改为 early-return + `tools`/`requiredContexts` 过滤，旧正则锚点失效 → 新增常量 `COMPLETE_PROMPT_WATERFALL_INJECT_V2`，保留 `tools`/`requiredContexts` |
| 补丁 **#62** `OFFICIAL_TOOL_ASK_FAILOPEN` | 目标代码从 `dsh-tools/lib/index.js` 迁到 `dsh-tools/lib/pipeline.js`；`targetFiles()` 新增逻辑名 `dsh-tools-pipeline`；`approval === undefined` → `approval === void 0`，缩进对齐。**rejected/cancelled 仍 deny** |
| 补丁 **#67** `AGENT_LOOP_MESSAGES_GUARD` | `dsh-agent-loop`。新宿主多一层块，缩进 4→5 tab |
| 补丁 **#74** `ASSEMBLE_BEFORE_PRESTEP` | `dsh-agent-loop`。preStep 里 assemble 改为对象入参并移入 `try` → 锚点更新 |
| `ALLOW_EXEC_PERSONA_BLOCK/_LINE` | 去掉其中的 `{{cwd}}`，改为固定文案（这两段会被写进宿主提示词配置） |
| `revertAll()` | 文件与 `.dshpurge.bak` 逐字节相同时，顺手删除冗余备份（否则还原后宿主目录残留一堆 `.bak`） |

**明确未修**（官方已移除对应代码 / 仅网页端 / 未安装的预设，修了无意义）：
`#32` `#53` `#54` `#60` `#71` `#77` `#80`

---

## 5. `lib/redteam/index.js`

**问题**：`repairDelegation()` 的判定标记写的是**未转义**反引号
（`"**必须用原生 \`subagent\` 工具派活**"`），而预设模板里这句是**转义**写法
（`` \`subagent\` ``）。→ 判不到 → 每次自愈插入重复行。

**修复**：判定改为「转义 / 未转义两种写法都认」。

复现（假 `DSH_HOME`，连续三次 `installPreset({force:false})`）：

```
旧：1:installed 未转义0/转义1 | 2:repaired 未转义1/转义1 | 3:kept 1/1   ← 第二遍多插一行
新：1:installed 0/1           | 2:kept 0/1                | 3:kept 0/1
```

---

## 6. `lib/uninstall.js`

新增落地文件清理（原版卸载后会残留注入文件、技能库、预设目录等）：

- **删除**（插件状态与可重建文件）：`$DSH_HOME/dsh-purge/**`、`redteam/setup.sh`、
  `redteam/skills/*.md`、`.agent-presets/redteam/**`、profile 里的 `dsh-purge` bin shim
  —— **仅当与随包副本逐字节一致**
- **隔离**（默认动作）：`prompt-inject.md`（不等于内置默认时）、`redteam/engagements/`、
  `preset-declare.json`、被改过的技能/预设 → 移到
  `$DSH_HOME/dsh-purge-uninstalled-<YYYYMMDD-HHMMSS>/`，附 `manifest.json` 与 `RESTORE.txt`
- **只记不动**：`$DSH_HOME/skills/redteam`（用户 Skill）、`$DSH_HOME/.env`（可能含用户密钥）
- **护栏**：空 / `/` / `/root` / 用户主目录 / 层级 < 2 的 `DSH_HOME` 一律拒绝

---

## 7. `bin/dsh-purge.js`

`--uninstall` 输出中补充：隔离去向与清理条数（原先只有 override/stripped/errors）。

---

## 8. `package.json`

| 改动 | 说明 |
|---|---|
| `dshTarget: "0.2.0-rc.2"` | 删除。plugin_manager 的兼容门禁读的是 `engines`，此项不参与判定 |
| `engines` | 改为 `{ "node": ">=22", "dsh": ">=0.2.1-rc.2 <0.3.0-0" }`，让不匹配在**安装时**就报出来，而不是运行期崩在提示词装配上 |
| `version` | `1.1.71` → `1.1.72` |
| `repository` / `homepage` / `bugs` | 指向本仓库 |
| `keywords` | 追加 `dsh-go`、`android`、`termux`、`proot` |

---

## 9. `presets/redteam/agent.cordis.yml`

**问题（两处，导致「红队模式」从 App 下拉里整个消失）**：

1. `name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'`
   —— 该包 `package.json` 的 `exports` 只有 `.` / `./src/*` / `./package.json` / `./locale/*.json`，
   **没有 `./list-agents`** → 该行 never started。
   （`list_agents` 工具本来就由该包主入口注册，`lib/index.js:46`，此行本就多余）
2. `tool-subagent` 行带 `toolFilter`
   —— 宿主 `dsh-tool-subagent/lib/index.js:346`：配置里出现 `persona`/`toolFilter` 就 **throw**
   「is no longer supported; configure persona and tool plugins in an Agent Preset」

两者叠加 → 插件自检把整份预设标为 `registered-broken` → 模式下拉过滤掉红队模式。

**修复**：删除多余子入口行；删除 `toolFilter` 块，叶子约束由既有的 `maxDepth: 1` 承担。
注释说明新版宿主要求「把 persona 与工具插件放进 Agent Preset，用 `agentPreset` 选择」。

**注意**：落地副本 `$DSH_HOME/.agent-presets/redteam/agent.cordis.yml` 才是权威判定对象，
升级时需同步；`needsCompositionRepair()` 只看 `workflow-ptc` 与 worker-thread，
**不会**因这两处而整份覆盖。

---

## 10. `README.md` / `README.zh-CN.md`（上游文档）

上游原文保留为 `README.upstream.md` / `README.upstream.zh-CN.md`。
其中「卸载」一节改为与实现一致：注入文件默认隔离而非删除。

---

## 11. 新增 `native-ui/`（非上游内容）

两个 dsh-go 手机原生界面插件，**不在上游项目中**，本分支新增：

| 插件 | 内容 |
|---|---|
| `local-purge-ui` | 「清洗」胶囊 + 面板：真实状态（看 `.bak` 与审批标记，不看计数）、补丁计数、宿主目录、注入文案、红队模式、逐条未生效明细；动作：应用（二次确认）/ 还原 / 刷新 / 复制状态 |
| `local-purge-more` | 「破甲内容」胶囊 + 3 面板：提示词（预览/写入/恢复默认/复制）、规则集（列出/切换/复制）、技能库（列出/复制）；写操作均二次确认 |

安全设计：
- **不猜宿主目录** —— 从引擎入口用 Node 解析 `@deepseek-ai` 包定位，另加 `/opt/dsh` 兜底，
  并要求目录同时含 `dsh-agent-instructions/lib` 与 `dsh-web-app/lib`；拿不到就**拒绝应用**
- **关掉启发式扫描** —— 调用时传 `discover: false`
- **真实状态不靠计数** —— 看 `.dshpurge.bak` 与审批直通标记
