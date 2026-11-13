# 社区版补丁集对照：还要不要再加补丁

> 调研对象：本仓库 `dsh-purge-fixed`（衍生自 `dsh-purge` 1.1.71，原作者 小杨，MIT）与 GitHub 上三个同源分支。
> 目标版本：本机 DSH `0.2.2-rc.1`（`/opt/dsh/node_modules/@deepseek-ai`，手机 proot 环境，只读核对）。
> 结论先说：**要加，但只加 3 条新补丁 + 3 处重锚定；上游 6 条里 1 条对手机不适用、1 条是行为反转要单独决策。**

---

## 1. 来源清单

全部公开仓库，用 `git clone --depth 1` 落到 `/tmp` 读源码，本仓库未引入任何上游代码。

| # | 仓库 | 版本 / 最后提交 | 许可证 | 补丁条数 | 补丁表结构 |
|---|------|----------------|--------|---------|-----------|
| S1 | [LanJinGod/dsh-purge](https://github.com/LanJinGod/dsh-purge) | `1.1.73+dsh0.2.1`（8023a74，2026-10-18） | MIT（`Copyright (c) 2026 小杨`） | **82** | 单文件 `lib/core.js`，四个数组 `PATCHES` / `CODE_PATCHES` / `ENGINE_PATCHES` / `NEW_TOOL_PATCHES` |
| S2 | [kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge)（npm 名 `dsh-purge-community`） | `1.6.97`（003ae68，2026-11-13） | MIT（`Copyright (c) 2026 小杨`） | **86** | 已拆分：`lib/patches/{prompt,code,engine,new-tools,opt-in,shared,index}.mjs` |
| S3 | [NANA7MI0/dsh-purge-go](https://github.com/NANA7MI0/dsh-purge-go) | `0.4.1`（4922ce6，2026-11-13） | AGPL-3.0（整仓，含 MIT 上游内容再分发） | **87** | 数据与执行器分离：`patches/patches.json`（导出数据）+ `patches/purge-patch.mjs`（probe/apply/restore）+ `lib/*.mjs`（dsh-go 适配层） |

三条来源的关系（S3 的 `NOTICE` 自述，[原文](https://github.com/NANA7MI0/dsh-purge-go/blob/main/NOTICE)）：注入层来自 LanJinGod，引擎补丁定义导出自 S2 的 `v1.6.93`（当时 83 条），S3 自己补了 1 条凑到 87。

**关键事实：S1 与本仓库 id 完全相同（1–88 共 82 条，逐条同名同目标），S1 不是「更全的上游」，而是同一代代码的另一个 fork。真正的「社区维护版」是 S2。**

### 1.1 我们现在的基线（实测，不是估计）

在真机上跑只读自检（不写宿主）：

```bash
node bin/dsh-purge.js --check            # 插件根未找到 → 82 条全判「不适用」
DSH_BASE=/opt/dsh/node_modules/@deepseek-ai node bin/dsh-purge.js --check
```

后者才是真实读数：

```
已落地 58  待应用 0  部分 5  漂移 0  原文不对 7  文件缺失 0  包缺失 7  不适用 5  合计 82
```

未落地的 19 条：partial `#36 #50 #57 #62 #86`；no_needle `#32 #53 #54 #60 #74 #77 #80`；no_pkg `#28 #30 #31 #64 #65 #71 #76`（梁神/hooks/unrestricted 预设——手机宿主没装这些包）；na `#78 #82 #85 #87 #88` 一类。

**所以「要不要加补丁」前先看清：本仓库当前不是 82 条全生效，是 58 条生效 + 12 条对本机无效 + 12 条需要修。** 上游 S2 相对我们多出来的东西，一半是「新补丁」，一半正是「这 12 条的修法」。

---

## 2. 分类对照表

按「作用对象 + 目的」分类。上游指 S2（86 条）与 S3（87 条）；「我们」= 本仓库 82 条。

| 类 | 内容 | 上游 id | 我们 id | 判定 |
|----|------|---------|---------|------|
| A 提示词文案 | 免责声明、身份句、persona、各预设身份、审批提示句、代理会话框定、计划模式、交付物 | 1 2 3 4 5 11 12 25 26 32 33 34 36 37 40 43 50 53 54 61 63 70 71 73 76 + **93 94** | 1 2 3 4 5 11 12 25 26 32 33 34 36 37 40 43 50 53 54 61 63 70 71 73 76 | 已有等价物；**93/94 我们没有** |
| B 审批与沙箱 | 沙箱模式默认、审批策略、升级阶梯、fs 围栏、观察意图、fail-open | 6 7 8 9 10 13 14 15 16 17 35 51 60 62 | 同左 | 已有等价物；**#60/#62 在本机 no_needle（针已换位置）** |
| C 工具 schema 与工具行为 | bash/pwsh 话术、read 上限、subagent 深度、hooks deny、web 工具 untrusted、极简工具表、run_code 审批、ask_user 等待 | 21 22 23 24 29 30 31 48 64 65 80 + **89** | 21 22 23 24 29 30 31 48 64 65 80 | 已有等价物；**89 我们没有** |
| D 界面与客户端 | web 面身份、回退（rewind）、会话日志上传、cookie 名、对话气泡 | 52 56 77 + **91** | 52 56 77 | 已有等价物；**91 我们没有** |
| E 引擎内部行为 | 系统提示替换、assemble 时序、render/messages 兜底、deepseek role、模型流、auto review、插话 steering、挂载针 | 18 19 55 57 58 59 66 67 68 69 72 74 78 85 86 87 88 + **90** | 18 19 55 57 58 59 66 67 68 69 72 74 78 85 86 87 88 | 已有等价物；**90 我们没有，且它是来替代 85/86 的** |
| F 兼容与桌面生命周期 | 0.1.5/0.2.0 兼容、desktop update、host 关闭、profile 兜底、header 限制、退出追踪 | 38 39 42 45 46 47 49 82 83 84 + **92**（S3 的 92/93 是退出追踪） | 38 39 42 45 46 47 49 82 83 84 | 已有等价物；**92 我们没有，但目标包 `dsh-desktop-shell` 在手机上不存在** |
| G 保护项互斥（opt-in） | 关重复调用提醒、关工具结果修剪 | 18 19（S2 移到 `opt-in.mjs`，标 `optIn: true` `disabledByDefault: true`） | 18 19（普通条目，默认打） | **我们不需要**：这两条删的是上下文保护，长会话会把工具输出全塞回上下文；S2 自己注释写「不是闸」 |

### 2.1 上游有我们没有：逐条（S2 差集实测）

按 id 集合求差：`S2 \ 我们 = {89, 90, 91, 92, 93, 94}`，`我们 \ S2 = {85, 86}`（被 90 取代）。

| 上游 id | 名称 | 层 | 目标包 | 在本机 0.2.2-rc.1 的针 |
|---|---|---|---|---|
| 89 | `ASK_USER_WAIT_CAPPED` | 工具 | `dsh-tool-ask-user` | ✅ 命中 `validateTimeout(args.timeout ?? defaultTimeout)` |
| 90 | `RESTORE_NATIVE_STEERING` | 代码 | `dsh-api-session-controller` + `dsh-agent-loop` | ✅ 两处锚点都在（`current turn no longer accepts steering`、`agent.inbox.remove(request.itemId)`） |
| 91 | `BROWSER_COOKIE_NAME_IGNORE_PORT` | 代码 | `dsh-client-connection` | ✅ 命中 `encodeBase64Url(createHash("sha256").update(authority)…)` |
| 92 | `HOST_MAX_HTTP_HEADER_SIZE` | 代码 | `desktop-shell` | ❌ 目标包缺失（手机无桌面壳） |
| 93 | `SANDBOX_POLICY_BRAND_NEUTRAL` | 提示词 | `dsh-sandbox-policy` | ✅ 三条文案逐条命中 |
| 94 | `SKILL_BADGE_DESCRIPTION_NEUTRAL` | 提示词 | `dsh-skill-badge`（本机还有 `dsh-experimental-badge-skill-bundle` 同文案） | ✅ 命中 `powered by dsh` |

### 2.2 同一个补丁，上游换了目标文件（我们的针因此失效）

这四条不是「新补丁」，是**同一个 id 的重锚定**，S2 已经做完了：

| id | 我们的目标包（针已不在） | S2 的目标包 | 本机实际位置（实测） |
|---|---|---|---|
| 32 `WEB_SURFACE_IDENTITY_NEUTRAL` | `dsh-web-app` | `harness-dev-context` + `web-app-lib` | ✅ `dsh-harness-dev-context`（句子被拆成 `prefix:` 字段） |
| 53 `WEB_SURFACE_PROHIBITION` | `dsh-web-app` | `harness-dev-context` + `web-app-lib` | 同上包 |
| 54 `DELIVERABLE_DO_NOT` | `dsh-client-ui-deliverables` | `deliverable-file-references` | ⚠️ 0.2.2 已自行取消「Do not call present」禁令，改成正向鼓励 → **不需要修** |
| 60 `OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL` | `dsh-tools` / `dsh-tools-ptc` | `ptc-tool` | ✅ 文案现在 `dsh-tool-executor-ptc` |
| 62 `OFFICIAL_TOOL_ASK_FAILOPEN` | `dsh-tools-pipeline` | `dsh-tools-pipeline` + `dsh-tools-pipeline-types` | 部分失效，需人工核 |

---

## 3. 候选补丁清单

排序依据：**收益 / 风险 / 工作量**（收益高、风险低、工作量小者在前）。
「锚点」只描述行为与位置，不抄上游替换文本（版权要求见 §4）。

### AP-01 `SANDBOX_POLICY_BRAND_NEUTRAL`（对应上游 S2 #93）— 建议做

- **解决什么问题**：模型每一步读到的文件策略文案自称「DSH 产品 + DSH 文件沙箱」，持续给模型建立「你是某个有品牌的产品、有个叫 DSH 沙箱的东西在管你」的锚点。S2 的定位是只去品牌词、**放行语义一字不动**（见其 release-notes 对 #93 的说明）。
- **手机 0.2.2-rc.1 是否适用**：适用。`dsh-sandbox-policy/lib/index.js` 第 88/92/94 行三条分支（read-only / workspace-write / danger-full-access）全部命中，本会话系统提示里也能直接看到未去品牌的原文。
- **锚点**：`dsh-sandbox-policy` 的 `lib/index.js`，三条 case 分支返回字符串：①策略前缀 `Current DSH file policy: ` ②`enforced by the DSH file sandbox` ③`The DSH file sandbox does not restrict`。改法是删品牌词、保留句式和 `approval is auto-granted` 之类的放行语义。
- **与既有补丁的关系**：与本仓库 `#61 OFFICIAL_SANDBOX_POLICY_NEUTRAL` 不相交（#61 改的是 read-only 分支的拦截句），两者顺序无关；但落盘后 `#61` 的 forbid 检查要复核一次。
- **风险**：低。纯文案；唯一风险是宿主下次改文案后变成 no_needle（不破坏功能）。
- **验收**：`--check` 显示该 id `applied`；`grep -c "DSH file sandbox" dsh-sandbox-policy/lib/index.js` 应为 0；新开会话读系统提示确认策略句仍在、`approval is auto-granted` 仍在；`--revert` 后字节还原。
- **工作量**：0.5 人时（3 条 replacements + marker）。

### AP-02 `ASK_USER_WAIT_CAPPED`（对应上游 S2 #89）— 建议做

- **解决什么问题**：`ask_user_question` 的 `timeout` 允许 `-1`（无限等待）。模型一旦给 `-1`，这一轮就永久挂在等人回答上——手机上表现为「转圈不动、要手动打断」。S2 的做法是尊重模型给的正面值，只把 `-1` 收成 300 秒。
- **手机 0.2.2-rc.1 是否适用**：适用且比桌面更要紧。`dsh-tool-ask-user/lib/index.js:181` 就是 `validateTimeout(args.timeout ?? defaultTimeout)` 原样；`validateTimeout` 明确接受 `-1`（第 8–11 行）。
- **锚点**：`dsh-tool-ask-user` 的 `lib/index.js`，`execute()` 里求 `timeout` 的那一行——把「原样透传 `args.timeout`」改成「`-1` 换成上限值，其余透传」。另需一条去旧写法：老版本被别的分支改成硬编码 1 秒的写法要能迁回来（我们仓库没打过硬编码版，第二条可选）。
- **风险**：低—中。①`-1` 语义从「无限等」变「最多 5 分钟」，长思考的用户可能被打断后拿到 `pending`（宿主本来就有 pending 分支，不报错）；②若宿主后续把 `-1` 用于别的流程，会一起被收。
- **验收**：`--check` 为 `applied`；单元验证：直接 import 该工具，构造 `timeout: -1` 断言传给 `ctx.userQuestions.askTimed` 的毫秒数是正数且 ≤300000；`timeout: 30` 仍为 30000；`--revert` 幂等。
- **工作量**：1 人时（含一条断言脚本）。

### AP-03 `#32 / #53 / #60` 重锚定（不是新补丁，是修现有 12 条）— 建议做

- **解决什么问题**：本仓库 `#32 WEB_SURFACE_IDENTITY_NEUTRAL`、`#53 WEB_SURFACE_PROHIBITION`、`#60 OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL` 在 0.2.2-rc.1 已是 no_needle——网页面身份句还在，模型仍自称「DeepSeek Harness Web GUI」。对「破甲仓库」来说这是核心项失效，不是可选项。
- **手机是否适用**：适用。身份句现在住在 `dsh-harness-dev-context`（`prefix: "You are interacting with the user through the DeepSeek Harness Web GUI at "`），`run_code` 沙箱加宽话术现在住在 `dsh-tool-executor-ptc`。
- **锚点**（行为描述，不抄文本）：`#32/#53` 增加 `harness-dev-context` 目标（该包 `lib/index.js` 里以 `prefix:` 字段给出的网页面身份句，以及 Web GUI 的规范 URL 描述），保留旧 `web-app-lib` 目标做兼容；`#60` 增加 `dsh-tool-executor-ptc`（PTC 执行器的沙箱加宽句）并把旧 `dsh-tools-ptc` 标 optional。
- **风险**：中。①同一句话在两个包里各有一份（`web-app-lib` 旧的已不在，但 `harness-dev-context` 与 `experimental-badge-*` 这类「一文案多包」现象普遍），漏一个就 partial；②`#53` 是「禁止另开服务器」那类禁令句，去掉后模型更敢起本地服务，手机端口冲突概率上升。
- **验收**：`--check` 从 partial/no_needle 变 `applied`（或 `already`）；`grep -rc "DeepSeek Harness Web GUI" /opt/dsh/node_modules/@deepseek-ai/dsh-harness-dev-context/lib/index.js` 应为 0；重启新会话读系统提示，确认身份句改中性、且没有重复挂两段。
- **工作量**：2–3 人时（要逐包核对 + 重跑 fixture 回归）。

### AP-04 `SKILL_BADGE_DESCRIPTION_NEUTRAL`（对应上游 S2 #94）— 建议做（可放第二批）

- **解决什么问题**：官方的「徽章技能」描述里要求模型往交付物/PR 里塞 `powered by dsh` 署名。对二开仓库来说，模型会往用户报告里加别人的品牌署名。
- **手机是否适用**：适用。`dsh-skill-badge/lib/index.js:18` 命中原描述；本机另有 `dsh-experimental-badge-skill-bundle` 带同一句 → 需要 `multiHit`（同一锚点合法出现多次）能力，否则一条补丁只能打一个包。
- **锚点**：`dsh-skill-badge`（如采纳，另加 `dsh-experimental-badge-skill-bundle`）的 `lib/index.js` 中技能 `description` 字段里那段「要求加官方徽章 / 用户要 dsh badge 时也用」的句子，改成中性署名描述。
- **风险**：低。只改技能描述，徽章资源本身不动。
- **验收**：`grep -rc "powered by dsh"` 在这两个包为 0；模型列出技能时不出现徽章义务；`--check` applied。
- **工作量**：1 人时（含给 `patch-report` 加 `multiHit` 支持，若已有则 0.3）。

### AP-05 `RESTORE_NATIVE_STEERING`（对应上游 S2 #90，替代我们 #85/#86）— 观望（需产品决策）

- **解决什么问题**：S2 把「消息一律 followup」判为过度：插话（steer）在 turn 不忙时应该真的插队打断当前步，只在忙/不可用时降级为排队。它同时带**迁移**：见到旧 `[dsh-purge-85]` / `[dsh-purge-86]` 标记会把宿主精确还原成原生写法再打新补丁。
- **手机是否适用**：技术上适用（锚点全在），**但这是我方语义的反转**。我们现在的实机状态是 `#85 applied`（UI 发消息永远新 turn）、`#86 partial`（公共 `steer()` 是 next-step，另一处针已漂）。也就是说手机上现在「插话永不打折」，而 S2 要回到「能插就插」。
- **锚点**：`dsh-api-session-controller` 的 steer 分支（`request.action.kind === "steer"` 的可用性守卫、`agent.inbox.remove(itemId)` 之后的处理）与 `dsh-agent-loop` 的 `steer(input)` 入口；新写法保留原生 `steer`，命中不可用守卫时降级为 `followup`。迁移侧：识别并还原 `[dsh-purge-85]`/`[dsh-purge-86]` 两种旧改写。
- **风险**：中—高。①行为反转，手机上「发消息打断正在跑的 turn」会恢复，用户体感变化；②迁移写错会留下半打状态（`#86` 已经是 partial），最坏情况两条路径语义不一致；③`strictFiles: true` 类补丁一旦针漂会整条不落。
- **验收**：fixture 上 `apply → revert → apply` 幂等；实机 `--check` 后 `#85/#86` 从状态表消失或标 migrated；手工验证三件事：turn 忙时插话进队列、turn 空闲时插话打断、`Ctrl+Enter` 类强制插队不报错。
- **工作量**：4–6 人时（迁移 + 回归）。
- **建议**：**先不做**。等用户明确要「插话打断」再上；现在做等于替用户改交互习惯。

### AP-06 `BROWSER_COOKIE_NAME_IGNORE_PORT`（对应上游 S2 #91）— 观望

- **解决什么问题**：会话 cookie 名把 `host:port` 一起哈希，host 每次用随机端口启动就多一条 `dsh-auth-*` cookie，攒到撑爆请求头上限后本地服务回 431，应用打不开。S2 的做法是 cookie 名只按主机名派生。
- **手机是否适用**：命中锚点（`dsh-client-connection/lib/index.js:336`），但**触发条件在手机上弱**：手机串固定走 `127.0.0.1:3080`，不像桌面每次随机端口。
- **锚点**：`dsh-client-connection` 的 `lib/index.js`，`cookieName(authority)` 里对 `authority` 做 sha256 的那处——改成只取主机名部分再哈希。配套（S2 侧）是 `host` 子进程加 `--max-http-header-size`，那条在手机上无目标包。
- **风险**：中。改 cookie 名 = **所有已登录浏览器会话一次性失效、要重新配对**；手机上是 App 内嵌，可能表现为「要重新授权连接」。另外这是安全边界代码（会话凭证派生），写错会串会话。
- **验收**：改后 `dsh-auth-*` cookie 只剩 1 条且重启不变；重启 5 次 cookie 数量不增；旧 cookie 被清后能正常重连；`--revert` 可逆。
- **工作量**：2 人时。
- **建议**：观望。等真的出现 431 / 应用打不开再上；现在上只换来一次强制重新登录。

### AP-07 `HOST_MAX_HTTP_HEADER_SIZE`（对应上游 S2 #92）— 不做（手机）

- **解决什么问题**：桌面 host 子进程的 `--max-http-header-size` 放宽到 256KB，兜住历史 cookie 累积。
- **手机是否适用**：不适用。目标包 `dsh-desktop-shell` 在本机 `@deepseek-ai` 下**不存在**（已核）。桌面用户才需要；本仓库若同时服务桌面，可作为桌面专属条目 + `optional` 标注保留。
- **风险 / 验收 / 工作量**：桌面侧低风险；本机验收只能是「no_pkg 且不误报失败」。工作量 1 人时。
- **建议**：不做（除非确认本仓库要覆盖桌面宿主）。注意 S2 自己踩过坑：这条锚点在写入后仍然存在，导致每次「应用」都多插一条参数，它后来做了幂等修复——如果将来要做，必须带幂等断言。

### AP-08 `#54 / #74 / #77 / #80` 重锚定 — 部分不做

- `#54 DELIVERABLE_DO_NOT`：**不做**。0.2.2 宿主已自己删掉「Do not call present」禁令，改成「Prefer showing… Use present to publish…」的正向表述，我们的目的已被宿主满足。留着 no_needle 是对的，不该为它造假针。
- `#74 ASSEMBLE_BEFORE_PRESTEP`：**观望**。我们的针 `this.loopCtx.systemPrompt.assemble(` 其实还在 `dsh-agent-loop`，是补丁自带的多针/forbid 组合把它判成 no_needle，S2 换了一整套新针（`this.inbox.claim(...)` 附近）。属引擎时序补丁，改错会串轮次。
- `#77 REWIND_DROP_SENT_ON_APPEND`：**观望**。目标文件 `dsh-client-ui-conversation/lib/client.js` 存在、`append(record)` 还在，针文本变了；S2 有新版针。低收益（回退时消息残留一拍）。
- `#80 MINIMAL_OFFICIAL_TOOLSET`：**观望**。预设 yml 路径存在（`dsh-web-app/presets/minimal.patch.yml` 等），但本机预设内容与 1.1.71 已不同；这条是「撤掉曾追加的 fs/web」，前提是 `#24/#26` 的落地状态，容易连锁。
- 共同风险：都是「改别人的针」，改错比不改更糟（partial 比 no_needle 难诊断）。验收统一为：`--check` 状态改善且 `--revert` 字节还原。

### AP-09 上游的 opt-in 机制（S2 `opt-in.mjs` / 我们的 `optional`）— 不做

S2 把 `#18/#19` 拆成 `optIn: true` + `disabledByDefault: true`，理由写得很直白（其 release-notes）：这两条删的是**上下文保护**，「不是闸」，开了会让长会话把工具输出全塞进上下文。我们现在的 `optional` 字段已经够用，缺的只是「默认不打」这一层。属于机制改进而非补丁，本轮不做；要做得配「面板里一眼能看出哪条是可选项」。

### AP-10 S3 的两条桌面退出追踪（其编号 #92/#93）— 不做

`DESKTOP_HOST_EXIT_TRACE` / `DESKTOP_MAIN_EXIT_TRACE` 只在 `desktop-shell` 里写退出日志，手机无目标包。属于排障增强，与我们 `#83/#84`（host 关闭不报错）是同一片区域，真要做应该一起设计。

### AP-11 S3 的执行器设计（`probe / apply / restore` + 写后 `node --check`）— 借鉴思路，无代码引入

S3 的 `patches/purge-patch.mjs` 有三件事值得抄**思路**：① `probe` 输出按状态分组并落 `patch-probe.json`；② `apply` 前整包备份、失败自动 restore；③ 每个改过的文件跑一次 `node --check`，语法坏了直接回滚。我们已有 manifest 备份 + 写后校验（sha256 + needle/replace 复核），**唯一值得补的是 `node --check` 这种「语法级」复核**——它抓得住「替换文本里引号没配平」这类 sha256 抓不到的错。

### AP-12 顺带发现的自身问题（不是补丁，但影响「要不要加」的判断）

实机验证时发现的 CLI 行为问题，建议转给 CLI/面板那条线：

1. `node bin/dsh-purge.js --check` 在没设 `DSH_BASE` 时识别不到插件根，**82 条全判 `na`，却仍打印「所有补丁都已落地 / nothing to do」**。这是会误导人的：真机上明明只有 58 条生效。
2. `DSH_BASE=/opt/dsh` 会报「不是有效的插件根」，必须给到 `.../@deepseek-ai`，提示语里没说清这一层。
3. 副作用：`--check` 会在当前目录写 `patch-probe.json`（S3 的行为，我们没这问题），我们没有该问题，仅作对照。

---

## 4. 版权与署名

**硬事实**：S1（本仓库直接上游）、S2 都是 MIT，`Copyright (c) 2026 小杨`；S3 整仓 AGPL-3.0（因为它并入了 AGPL 的注入层），但 S3 自己在 `NOTICE` 里写明「如果你只需要补丁层，那部分是独立编写的数据与执行器，可以单独取用」。

因此对本仓库（MIT）来说：

| 可以借 | 只能借思路，不能抄文本 |
|---|---|
| 补丁的**分类方式**（提示词/代码/引擎/工具）、id 命名风格、`marker`/`forbid`/`strictFiles` 这套字段语义——这些是接口与时序约定，且原本就来自我们同源的上游 | `replacements[].pattern` / `.replace` 里的**具体字符串**，尤其提示词整句、SKILL 描述句、策略文案句——这些是上游作者写的文案，逐字复制等于把别人的创作搬进 MIT 仓库 |
| 「该打哪个文件、哪个函数、改什么行为」这类**定位信息**（事实性发现，不构成表达） | `release-notes.md` 的整段说明文字、`desc` 字段的中英文案（要自己重写） |
| S3 的 `probe/apply/restore` **交互设计**（命令名、状态分组、dry-run 语义） | S3 的 `patches/patches.json` 数据文件（整份是 AGPL 仓库的一部分，导进来会污染许可证） |

**具体建议**：

1. **不要**把任何上游 `.mjs` / `patches.json` 复制进本仓库。要加哪条补丁，就照 §3 的「锚点」自己写针、自己写替换文本，并在该条补丁的注释里写清来源仓库 URL + 上游 id（例如 `// 思路来自 kingcharleslzy-ai/dsh-purge #93`）。
2. 新增 `NOTICE`（本仓库现在只有 `LICENSE`，没有 `NOTICE`），内容三行即可：
   - 本项目衍生自 `dsh-purge` 1.1.71，原作者 小杨，MIT，原文链接；
   - 部分补丁的**设计思路**参考了 `kingcharleslzy-ai/dsh-purge`（社区维护版，MIT）与 `LanJinGod/dsh-purge`（MIT），**替换文本为本仓库自行撰写**；
   - 明确「未引入 `NANA7MI0/dsh-purge-go`（AGPL-3.0）的任何代码或数据」——避免别人误以为本仓库受 AGPL 传染。
3. `README.md` §署名与许可 补一句：「本分支新增补丁的来源与授权见 `NOTICE`；每条补丁的 upstream 出处记在 `CHANGELOG-fixes.md` 对应条目」。
4. `CHANGELOG-fixes.md` 每加一条就写一行 `来源：<URL> #<id>（思路）`。这是 MIT 上游唯一硬性要求（保留署名 + 标明来源），也省掉以后被问「这针哪来的」。

---

## 5. 结论

**要加，但加的不是「更多补丁」，而是 3 条新补丁 + 3 处重锚定；上游剩下 2 条（桌面的 header 限制、插话语义反转）本轮不做。**

### 第一批 3 条

| 顺序 | 补丁 | 为什么是它 |
|---|---|---|
| 1 | **AP-03 重锚定 `#32 / #53 / #60`** | 唯一一条「修现有失效」而非「加新东西」。这三条在真机上是 no_needle，等于网页面身份句、run_code 加宽话术的清洗全失效——破甲仓库的核心项空转。锚点已逐包实测命中，改动局限在补丁表的 `file` 字段与针文本，不动引擎逻辑。 |
| 2 | **AP-01 `SANDBOX_POLICY_BRAND_NEUTRAL`** | 收益/风险比最好：三条锚点逐字命中，纯文案、放行语义不动，和 `#61` 不相交，验收只要两条 grep。加完模型每步读到的策略不再自称某产品。 |
| 3 | **AP-02 `ASK_USER_WAIT_CAPPED`** | 唯一一条能消除「真卡住」的：`timeout: -1` 让整轮无限等，手机上没有别的出路。锚点实测命中，改动一行，自带可断言的验收（`-1 → ≤300s`，`30 → 30000`）。 |

第二批（想继续再加）：AP-04 徽章去品牌 → AP-08 里 `#77` 重锚 → AP-11 的 `node --check` 写后复核。
明确不做：AP-07（手机无桌面壳）、AP-09（opt-in 不是补丁）、AP-10（桌面专属）、`#54` 重锚（宿主已自己修好）。

### 最大风险

**不是补丁打坏引擎，是「半打」——多包多针的补丁只命中一部分，落成 `partial` 而没人发现。** 眼下 82 条里已经有 5 条 partial、7 条 no_needle，说明这个风险是现实发生的，不是假设。缓解：新补丁一律带 `multiHit`/`strictFiles` 声明，进 `scripts/patch-regression.mjs` 的 fixture 回归，并把 `--check` 的 partial 计数接到面板上（现在只有 CLI 看得到）。

---

## 附录 A：复现命令

```bash
# 上游三份（只读，落 /tmp，不进仓库）
git clone --depth 1 https://github.com/LanJinGod/dsh-purge.git        /tmp/up-lanjin
git clone --depth 1 https://github.com/kingcharleslzy-ai/dsh-purge.git /tmp/up-lzy
git clone --depth 1 https://github.com/NANA7MI0/dsh-purge-go.git       /tmp/up-nana

# 差集（id 集合）
node --input-type=module -e '
import { ALL_PATCHES as OURS } from "./lib/core.js";
import { ALL_PATCHES as LZY }  from "/tmp/up-lzy/lib/patches/index.mjs";
const o=new Set(OURS.map(p=>p.id)), l=new Set(LZY.map(p=>p.id));
console.log("上游独有:",[...l].filter(i=>!o.has(i)).join(","));
console.log("我方独有:",[...o].filter(i=>!l.has(i)).join(","));'

# 本机真实落地情况（只读）
DSH_BASE=/opt/dsh/node_modules/@deepseek-ai node bin/dsh-purge.js --check

# 候选锚点探测（只读）
grep -c "DSH file sandbox" /opt/dsh/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js
grep -n "validateTimeout(args.timeout" /opt/dsh/node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js
grep -rn "powered by dsh" /opt/dsh/node_modules/@deepseek-ai/dsh-skill-badge/lib/index.js
```

## 附录 B：引用片段与出处

本文件只引用了上游的**标识性短语**（不超过一行），逐条出处：

- `Current DSH file policy: ` / `enforced by the DSH file sandbox` / `The DSH file sandbox does not restrict` —— 目标宿主 `dsh-sandbox-policy/lib/index.js` 现状；上游对应补丁见 [S2 #93](https://github.com/kingcharleslzy-ai/dsh-purge/blob/main/release-notes.md) 条目。
- `powered by dsh` —— 目标宿主 `dsh-skill-badge/lib/index.js`；上游对应 [S2 #94](https://github.com/kingcharleslzy-ai/dsh-purge)。
- `current turn no longer accepts steering` —— 目标宿主 `dsh-api-session-controller/lib/index.js:938`；上游对应 [S2 #90](https://github.com/kingcharleslzy-ai/dsh-purge)。
- 三份来源的合并关系、「87 = 86 + 补入的 #91」的计数说明、整仓 AGPL-3.0 的理由 —— [S3 NOTICE](https://github.com/NANA7MI0/dsh-purge-go/blob/main/NOTICE)（转述，未逐字引用）。

上游源码本身（`pattern` / `replace` 全文）不在本文件中出现，也未复制进仓库。
