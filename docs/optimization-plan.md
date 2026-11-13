# dsh-purge-fixed 优化方案（还能加什么、怎么优化）

> 行号基线：`428ec6d`（docs: 标注专为 DSH Go 手机版适配 + 英文 README）。
> 并行任务（task-1）已经在改 `lib/core.js` 并新增 `lib/patch-report.js`（写作时工作区是 `+171/-35`），
> `lib/core.js` 的行号因此整体后移 10–110 行（例：`patchStatus` 7212 → 7322、`gatherState` 7994 → 8097）。
> **引用一律以函数名为准，行号按基线读**；`bin/`、`native-ui/`、`lib/uninstall.js` 不受影响。
> 文中「实测」= 在本机 dsh-go（Android / proot Ubuntu，`DSH_HOME=/root/.dsh`，宿主 `/opt/dsh`）上跑出来的；
> 没跑过的标「未实测」。数字都能用第 5 节的命令复现。

---

## 1. 现状盘点

### 1.1 补丁层：82 条，四个数组拼起来，没有单一清单文件

- `ALL_PATCHES = [...PATCHES, ...CODE_PATCHES, ...ENGINE_PATCHES, ...NEW_TOOL_PATCHES]`（`lib/core.js:5818`），四段分别起于 `core.js:2548 / 2809 / 2850 / 3126`。
- 实测：**82 条**，id 最大 88，**缺 20 / 27 / 41 / 44 / 79 / 81**（历史删条目，没有墓碑记录）。
- 分层实测：提示词 25、代码 46、工具 8、`0.1.5 兼容` 1、`0.2.0 兼容` 2。
- 标记实测：`optional: 43` 条、`strictFiles: 3` 条、带 `surfaces` 限制 5 条（#45 #46 #82 #83 #84，全是 `desktop`）。
- 后果：`ALL_PATCHES` 是**运行期数组**，没有 `patches.json` 之类的静态清单，外部工具（面板、CI、文档）只能 import 代码才能拿到条数与名称。

### 1.2 状态：读侧 6 种、写侧 8 种，两套名字对不上

- 读侧 `patchStatus`（`core.js:7212-7255`）只产出 `pending / applied / unmatched / skipped / na / missing_file`，优先级写死为 pending > applied > unmatched > skipped（`7247-7251`）。
- 写侧 `rollupPatchStatus`（`core.js:6967-6977`）产出 `applied / already / missing_file / skipped / pattern_not_found / read_error / write_error`。
- 两套之间没有映射表：`unmatched`（读）↔ `pattern_not_found`（写）是同一个事实的两个词；`skipped`（读，= 原文对不上，见 `filePatchOutcome` `core.js:6846-6851`）与 `skipped`（写，= 可选补丁没命中，见 `6975`）**语义相反**。
- 逐条判定的真实分支藏在 `patchApplied`（`6784-6799`，markers/markersAny/forbid 三种判定）、`patchHasRemainingWork`（`6815-6825`）、`filePatchSettled`（`6839-6844`，含 `isLayoutSoftPatch` `6835-6837` 的软判定）里 —— 面板和 CLI 各自用不同子集复述这套逻辑，是「说的和做的不一致」的根源。

### 1.3 三个分母同时在用（实测，同一台机器）

| 口径 | 来源 | 实测值 |
|---|---|---|
| 82 | `bin/dsh-purge.js:27` 用 `core.ALL_PATCHES.length` 当分母 | CLI 打印 `补丁 0/82`（未定位宿主时）/ 定位后 `63/82` |
| 71 | `core.js:8055-8060` `patches_total`（只算适用于本机） | `patches_applied=63 pending=0 skipped=8 na=11 total=71` |
| 63 | `core.js:8061-8066` `display_total`（分组折叠后） | `display_applied=55 display_skipped=8 display_total=63` |

面板 `keyValue` 显示 `63/71`（`local-purge-ui:226-228`），列表给 63 行（`234-246`），CLI 给 `63/82` —— 用户看到三个不一样的比例，没有一处解释为什么。

### 1.4 分组：9 组升级链折叠，只影响展示

- `PATCH_DISPLAY_GROUPS`（`core.js:5821-5831`）9 组（disclaimer / approval_sentence / approval_policy / desktop_update / desktop_close / followup / hang / hooks_deny / hooks_steer），`groupPatchesForDisplay`（`5851-5875`）按组折叠成一行，`rollupDisplayStatus`（`5841-5849`）任一组员 pending 就整组 pending。
- **Apply 仍然打全部补丁**（`5851` 上面的注释写的就是这个），分组只是展示层。面板拿到的行只有 `{id, ids, layer, status}`（`5869-5874`），**没有 reason 字段**，所以面板只能自己猜原因（`local-purge-ui:233` 的 `reasonOf`）。

### 1.5 备份：扁平 `.bak`，没有 manifest，没有轮转

- `backupAll`（`core.js:6150-6185`）对每个目标文件写 `<file>.dshpurge.bak`（`6162`），用 `wx` 独占创建防竞态（`6167-6172`），用户 patch 层文件永不备份（`6157-6161`）。
- `revertAll`（`6196-6250`）整文件 copy 回去（`6237`），与 bak 逐字节相同就只删 bak（`6225-6236`）；没有 bak 时**绝不删目标**（`6245-6246`）。
- 缺的是「哪条补丁改过哪个文件」的归属：`.bak` 只有一个扁平名字，`applyPatches` 的 report（`7163-7171`）只带 `path: paths[0]`（第一条命中路径，不是全部），落盘后这条信息就丢了。
- 实测真宿主：`@deepseek-ai` 下 **52 个 `.dshpurge.bak`**，目标文件 55 个 / 2.77 MB；备份没有上限、没有过期时间、没有「这次 apply 新增了几个」的报告。
- 反例（说明仓库里已有 manifest 写法可复用）：`lib/uninstall.js:865-888` 写 `manifest.json` + `RESTORE.txt`。

### 1.6 性能：读侧无缓存，面板每次冷开约 0.9 秒

- `loadText`（`core.js:7016-7018`）就是 `fsp.readFile`，没有内容缓存；`patchStatus` 对每条补丁 × 每个文件读一遍，实测**每次 102 次文件读**、**271 ms 冷 / 265 ms 热**（同一份文件重复读，第二次不掉时间）。
- `gatherState`（`7994-8076`）= `patchStatus` + `hasBackup`（`7257-7264`）+ `overrideStatus` + 桌面扫描，实测 **600 ms**。
- 面板 `collect()`（`local-purge-ui:202-290`）另外还有 `detectApplied`（`155-174`）：**递归整棵宿主**数 `.bak`，实测等价扫描 **276 ms / 1575 个目录 / 5943 个文件**。
- 两层缓存互不知情：`local-purge-ui:176-200` 全量状态 20 s（`CACHE_MS=20_000`），`local-purge-more:146-160` 字段级 4 s；core 自己一层都没有。
- 结论：冷开面板 ≈ 600 + 276 ≈ **0.9 s**，全是重复读同一批 2.77 MB 文件。

### 1.7 CLI：只有 6 个模式，退出码不承载信息

- `bin/dsh-purge.js:39` 白名单只有 `--apply / --revert / --uninstall / --status / --edit / --help`；`--status` 输出纯文本（`8-36`），没有 `--json`、没有 dry-run。
- 未定位宿主时实测输出：`插件根 / root 插件根未找到 / set DSH_BASE`，随后 82 行全是 `— undefined`（`bin:28-31` 在 `patch_status` 为空对象时直接取到 `undefined` 并打印）。
- `--status` 退出码恒 0（只有 `main().catch` 兜底 `exit(1)`，`bin:151`）；CI 无法用退出码判断「有补丁待做」。
- 本仓库 checkout 下跑 `--status` 就命中上面这条：`core.findAiBase()` 返回 `null`（`core.js:2329-2334` → `findAiBaseWeb`），因为宿主发现依赖「运行位置 / profiles / 环境变量」而非「引擎正在用的那份」—— `local-purge-ui` 不得不在 `27-81` 自己重写一套 `resolveEngineHost()` + `withPinnedHost()` 兜底 `/opt/dsh` 来绕开它。**同一个信息源被实现了两遍**。

### 1.8 界面：1 胶囊 + 1 面板；另 1 胶囊 + 3 面板

- `local-purge-ui`（`lib/index.js:349-474`）：1 个胶囊 `purge-open`（`353`）+ 1 个面板 `purge-panel`，视图 9 个顶层子节点（`355-385`）：`keyValue`(5 行) → `callout` → `confirm`(apply) → `actions`(还原/刷新/复制状态) → `list`(why) → `text` → `list`(detail ≤20) → `text`。
- `local-purge-more`（`lib/index.js`）：1 个胶囊 `prompt-draft-confirm` + 3 个面板（`prompt-panel` `695` / `rules-panel` `734` / `skills-panel` `756`），带 `wants: ["draft"]` 与 4 s 字段缓存。
- 面板当前组件数实测估算：9 顶层 + why 3 + detail ≤20 ≈ **32 个组件**，离 120 上限不远；把 63 行全列出来必超。

---

## 2. 可增加的内容（按建议优先级排序）

风险＝「会改宿主源码 / 会动用户文件 / 会打断会话」的暴露面；工作量按熟悉这套代码的人估算。

| # | 建议 | 收益 | 风险 | 工作量 |
|---|---|---|---|---|
| 1 | **统一状态分类 + tally**：读侧与写侧合成一套 7 类（applied / pending / partial / drifted / no_needle / no_file / no_pkg），`patchStatus`/`gatherState` 老字段全部保留、只**新增** `patch_tally`/`patch_rows`（`core.js:7212-7255`、`6967-6977`、`8061-8066`） | 三个分母收敛成一个可解释的分布；面板/CLI 不再各说一套 | 低（纯读，不改写盘） | 中 |
| 2 | **`--check`（只读 dry-run）+ `--status --json`（schema 版本化）**（`bin:39` 白名单、`8-36` 文本输出） | CI 能判「有补丁待做」，面板能复用同一份数据 | 中 —— **不能直接调 `applyPatches`**：它在打补丁前就写盘（`core.js:7084` `restoreMissingOriginalsFromBak`、`7085` `refreshStaleBaksForUpgrade`、`7089` `repairPluginCordisYaml`） | 中 |
| 3 | **检测缓存分层**：core 内 `patchStatus`/`gatherState` 30 s 内容缓存 + `invalidatePatchCache()`，apply/revert 成功后失效，缓存键含 `aiBase`（`loadText:7016`、`gatherState:7994`、面板缓存 `local-purge-ui:176-200`） | 冷开面板 0.9 s → 二次打开 ~0 s；实测 102 次读降为 55 次 | 低（只影响读） | 低 |
| 4 | **「未生效原因」聚合**：把 7 类原因做成枚举，CLI/面板共用一份；删掉硬编码的 `DSH 0.2.2-rc.1`（`local-purge-ui:248-252`） | 用户看到「7 条原文对不上 / 1 条文件缺失 / 11 条本机不适用」，而不是 20 行明细 | 低 | 低 |
| 5 | **补丁分组视图（按层 / 按包）**：`groupPatchesForDisplay`（`5851-5875`）加 `by` 参数，输出带 `reason` 与 `files` | 63 行折叠成 5 个层 × 少量组；面板与 CLI 共用 | 低（纯展示） | 低 |
| 6 | **会话动作「复制报告」**：把现有的文本 `copy-status`（`local-purge-ui:461-470`）升级成结构化报告（带 commit、宿主版本、tally、未生效明细、`.bak` 数） | 贴 issue / 给协作者时不用手抄；比截图可信 | 低（只写剪贴板，有 8000 字上限 `more:25`） | 低 |
| 7 | **补丁回归脚本**：`node:test`（内置，零依赖）在 fixture 上跑 `apply → --check → revert → --check` 幂等断言 + `node --check` 主入口（`release-notes.md:7` 提到 1.1.70 曾把语法错误打进 Release） | 82 条补丁的任何改动都有回归网；改锚点不再靠手测 | 低（只碰 `/tmp` fixture） | 中 |
| 8 | **宿主定位收敛成一个导出**：`resolveEngineHost()`（`local-purge-ui:27-81`）搬进 core 作为 `findLiveHost()`，CLI 未定位时输出占位而非 `undefined`（`bin:28-31`） | 三处重复变一处；CLI 在本仓库 checkout 下也能报出真实状态 | 中（CLI 行为变化，UI 依赖 DSH_BASE pin 的语义要一起核对） | 中 |
| 9 | **应用回执 manifest**：每次 apply 写 `$DSH_HOME/dsh-purge/apply-receipt.json`（patch_id → files → bak 路径 → 时间 → 宿主 commit），复用 `uninstall.js:865-888` 的写法 | 第一次有「哪条补丁改了哪个文件」的落盘记录；单条开关与备份轮转都建在它上面 | 中 —— 新增写盘点，必须能失败回滚 | 中 |
| 10 | **备份轮转与清理**：按 manifest 把 `.bak` 分「本次 apply 新增 / 历史遗留」，提供 `--prune-backups`（默认 dry-run，打印将删清单）；实测 52 个 bak 无归属（`backupAll:6150-6185`） | 宿主目录不再累积无主备份；revert 前的「是否还有别人的备份」一眼可见 | 中高 —— 删错 bak 等于丢原版（`revertAll:6245-6246` 有「无 bak 不删目标」的保护，轮转必须照抄这条） | 中 |
| 11 | **跨版本升级后的补丁重定位**：读宿主 `package.json` 版本（`targetFiles:6310` 已能定位包根）+ 对 `no_needle` 的补丁输出「疑似重定位候选」（同文件里 diff 出最接近的锚点），只报告不改 | 宿主升级后不用人肉 grep 82 条；每次升级省一轮排查 | 低（只读 + 报告） | 高 |
| 12 | **单条补丁开关（opt-in）**：`--only=ID` / `--skip=ID` + 面板勾选，落 deps 到现有 `patchAppliesHere`（`6981-6986`）旁边 | 出问题能只回滚一条，不必全量 revert | 高 —— 依赖 #9 的归属信息；没有 manifest 就只能在「整文件还原」和「不还原」之间二选一 | 高 |
| 13 | **状态条（0.5 s 级轻量快照）**：面板外做一个只读 tally 的状态条，走 #3 的缓存 + 只读 `patch_tally`，不扫全树 | 不用打开面板就知道「有没有东西待做」 | 中（要在 dsh-go 里加状态条贡献点，App 支持度**未实测**） | 中 |

### 2.1 写盘类建议（#9 / #10 / #12）的共同前提：先能回滚，再谈自动化

这三条都会新增写盘点，必须一起做，顺序不能跳：

1. **目标写前快照**：`apply-receipt.json` 与 `--prune-backups` 的删除清单先写 `<name>.tmp` 再 `rename`（仓库已有 `atomicWriteSync` `core.js:51-63`、`atomicWriteFile` `64-76`），任何异常都不留半文件。
2. **失败回滚**：receipt 写失败 → 整个 apply **不算成功**，退出码非 0，并打印「宿主已改，但回执没写上，请 `--revert`」；prune 中途失败 → 已删的 bak 逐条列进 stdout（不静默），未删的保持原样。
3. **演练方式**：先在 fixture 上跑（见 5.7 的建法，只复制 55 个目标文件，2.77 MB，不要整份 256 MB 宿主），跑通「apply → 杀进程（`kill -9`）→ 再 `--check` → `--revert`」这一条，确认无 bak 丢失、无半写文件。
4. **默认不删**：prune 默认 dry-run；真要删必须显式 `--yes`，且删除清单先落盘再执行。

### 2.2 与并行任务的重叠说明

#1（状态分类 + tally + 缓存）与 #2（`--check` / `--json`）已经在另一条并行任务里做（task-1，`lib/patch-report.js` + `lib/core.js` 改动）。本文档对这两条只保留**验收口径**（见 5.1 / 5.2），不重复实现；5.1 的「改前基线」数字取自 `428ec6d`。其余 11 条互不冲突。

---

## 3. UI 面板优化

### 3.1 现有面板的信息层级问题（都能指到行）

1. **权重平均**：`keyValue` 把「真实状态 / 补丁计数 / 宿主目录 / 注入文案 / 红队模式」摆成 5 行同权（`local-purge-ui:361-369`），真正要看的「有几条没生效」被折进一个字符串里（`226-228`）。
2. **明细全塞一个 list**：`detail.slice(0, 20)`（`245`），溢出提示被塞进 `why` 列表当伪条目（`246-253`）—— 「另有 N 条」和「宿主版本变了」并列，语义错位。
3. **confirm 文案没有后果**：「应用清洗 / 再想想」（`371`）没说「会改宿主源码、要重启」；而**还原**反而只是 `actions` 里的普通动作（`375`），没有二次确认 —— apply 有确认、revert 没有，正好反了（revert 丢的是当前补丁状态，apply 只是重写同一份源码）。
4. **硬编码版本号**：`local-purge-ui:249` 写死 `DSH 0.2.2-rc.1`，宿主一升级这句立刻变谎话。
5. **两套真相**：`detectApplied`（`155-174`，数 bak）判三态（`256-268`），计数走 `gatherState`（`202-228`）；一次面板刷新读两遍宿主（600 ms + 276 ms，实测）。
6. **缓存没有失效钩子**：20 s（`178`）全靠等；apply 后手写 `cachedState = null`（`420`），但外部 `--apply` / 手动改文件后不感知。
7. **scope 里的 `sessionId` 没用上**：`placement` 含 `session.tab`（`package.json`），详情页上下文没进视图。

### 3.2 改进草图（组件树级别，不写实现）

```
stack (v:2, title "dsh-purge 清洗")
├─ text[style:title]        已应用 · 63/71 生效        ← 一个主结论，带分母
├─ metric ×3                63 已生效 / 0 待做 / 11 本机不适用
├─ callout(tone 随状态)      一句话下一步：
│                             已应用 → 「重启引擎后生效；要撤销点还原」
│                             半应用 → 「发现 N 个无主备份，建议先还原再重来」
│                             未定位 → 「没定位到宿主，已停用应用」
├─ options(筛选)            全部 / 仅未生效 / 按层 / 按包       ← 替代现在写死的 20 行截断
├─ table(≤50 行, 分页)       ID | 名称 | 状态 | 原因(枚举短语)
├─ confirm(apply)           「应用清洗」正文里写清：改宿主源码 + 要重启
├─ confirm(revert)          「还原宿主」正文里写清：逐字节还原 + 丢当前补丁
├─ actions(≤4)              复制报告 / 刷新
└─ text(muted)              重启才生效；点「复制报告」拿完整清单
```

组件数：`1 + 1 + 1 + 1 + 1 + 1 + 2 + 1 + 1` ≈ **11 个组件**（表格行算 1 个组件），远低于 120。

### 3.3 视图预算（32 KiB / 120 组件 / 8 层）下的取舍

| 做法 | 省下的预算 | 为什么值得 |
|---|---|---|
| 明细用 `table`（`rows` ≤ 50）而不是 63 个 `list` 项 | 组件数 63 → 1 | `list` 项每个都算组件（`≤50` 硬上限），63 行直接超 120 |
| 原因只用 6–7 个枚举短语，长解释只出现一次 | 文字量约 -70% | 63 行 × 一句 60 字 ≈ 3.8k 字，接近 32 KiB 的一半，且手机上不可读 |
| 分层信息进 `options` 筛选，不建嵌套 `stack` 分区 | 树深保持 2–3 层 | 8 层深度留给未来的表单，别在展示层用掉 |
| 完整清单走「复制报告」剪贴板，不进视图 | 视图体积和 8000 字剪贴板上限解耦 | 面板只负责「让你看懂现在怎样」，不负责「导出全部」 |
| 不做行内展开/二级详情页 | 少一层导航状态 | dsh-go 面板是弹层，返回栈不便宜 |

**取舍结论**：宁可少列几行（默认 20 + 筛选 + 复制完整报告），也不要把 63 行都塞进去。现在的 20 行截断方向是对的，错在**截断后没有分组和筛选**，还把溢出提示伪装成一条原因。

**兼容性（未实测）**：草图用了 `v:2` 的 `table` / `metric` / `options` / `style`。当前两个原生插件全是 v1（`local-purge-ui:355-385` 只用了 stack/keyValue/callout/confirm/actions/list/text）。上 v2 前必须先做 3.4 的 A/B。

### 3.4 UI 改动的回滚方式

- 只改 `native-ui/local-purge-ui` 的**副本目录**做 A/B，正式目录不动：`cp -a native-ui/local-purge-ui /tmp/ui-v2-try`，在副本上改，`dsh plugin --profile web add /tmp/ui-v2-try`。
- 失败回滚：`dsh plugin --profile web remove local-purge-ui-v2-try` → 原目录一直是 link 安装、没被碰过，删副本即可；重启引擎后回到现状。
- 若必须改正式目录：先 `cp -a` 到 `.bak-<时间戳>`，改完面板打不开就用 `.bak-<时间戳>` 覆盖回去再重启。

---

## 4. 不做什么及原因

| 不做 | 原因 |
|---|---|
| **自动热补丁 / 打补丁后自动重启引擎** | 重启会打断当前会话；桌面路径已有 `scheduleSealedDesktopRestart`（`core.js:2179-2188`）这套复杂兜底，扩到手机端收益远小于风险。现状「打印『重启后生效』」是正确取舍。 |
| **联网检查新版本 / 下载补丁** | 仓库零依赖是刻意的（`package.json` 无 `dependencies`，两个原生插件都声明不联网）。自动更新还要引入签名与降级保护，与本项目定位冲突。 |
| **每轮都全量指纹校验宿主（5943 文件）** | 实测 276 ms；放在每轮或每次状态条刷新上会明显拖慢。只在 apply/revert 后算一次，其余走缓存。 |
| **用 git 托管宿主源码的还原点** | 引入 git 依赖、把宿主状态写进用户目录，还会泄漏宿主内容。`.bak` + 逐字节比对（`revertAll:6225-6236`）已经够。 |
| **单条补丁的「运行时开关」（改内存、不落盘）** | 宿主没有热重载点，改了必须重启；真做就是「重启一次只换一条」，体验更差。正确姿势是 #9 + #12（opt-in 后重新 apply）。 |
| **面板里做 8000 字全文预览** | `COPY_LIMIT`/`PREVIEW_CHARS` 已经是 8000/800（`more:24-27`），再长面板每开一次就重读一遍文件；全文不属于面板职责。 |
| **把 `--check` 实现成「调 `applyPatches` 然后不写」** | `applyPatches` 在循环前就有三个写盘点（`7084`/`7085`/`7089`），「不写」等于要改它的前置行为，风险高于新写一条只读路径。 |
| **顺手清理没用到的 id（20/27/41/44/79/81）空档** | 补丁 id 是历史锚点（`markers`、`installed-rev` 里都有 `[dsh-purge-NN]` 字面量），重排 id 会让已应用补丁变成「找不到」；空档留着是特性。 |
| **重构 `groupPatchesForDisplay` 的折叠规则** | 它只是展示层（`5851` 注释明确写了 Apply 仍打全部）。改成「按组跳过」会悄悄改变 apply 语义，属于 #12 的范围，不能顺手做。 |

---

## 5. 每条验收方式

统一前提：在 fixture 上验收，**真宿主只读**。

### 5.1 状态分类 + tally
- `node bin/dsh-purge.js --status --json | node -e 'const j=JSON.parse(require("fs").readFileSync(0));const t=j.patch_tally;const s=Object.values(t).reduce((a,b)=>a+b,0);const n=j.ALL_PATCHES_len??82;if(s!==n)throw 1;if(j.patches_total!==n-t.no_pkg)throw 2;console.log("tally ok",s,j.patches_total)'`
- 断言一：7 类之和 === 补丁总数（实测 82；`na` 归到 `no_pkg`）。
- 断言二：`patches_total === 总数 - no_pkg`（实测 82-11=71），即「适用条数」口径不变。
- 断言三：`patches_applied/patches_pending/patches_skipped/patches_na/patches_total` 与本改动前**逐项相同**（实测基线 63/0/8/11/71，`display_applied/display_skipped/display_total` = 55/8/63）。

### 5.2 `--check` 与 `--json`
- `DSH_BASE=... node bin/dsh-purge.js --check`：`git status --short` 与 `find <fixture> -name '*.dshpurge.bak' | wc -l` 前后**完全不变**（证明没写盘）。
- 退出码：有待做 → 非 0；全绿 → 0。`echo $?` 校验。
- `--status --json` 输出带 `schema_version`，且 `--json` 里不含绝对路径以外的私密字段（人工看一遍）。

### 5.3 缓存分层
- 连跑两次 `gatherState` 计时：第二次应从 600 ms 级掉到 10 ms 级（用 `console.time` 包围，实测基线 600 ms）。
- apply 后立刻 `gatherState`：不得返回旧的 tally（`invalidatePatchCache()` 生效）。
- 换 `DSH_BASE` 到另一个 fixture：缓存不得命中（键含 `aiBase`）。

### 5.4 原因聚合
- 面板 `callout` 与 CLI 输出的原因计数**完全一致**（同一个枚举来源）。
- `grep -rn "0\.2\.2-rc\.1" native-ui/` 应为空、`grep -rn "0.2.2" native-ui/` 只剩注释。

### 5.5 分组视图
- `groupPatchesForDisplay(ALL_PATCHES, patch_status, undefined, {by:"layer"})` 返回 5 组（提示词/代码/工具/0.1.5/0.2.0），每组 `reason` 字段非空；组内 id 之和 + 未分组 id = 71（本机适用条数）。
- Apply 行为不变：`--apply` 报告里补丁条数仍为 82 行（分组不影响 apply）。

### 5.6 复制报告
- 点一次「复制报告」→ 剪贴板长度 ≤ 8000 且含 4 项：commit、宿主版本、tally、未生效明细；用 `pbcopy`/`xclip` 或 App 内粘出来核对。
- 报告里不得出现 `/root/.dsh` 以外的用户私密路径（人工看）。

### 5.7 回归脚本（零依赖）
- 建 fixture：`mkdir -p /tmp/host-fixture/node_modules && cp -a /opt/dsh/node_modules/@deepseek-ai /tmp/host-fixture/node_modules/`（只这一步就够跑补丁层；**不要**整份 `/opt/dsh`）。
- `node --test scripts/`（或 `node scripts/regress.mjs`）：断言 4 步 —— `apply` → `--check` 全绿 → `revert` → `--check` 与 apply 前**逐文件 sha256 相同**。
- 主观验收：把一条 `pattern` 故意改错，脚本必须红，且失败信息指名到补丁 id。

### 5.8 宿主定位收敛
- 在仓库 checkout 下直接 `node bin/dsh-purge.js --status`：不再打印 `undefined`；要么报出 `/opt/dsh/node_modules/@deepseek-ai`，要么明确写「未定位到宿主（试过哪些位置）」。
- `--status` 的定位结果与 `local-purge-ui` 面板「宿主目录」一致（同一函数）。

### 5.9 应用回执 manifest
- apply 后 `$DSH_HOME/dsh-purge/apply-receipt.json` 存在；`node -e` 读它：`receipt.patches[].files[]` 覆盖实测 55 个目标文件里被改过的全部（对照 `find <host> -name '*.dshpurge.bak'` 的 52 个）。
- 演练：apply 中途 `kill -9` → 再 `--check` 不崩、`--revert` 能还原；**宿主目录里不得出现 `.tmp` 残留**。
- 失败回滚断言：手工把 receipt 路径改成不可写目录 → apply 必须报错并给「宿主已改，请 revert」的提示，退出码非 0。

### 5.10 备份轮转
- `--prune-backups`（无 `--yes`）：只打印清单，`find | wc -l` 不变。
- `--prune-backups --yes` 后：`revert` 仍能把每个目标文件逐字节还原（用 apply 前的 sha256 快照对比）。
- 演练：先删**一个** fixture 的 bak，再 `--revert` → 该文件应被跳过并打印「无备份，未动」，不删文件（对齐 `revertAll:6245-6246`）。

### 5.11 跨版本重定位
- 在 fixture 里把某个锚点字符串改一个字符 → `--check` 该条变 `no_needle`，并输出「候选锚点」+ 文件 + 行号；候选必须指向真实存在的近似行（人工核对 1 条即可）。
- 只读断言：跑完后 `git status` 不变。

### 5.12 单条补丁开关
- `--only=9` 只打 #9：`--status` 里 #9 = applied，其余保持原状态；`--revert --only=9` 后 #9 回到 pending，且**其它已应用补丁的 bak 还在**。
- 依赖断言：没有 receipt（5.9）时 `--only` 必须拒绝执行并说明原因，不能猜。

### 5.13 状态条
- 面板不打开的情况下，状态条数值与 `--status --json` 的 tally 一致；打开面板后 1 次操作内同步刷新。
- 冷启动开销：状态条首帧 ≤ 50 ms（走缓存，不扫全树）；连续 10 次刷新不得触发全量 `patchStatus`（用日志计数验证）。

---

## 6. 一句话建议

先做 #3（缓存，#1/#2 已在并行任务里）+ #4（原因聚合）+ #5（分组视图）—— 三条都不新增写盘点，一天内能把「面板慢、数字对不上、看不出为什么」这三件最烦的事解决掉。写盘类的 #9/#10/#12 放到回归脚本 #7 之后，因为这三条只有在能自动验证「apply→revert 逐字节还原」的前提下才敢自动化。
