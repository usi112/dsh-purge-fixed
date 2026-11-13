# dsh-purge 1.1.75+upstream.1.1.71 — 修复分支（上游基线 1.1.71）· 专为 DSH Go 适配

> 📱 **本项目主要面向 [DSH Go] 手机版（dsh-go，Android + proot Ubuntu）适配与验证。**
> 全部修复与测试都在真实 dsh-go 手机上完成（App 1.0.15 / DSH 0.2.2-rc.1 / Node 24.22.1），
> 并附带两个**手机原生界面**插件——原版只有网页界面，手机上根本看不到。
> 桌面 / Web 端同样可用，但没有针对它做过同等强度的实测。
>
> 🌐 [English README](README.en.md)

### 版本号怎么看

`1.1.74+upstream.1.1.71`：`+` 后面是**所基于的上游版本**，前面的数字是**本分支自己的发布序号**。
本仓库基于上游 `1.1.71`；上游发 `1.1.72`/`1.1.73` 跟这里的数字没有对应关系。
规则、对照示例与发版检查清单见 [docs/versioning.md](docs/versioning.md)。

每个版本的更新说明固定写在两处：仓库内 [release-notes.md](release-notes.md)（最新在前的完整流水），以及 GitHub 的 [Releases](https://github.com/usi112/dsh-purge-fixed/releases) 页（一次发布一条）。

> **衍生自 [`dsh-purge`](https://deepseek.stream/plugins/dsh-purge) 1.1.71，原作者 小杨（MIT License）。**
> 原仓库 `YuJunZhiXue/dsh-purge` 目前不可访问；本分支遵循原项目的
> [署名要求](README.upstream.zh-CN.md)：保留原 `LICENSE` 与作者署名，改动逐条列在
> [CHANGELOG-fixes.md](CHANGELOG-fixes.md)。
>
> **本分支只做兼容性与崩溃修复，未改动任何破甲规则文本**（人设、18 组分类规则、
> `Never Refuse`、拒绝话术清单等全部保持原样）。

一个 DeepSeek Harness（DSH）插件。它能做两件事，**请分开理解**：

| | 内容 | 默认状态 |
|---|---|---|
| **① 提示词注入** | 每轮把一份「人设 + 规矩」写进系统提示词，让模型的拒绝变少、回答更直接 | **装上即生效** |
| **② 代码级补丁（82 条）** | 直接改写 DSH 安装目录里的源码：审批提示改「永不询问」、审批请求无条件放行、沙箱 `(deny file-write*)` → `(allow file-write*)` 等 | **默认不启用**，需手动 `--apply` |

---

## ⚠️ 风险提示（装之前请读完）

1. **这是破甲（jailbreak）插件。** 它通过系统提示词压制模型的拒绝倾向，并内置 18 组分类规则。
2. **`--apply` 会改写 DSH 的源码文件。** 启用后：DSH **不会**再在危险操作前征求你同意，也不会拦「没先读就覆盖文件」。
3. **模型可能静默覆盖你没读过的文件。** 这是补丁 `FS_OBSERVATION_INTENT_FREE` 的既定目标，不是 bug。
4. 每个被改文件都会留 `<文件名>.dshpurge.bak`，`--revert` 可**逐字节还原**。
5. **请只在自己的机器上使用，并自行承担后果。** 不要在存放重要数据、或需要合规审计的环境启用代码级补丁。

---

## 为什么说「专为 DSH Go 适配」

原版 1.1.71 是在桌面环境写的，搬到 dsh-go 手机版上有三类问题，本分支逐个解决：

| 手机端的坑 | 具体表现 | 本分支的处理 |
|---|---|---|
| **宿主版本不同** | 原版写的 `{{cwd}}` 在 DSH 0.2.2-rc.1 上直接抛错，**每轮对话失败** | 全部改掉，改用真实路径或静态文案 |
| **红队预设在手机上消失** | 预设两行与新版宿主接口不兼容 → 整份预设被判「坏的」→ App 下拉里看不到红队模式 | 删掉失效行，改用 `maxDepth` 承担叶子约束 |
| **手机上没有界面** | 插件界面是**网页版**的；dsh-go 是 Flutter 原生界面，看不到 | 新写 `native-ui/` 两个原生插件：2 个胶囊 + 4 个面板 |

另外手机端的路径与环境也和桌面不同，README 的「安装 B」按实测参数写（`DSH_HOME=/root/.dsh`、
引擎在 `/opt/dsh`、**App 没有终端页**）。

## 修了什么（对比 1.1.71）

原版在 DSH 0.2.2-rc.1 上**装上即崩**，每轮对话报 `unknown prompt variable "{{cwd}}"`。
本分支修复以下问题，共改动 11 个文件（详见 [CHANGELOG-fixes.md](CHANGELOG-fixes.md)）：

| # | 问题 | 影响 | 修复 |
|---|---|---|---|
| 1 | 往系统提示词里写 `{{cwd}}`，但宿主只注册 `provider` / `model` | **每轮对话直接失败** | 5 处改掉：有真实路径就写真实路径，否则写固定文案 |
| 2 | `postPrompt` 段走宿主插值 | 用户自定义 `postPrompt` 里写任何 `{{...}}` 也崩 | 先转义再交给宿主 |
| 3 | 转义函数有边界漏洞 | `{{{cwd}}}`、`{{{{model}}}}` 仍能穿透 | 改为按「连续花括号整段」判定 |
| 4 | 红队预设两行与新版宿主接口不兼容 | **红队模式整个从下拉消失** | 删掉失效行，叶子约束由 `maxDepth: 1` 承担 |
| 5 | 自愈逻辑重复插行 | 同一句指令出现两遍 | 判定改为「转义/未转义都认」 |
| 6 | 6 条补丁在新宿主上找不到原文 | 静默失效（提权、读写放行、complete 注入等） | 按新宿主源码重写锚点与 markers |
| 7 | 版本声明用 `dshTarget` | 不兼容时运行期崩，而非安装时提示 | 改为 `engines.dsh` 区间 |
| 8 | 卸载留残留 | 注入文件、技能库、预设目录残留 | 插件自有文件删除；**可能属于用户的移到隔离目录**（附 `RESTORE.txt`） |
| 9 | 还原留垃圾备份 | 宿主目录残留 `.dshpurge.bak` | 逐字节相同即清理 |
| 10 | zip 分发物用反斜杠路径 | 安卓/Linux 解压摊平 | 以 posix 路径重新打包 |

另外附带 `native-ui/` 两个**手机原生界面**插件（见下），原版没有。

---

## 已验证环境

| 平台 | 实测 |
|---|---|
| **手机 dsh-go** | App **1.0.15** · DSH **0.2.2-rc.1** · Node **24.22.1** · proot Ubuntu 24.04 · `DSH_HOME=/root/.dsh` |
| 桌面 / Web | DSH **0.2.2-rc.1** · Node **24.22.1** |

要求：**Node >= 22**，DSH `>=0.2.1-rc.2 <0.3.0-0`。

---

## 安装 A：桌面 / Web

```sh
# 解压后进入目录
dsh plugin --profile web add ./

# 校验装的是不是这份
md5sum "$DSH_HOME/profiles/web/node_modules/dsh-purge/lib/core.js"
# 期望：66479dbe1716c69ade88ac851331b19a
```

改完**重启 DSH** 生效。

## 安装 B：手机 dsh-go（Android）

手机上的环境与桌面不同，注意三点：

1. 引擎跑在 **proot** 里：`DSH_HOME=/root/.dsh`，引擎目录 `/opt/dsh`，不是普通 Linux 路径。
2. **dsh-go App 没有终端页**，插件页也只能从市场安装 npm 包 →
   **安装命令必须由 DSH 里的智能体代跑**（或任何能进入该 proot 的 shell）。
3. 原生界面需要 **dsh-go 桥接**（本机引擎自带；远程主机一般没有）。

```sh
# 让 DSH 里的智能体执行（把包放到手机存储后解压）
cd /sdcard/Download/<解压目录>
dsh plugin --profile web add ./

md5sum "$DSH_HOME/profiles/web/node_modules/dsh-purge/lib/core.js"
# 期望：66479dbe1716c69ade88ac851331b19a
```

然后**重启引擎**（App「引擎」页 → 重启引擎）。

### 手机原生界面（可选，推荐）

`native-ui/` 里两个插件把插件界面搬到**手机原生界面**——原版只有网页界面，手机上看不到：

| 插件 | 提供 |
|---|---|
| `local-purge-ui` | 输入框上方「**清洗**」胶囊 + 一行**状态条**（点开面板）+ 清洗面板（已生效 / 待应用 / 本机无目标三个数字，未生效的按层分组，每条写明原因和怎么处理；可应用 / 还原 / 刷新 / 复制状态） |
| `local-purge-more` | 「**破甲内容**」胶囊 + 3 个面板（提示词 / 规则集 / 技能库） |

```sh
mkdir -p "$DSH_HOME/dsh-go/plugins"
cp -a native-ui/local-purge-ui native-ui/local-purge-more "$DSH_HOME/dsh-go/plugins/"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-purge-ui"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-purge-more"
```

**注意**：这两个是 `link:` 安装，**目录不能删**。装完重启引擎，输入框上方出现
「清洗」「破甲内容」两个按钮。

> 这两个插件只做界面与本地文件读写，**不会**改宿主代码、不会关审批。
> 「应用清洗」需要二次确认，效果等同 `dsh-purge --apply`。

---

## 使用

```sh
dsh-purge --status      # 看状态：哪些补丁已打、注入文件情况
dsh-purge --apply       # 启用代码级补丁（改宿主源码，留 .bak）
dsh-purge --revert      # 逐字节还原宿主
dsh-purge --uninstall   # 卸载（你的内容移到隔离目录，不删）
dsh-purge --edit        # 编辑注入文案
```

**重要**：`--apply` 之后必须**重启 DSH** 才生效（引擎启动时把代码读进内存）。
停用插件（App 里拨开关）**不会**撤销补丁——补丁是磁盘上的改动，必须 `--revert`。

```sh
dsh-purge --status --json   # 机器可读：patch_tally（7 分类 + na + total）与逐条 rows
dsh-purge --check           # 只算不写：这次 apply 会动哪些文件、哪些补丁对不上
```

---

## 补丁状态（7 分类）

每条补丁先按它的**所有目标文件**判出一个分类，再汇总成 `patch_tally`
（`--status --json`、面板、状态条读的都是同一份快照）。分类顺序即 `patch_tally` 与 `--check` 明细的排序；
面板现在按「层」分组（见下文「按层分组」），每条的原因仍按这张表：

| 分类 | 含义 | 旧状态（本分支之前） |
|---|---|---|
| `applied` | 锚点已替换 / 目标文案已存在，不用再写 | `applied` |
| `pending` | 要替换的原文还在，还没打上 | `pending` |
| `partial` | 多文件补丁只落地了一部分 | `skipped`（一部分文件打上了） |
| `drifted` | 命中补丁自己写的 `forbid` 标记：产物被别的改动弄脏，重打才有意义 | 以前没有这一档，只能报成 `skipped` |
| `no_needle` | 文件能读，但搜不到要替换的那一句（宿主版本不同 / 已被别的补丁改写） | `skipped`、`unmatched` |
| `no_file` | 目标文件登记了却读不到（被删 / 正在被替换） | `missing_file` |
| `no_pkg` | 这套宿主压根没装该补丁指向的包 | `missing_file`（键一个都没登记） |
| `na` | 当前宿主不需要该补丁（第 8 个桶：不计入 7 分类，但计入 `total`） | `na` |

一句话：**旧的 6 类（`applied` / `pending` / `skipped` / `unmatched` / `missing_file` / `na`）没有消失，
只是 `skipped` 被拆成了 `partial`、`drifted`、`no_needle`，`missing_file` 被拆成了 `no_file` 与 `no_pkg`。**
以前一个「跳过」同时盖了四种完全不同的修法：要重打的、只打了一半的、版本对不上的、包没装的。

旧字段（`patches_applied` / `patches_pending` / `patches_skipped` / `patches_na` / `patches_total`、
`patch_status`、`display_*`）全部保留、数值不变，老脚本和老的 `--status` 文本照旧能读。

### 每条补丁的原因和怎么处理

分类是给程序看的；面板和 `--check` 还会给每条补丁多写一句原因（`row.reason`）和一句怎么处理（`row.advice`）。
文案全部由 `lib/patch-report.js` 的 `explainPatchRow()` 按**行上的真实数据**拼出来：
`row.counts`（每个分类各几个文件）、`row.files[].kind`（到底哪几个文件 / 哪个包）、
补丁自己声明的 `strictFiles` / `softSettle` / `kind`，以及 `status` 与 `category` 不一致的情形（钩子旁路被关掉时）。
推不出来的信息（比如宿主版本号）不会写进文案，也不拿数字凑。

| 分类 | 面板 / `--check` 里长什么样 | 下一步 |
|---|---|---|
| `applied` | 「N 个文件都已经是新写法，这条补丁已经打上了。」 | 不用管 |
| `pending` | 「N 个文件里的原文还在，点「应用清洗」就能打上。」 | 可以再打一次 |
| `partial` | 「这条补丁要改 N 个文件：其中 M 个找不到原文，还有 P 个没打。」 | 还有没打的就再打一次，否则需要你自己确认 |
| `drifted` | 「「dsh-tool-fs/lib/index.js」里的内容已经被别处改过（碰到了禁用标记），再打会冲突；建议先还原，再重新应用。」 | 需要你自己确认 |
| `no_needle` | 「这条补丁要找的原句在「dsh-web-app/lib/index.js」里已经不存在了（宿主换了写法，或被别的补丁改过）。这不是失败，可以不用处理。」 | 不用管（要求严格匹配的，需要你自己确认） |
| `no_file` | 「补丁登记了要改的文件，但现在读不到（dsh-xxx/lib/index.js），可能在升级时被换掉了。」 | 需要你自己确认 |
| `no_pkg` | 「这台机器没装它要改的包（dsh-settings），这条补丁用不上，不用管。」 | 不用管 |

`--check` 的文本输出直接打印这句话（`row.reason`）；`--status --json` / `--check --json` 的 `rows[]`
带 `reason` / `advice` / `advice_code` / `advice_tone`，脚本可以直接读。

### 按层分组（身份 / 审批 / 沙箱 / 工具 / 界面 / 其他）

补丁表上的 `layer` 只有「提示词 / 代码 / 工具 / 0.1.5、0.2.0 兼容」，按它分组等于按实现手段分类，
用户想知道的是「身份句改掉没」「审批还拦不拦」。所以报告层再叠一层语义分组
（`PATCH_LAYERS` / `patchLayerKey()`）：先看补丁自己写的 `name`，名字认不出来再看它要改的包
（`row.files[].key`），都认不出来落进「其他」——不按 id 硬编码，也不猜。

- 顺序固定：**身份 → 审批 → 沙箱 → 工具 → 界面 → 其他**。
- 每层一行「层名 已生效/总数」，层内只列未生效条目（每条带原因与建议）。
- 守恒：每条补丁恰好落进一层，`groupRowsByLayer()` 的 `total` 加总 = `patch_rows.length` = 84。
- 这只是**展示**用的：判定、计数、`apply` / `revert` 全都不读它。

**CLI 侧不用改**：`bin/dsh-purge.js` 只是消费 `gatherState()` 的 `patch_rows`，
`--status --json` 的 `rows[]` 现在自带 `layer_key` / `layer_group` / `reason` / `advice`，
层名与排序在报告层就定了；`--status` 与 `--check` 的文本排序仍按 7 分类（能动手的排前面），
要按层看就上面板或读 JSON 的 `layer_group`。

### 面板与状态条的读数从哪来

- **面板**：`gatherState()` 输出的 `patch_tally`（7 分类 + `na` + `total`）与 `patch_rows`
  （逐条：`id` / `name` / `category` / `reason` / `files`，不含文件正文）。
- **三个 metric**：已生效 = `tally.applied`；待应用 = `tally.pending`；
  本机无目标 = `tally.no_pkg + tally.na`（这套宿主没有它的位置）。
- **未生效明细**：按 6 层分组，每层一行「层名 已生效/总数」（没事的层只留这一行），
  层内最多 6 条未生效条目，每条副标题是原因，右侧是「可以再打一次 / 不用管 / 需要你自己确认」；
  整张列表一次最多 50 行（原生视图协议上限），超出的折成一行「另有 N 条未列出」。
  `applied` 与 `na` 不进明细，只体现在层标题的分子里。
- **刷新**：面板的「刷新」会先 `invalidatePatchCache()`，再用 `gatherState({ fresh: true })` 重扫，
  所以看到的是此刻的磁盘，不是 30 秒缓存。检测缓存的键含宿主目录，换宿主不会串。
- **状态条**：只读插件进程内那份快照（面板上一次读取的结果），每 20 秒重画一行，
  **不扫磁盘、不触发检测**。冷启动时显示「清洗 · 待读取」，打开一次面板后就有数。

---

## 卸载 / 还原

```sh
dsh-purge --revert       # 先还原宿主代码
dsh-purge --uninstall    # 再卸载插件
dsh plugin --profile web remove dsh-purge
```

`--uninstall` **不会静默删除你的内容**：
- 插件自有状态（`$DSH_HOME/dsh-purge/`）→ 删除
- 你改过的 `prompt-inject.md`、自建技能/预设 → 移到 `$DSH_HOME/dsh-purge-uninstalled-<时间戳>/`，内含 `manifest.json` 与 `RESTORE.txt`

---

## 常见问题

**Q：重启后每轮报 `unknown prompt variable`**
说明 profile 里的 system-prompt 配置带了宿主未注册的变量。强制重装：

```sh
dsh plugin --profile web remove dsh-purge
dsh plugin --profile web add ./
md5sum "$DSH_HOME/profiles/web/node_modules/dsh-purge/lib/core.js"
```
（`pnpm` 有时会因「同一路径」跳过重装，所以要先 remove。）

**Q：红队模式不在下拉里**
看 `$DSH_HOME/redteam/preset-declare.json` 的 `ok` 是否为 `true`；`broken` 字段会写明哪一行出错。

**Q：`--apply` 之后想反悔**
`dsh-purge --revert`，然后重启。

**Q：停用插件后为什么补丁还在**
停用只是不加载插件；补丁改写的是宿主源码，需 `--revert` 才会撤销。

---

## 署名与许可

- **原始项目**：`dsh-purge` · 作者 **小杨** · MIT License（见 [LICENSE](LICENSE)）
- **原仓库**：`https://github.com/YuJunZhiXue/dsh-purge`（当前不可访问）
- 原项目要求：借用其名称、思路、代码或提示词**必须署名并标明来源**。
  本分支据此保留 LICENSE 原文，并在本 README 顶部与 CHANGELOG 中标注来源。
- 本分支的改动同样以 MIT 发布；**上游免责声明与合规使用声明继续适用**，
  见 [README.upstream.zh-CN.md](README.upstream.zh-CN.md)。

## 上游文档

原版完整使用文档（界面预览、工作原理、红队演练台等）保留在：
- [README.upstream.md](README.upstream.md)（English）
- [README.upstream.zh-CN.md](README.upstream.zh-CN.md)（中文）
- [release-notes.md](release-notes.md)（版本历史）
