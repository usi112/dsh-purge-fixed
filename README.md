# dsh-purge 1.1.75+upstream.1.1.71 — 基于上游 1.1.71 的修复分支

这是我给自己手机折腾出来的一个分支。上游 [dsh-purge](https://deepseek.stream/plugins/dsh-purge) 是 小杨 写的（MIT），
在桌面跑得好好的，搬到 DSH Go（Android + proot）上装完就崩。我就一点点修过来，顺手把手机上看不到的那部分界面
补成了原生面板。

它做两件事，性质完全不同，别混着看：

- 往系统提示词里塞一份「人设 + 规矩」，让模型的拒绝少一点。**装上就生效。**
- 可选地改 DSH 安装目录里的源码，把审批和沙箱那几道闸拆掉。**要你自己敲 `--apply`。**

我这边跑的环境：DSH Go App 1.0.15、DSH 0.2.2-rc.1、Node 24.22.1、proot Ubuntu 24.04。
只在手机上真机验过，桌面和网页版能装能跑，但没做过同等强度的实测。

版本号 `1.1.75+upstream.1.1.71`：加号后面是它基于的上游版本，前面是我这边的发布序号，两个不是一回事。
每版干了什么写在 [release-notes.md](release-notes.md) 和 [Releases](https://github.com/usi112/dsh-purge-fixed/releases)；
版本规则见 [docs/versioning.md](docs/versioning.md)。只改措辞或文档，不动版本号。

上游作者 小杨 的署名和 LICENSE 都保留着。原仓库 `YuJunZhiXue/dsh-purge` 现在打不开了，
所以我按上游的署名要求把改动逐条列在 [CHANGELOG-fixes.md](CHANGELOG-fixes.md)。
本分支没改破甲规则正文（人设、18 组分类、拒绝话术那些都原样）。

## 装之前先想清楚

- 这是破甲插件，靠压低模型的拒绝来达到目的。
- `--apply` 会直接改 DSH 源码：审批不再问你，沙箱的文件写入限制也会放开。
- 后果之一是模型可能覆盖你还没读过的文件。这是某条补丁故意做的，不是 bug。
- 每个被改的文件旁边会留 `<文件名>.dshpurge.bak`，`--revert` 能逐字节还原。
- 别放在重要数据或需要审计的机器上开。

## 为什么手机上要单独修一遍

三个坑，都是实际踩出来的：

1. 原版往提示词里写 `{{cwd}}`，但 0.2.2-rc.1 只认 `provider` 和 `model`，变量一插就抛错，整轮对话直接失败。
2. 红队预设里有两行接口对不上，宿主把整份预设判成坏的，于是 App 的下拉里看不到红队模式。
3. 插件的界面是网页版的，手机上是 Flutter 原生界面，等于没有界面。

前两个改文本就能好，第三个得另写。`native-ui/` 里那两个原生插件就是干这个的。

## 相对 1.1.71 改了什么

一处崩溃，加一堆在新宿主上的错位。改动集中在 11 个文件，逐条列在 CHANGELOG-fixes.md，这里只说结果：

- 5 处 `{{cwd}}` 全部处理掉：拿得到真实路径就写真实路径，拿不到就写固定文案。
- `postPrompt` 段不再交给宿主插值，用户写什么花括号都不炸。
- 转义函数原来有边界漏洞（`{{{cwd}}}` 能穿过去），改成按整段花括号判断。
- 红队预设删掉两行失效接口，叶子约束交给 `maxDepth`。
- 自愈逻辑会重复插同一句话，改成转义和未转义都认。
- 6 条在新宿主上找不到原文的补丁，按实际源码重写了锚点。
- 版本声明从 `dshTarget` 换成 `engines.dsh`，不兼容时安装阶段就能看出来，不用等运行期崩。
- 卸载不再留注入文件、技能库、预设目录；可能属于你的东西挪到隔离目录，附 `RESTORE.txt`。
- 还原时把与原文逐字节相同的 `.bak` 清掉，宿主目录不积垃圾。
- zip 里的反斜杠路径改成 posix，安卓解压不会摊平。

## 环境

Node >= 22，DSH `>=0.2.1-rc.2 <0.3.0-0`。手机上实测 `DSH_HOME=/root/.dsh`，引擎在 `/opt/dsh`。

## 安装

桌面 / 网页版，解压后进目录：

```sh
dsh plugin --profile web add ./
md5sum "$DSH_HOME/profiles/web/node_modules/dsh-purge/lib/core.js"
# 应为 66479dbe1716c69ade88ac851331b19a
```

手机上麻烦一点：引擎在 proot 里，App 又没有终端页，所以下面几条命令得让 DSH 里的智能体替你跑
（或者任何能进这个 proot 的 shell）。把包放进手机存储、解压，再执行：

```sh
cd /sdcard/Download/<解压目录>
dsh plugin --profile web add ./
md5sum "$DSH_HOME/profiles/web/node_modules/dsh-purge/lib/core.js"
```

两种装法都要重启 DSH 才生效。

### 原生界面（可选）

手机上看不到网页版界面，这两个插件补的是这块：

- `local-purge-ui`：输入框上方一个「清洗」按钮、一条状态条。点开是清洗面板，能看哪些补丁没打上、为什么，
  也能应用和还原。
- `local-purge-more`：「破甲内容」按钮，点开看提示词、规则集、技能库。

```sh
mkdir -p "$DSH_HOME/dsh-go/plugins"
cp -a native-ui/local-purge-ui native-ui/local-purge-more "$DSH_HOME/dsh-go/plugins/"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-purge-ui"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-purge-more"
```

装的是 `link:`，所以目录别删。重启引擎后输入框上方会出现「清洗」「破甲内容」两个按钮。
它们只画界面、读写本地文件，不会自己去改宿主代码；「应用清洗」要点确认，效果跟 `dsh-purge --apply` 一样。

## 用法

```sh
dsh-purge --status      # 现在什么状态
dsh-purge --apply       # 打补丁（会改宿主源码，留 .bak）
dsh-purge --revert      # 原样还原
dsh-purge --uninstall   # 卸载，你的东西挪到隔离目录
dsh-purge --edit        # 改注入正文
```

`--apply` 之后一定要重启 DSH，否则跑的还是内存里的旧代码。
在 App 里把插件开关关掉，不会撤销已经打上的补丁——那些是磁盘上的改动，得 `--revert`。

```sh
dsh-purge --status --json   # 机器可读：patch_tally（7 分类 + na + total）和逐条 rows
dsh-purge --check           # 只算不写：这次 apply 会动哪些文件、哪些补丁对不上
```

---

## 补丁状态怎么看

每条补丁先按它要改的所有文件判一个状态，再合成一份统计（`patch_tally`）。命令行、面板、状态条
读的都是同一份，不会出现「面板说 5 条、命令行说 7 条」。

| 状态 | 意思 | 本分支之前的叫法 |
|---|---|---|
| `applied` | 已经打上了，不用再动 | `applied` |
| `pending` | 原文还在，还没打 | `pending` |
| `partial` | 要改多个文件，只改中一部分 | `skipped`（一部分打上了） |
| `drifted` | 文件被别处改过，现在重打会冲突 | 以前没有这一档 |
| `no_needle` | 文件能读，但找不到要替换的那句 | `skipped`、`unmatched` |
| `no_file` | 登记了要改的文件，但现在读不到 | `missing_file` |
| `no_pkg` | 这台机器根本没装它要改的包 | `missing_file` |
| `na` | 当前环境不需要这条（单独一个桶，算进总数） | `na` |

原来的 6 个状态没有删，只是拆细了：`skipped` 拆成 `partial` / `drifted` / `no_needle`，
`missing_file` 拆成 `no_file` 和 `no_pkg`。以前一个「跳过」把四种完全不同的情况盖在一起——
要重打的、只打了一半的、版本对不上的、包没装的，处理方式完全不同。

老字段都还在（`patches_applied`、`patches_pending`、`patches_skipped`、`patches_na`、`patches_total`、
`patch_status`、`display_*`），数值没变，旧脚本和旧的 `--status` 输出照常能读。

### 每条补丁为什么没打上

面板和 `--check` 会给每条补丁写一句原因、一句怎么处理。原因是从这条补丁的实际数据里拼的：
每类各几个文件、是哪几个文件、补丁自己声明的 `strictFiles` / `softSettle` / `kind`。
推不出来就不写，不拿数字凑——比如宿主版本号，读不到就不提。

| 状态 | 面板 / `--check` 里看到的话 | 怎么办 |
|---|---|---|
| `applied` | 「N 个文件都已经是新写法，这条补丁已经打上了。」 | 不用管 |
| `pending` | 「N 个文件里的原文还在，点「应用清洗」就能打上。」 | 可以再打一次 |
| `partial` | 「这条补丁要改 N 个文件：其中 M 个找不到原文，还有 P 个没打。」 | 还有没打的就再打一次，否则需要你自己确认 |
| `drifted` | 「「dsh-tool-fs/lib/index.js」里的内容已经被别处改过（碰到了禁用标记），再打会冲突；建议先还原，再重新应用。」 | 需要你自己确认 |
| `no_needle` | 「这条补丁要找的原句在「dsh-web-app/lib/index.js」里已经不存在了（宿主换了写法，或被别的补丁改过）。这不是失败，可以不用处理。」 | 不用管（要求严格匹配的，需要你自己确认） |
| `no_file` | 「补丁登记了要改的文件，但现在读不到（dsh-xxx/lib/index.js），可能在升级时被换掉了。」 | 需要你自己确认 |
| `no_pkg` | 「这台机器没装它要改的包（dsh-settings），这条补丁用不上，不用管。」 | 不用管 |

`--check` 的文本输出会直接打印这句话；`--status --json` / `--check --json` 的 `rows[]` 里字段是
`reason` / `advice` / `advice_code` / `advice_tone`，脚本可以直接读。

### 按层看

补丁表里原来的 `layer` 只有「提示词 / 代码 / 工具 / 兼容」这种，按它分组跟按实现手段分类差不多，
但你想知道的是「身份句改了没」「审批还拦不拦」。所以报告里再按语义分一层：
身份 / 审批 / 沙箱 / 工具 / 界面 / 其他。先看补丁名字，认不出来再看它改哪个包，都不认就归到「其他」。

- 顺序固定：身份 → 审批 → 沙箱 → 工具 → 界面 → 其他。
- 每层一行「层名 已生效/总数」，层内只列没生效的。
- 84 条一条不丢，每条只属于一层。
- 只是展示用：判定、计数、`--apply` / `--revert` 都不读它。

命令行仍按状态排序（能动手的排前面）。要按层看，开面板，或者读 JSON 里的 `layer_group`。

### 面板上的数字

- 三个数：已生效、待应用、本机无目标（`no_pkg + na`，也就是这台机器没有它的位置）。
- 明细按层分组，每层最多 6 条，整张列表最多 50 行（原生视图的上限），超出的折成「另有 N 条」。
- 面板的「刷新」是清缓存后重新扫盘，不是重画一遍旧数据。
- 状态条只读面板上一次读到的结果，20 秒重画一行，不扫磁盘。刚启动还没读过时显示「清洗 · 待读取」。

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
