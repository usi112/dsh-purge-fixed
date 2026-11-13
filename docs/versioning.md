# 版本号规则（本分支）

本仓库是 [`dsh-purge`](https://deepseek.stream/plugins/dsh-purge) **1.1.71**（作者 小杨，MIT）的修复分支。
上游会继续发自己的版本，本分支也会发自己的版本，**两者不能长得一样**，否则「1.1.73」到底是上游的还是我们的，没人说得清。

## 1. 现行写法

```
<分支发布序号>+upstream.<所基于的上游版本>
        ↑                        ↑
     逐次 +1              只有换基线时才改
```

当前：**`1.1.74+upstream.1.1.71`**

- `+upstream.1.1.71` 用 semver 的 **build metadata**（`+` 后面那一段）记基线，任何工具都不会把它当版本序的一部分；
- 数字段 `1.1.74` 是本分支自己的发布序号（历史 `1.1.72` → `1.1.73` → `1.1.74` 就按这个序列），**不代表上游发过这个号**；
- 换基线（例如上游出了 1.1.80、我们 rebase 过去）时，才把基线改成 `+upstream.1.1.80`，数字段继续往上走，不回退。

## 2. 为什么不用别的写法

| 候选写法 | 问题 |
|---|---|
| `1.1.71-fork.3`（预发布） | semver 里预发布**低于**正式版：插件管理器会认为它比上游 `1.1.71` 还旧，可能提示「降级回上游」 |
| `1.1.71+fixed.3` | `+` 后面的内容不参与比较，它和 `1.1.71` **同序**，会被判定「已是最新」，以后上游发版也看不出差异 |
| `1.1.71.3`（四段） | 不是合法 semver，npm / 插件安装会直接报错 |
| 只写 `1.1.74`、在 README 里提一句基线 | 版本号本身看不出基线——这正是这次要改掉的毛病 |

## 3. 新旧对照

| 场景 | 旧标注 | 新标注 |
|---|---|---|
| 上游原版 | `1.1.71` | `1.1.71`（不动，也不是本仓库） |
| 本分支首个修复版 | `1.1.72` | `1.1.72+upstream.1.1.71` |
| 补丁层 7 分类那一版 | `1.1.73` | `1.1.73+upstream.1.1.71` |
| 每条补丁写明原因 / 应用回执（当时版本） | `1.1.74` | **`1.1.74+upstream.1.1.71`** |
| git 标签 | `v1.1.74` | `v1.1.74+upstream.1.1.71`（旧标签保留，不改历史） |
| 命令输出 | `dsh-purge 状态 / Status` | `dsh-purge 1.1.74+upstream.1.1.71（上游基线 1.1.71）` |

## 4. 版本号写在哪些地方

| 位置 | 字段 / 行 | 说明 |
|---|---|---|
| `package.json` | `version` | 唯一权威值，形如 `1.1.74+upstream.1.1.71` |
| `package.json` | `dshPurge.upstream` | 机器可读的基线：`{ name, version, author, license }` |
| `package.json` | `dshPurge.fork` | 分支自己的序号与标签（`1.1.74` / `fixed`） |
| `README.md` / `README.en.md` | 第一行标题 | 标题里直接写基线，读者不翻文件也知道 |
| `release-notes.md` | 每节标题 | 标题即版本号，第一行注明基线规则 |
| `CHANGELOG-fixes.md` | 顶部声明 | 一句「本分支基线：1.1.71」 |
| `bin/dsh-purge.js` | `--version`、`--status` / `--check` 首行 | 命令行直接看到 `+upstream.1.1.71` |
| git tag | `v1.1.74+upstream.1.1.71` | 发版时打；历史标签 `v1.1.73`、`v1.1.74` 保留 |

`native-ui/` 下两个私有插件（`local-purge-ui` / `local-purge-more`）**不适用**本规则：它们是本地界面包，
没有对应的上游，按普通 `0.x` 递增即可。

## 5. 发版检查清单

```sh
node bin/dsh-purge.js --version        # 应输出 1.1.xx+upstream.1.1.71
node -e "const p=require('./package.json');console.log(p.version, p.dshPurge.upstream.version)"
head -1 README.md README.en.md         # 标题里带 +upstream.1.1.71
grep -n "^# 1\.1\." release-notes.md | head -3
git tag -l 'v1.1.*'
```

任何一处对不上，就别打标签。
