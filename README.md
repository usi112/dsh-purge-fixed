# dsh-purge 1.1.72 — 修复分支 · 专为 DSH Go 适配

> 📱 **本项目主要面向 [DSH Go] 手机版（dsh-go，Android + proot Ubuntu）适配与验证。**
> 全部修复与测试都在真实 dsh-go 手机上完成（App 1.0.15 / DSH 0.2.2-rc.1 / Node 24.22.1），
> 并附带两个**手机原生界面**插件——原版只有网页界面，手机上根本看不到。
> 桌面 / Web 端同样可用，但没有针对它做过同等强度的实测。
>
> 🌐 [English README](README.en.md)

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
| `local-purge-ui` | 输入框上方「**清洗**」胶囊 + 清洗面板（看真实状态 / 补丁计数 / 逐条明细，应用 / 还原 / 复制状态） |
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
