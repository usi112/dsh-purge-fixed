# 重锚覆盖（`$DSH_HOME/purge-reanchor.json`）

引擎换版后，补丁表里的 needle 会漂移。为了不改这份生成的 `lib/core.js`，本模块在加载时读
`$DSH_HOME/purge-reanchor.json`，按四个字段覆盖内存里的 `ALL_PATCHES`（只读生效，不写回）：

```json
{
  "patterns":         { "36": { "2": "新的 needle 原文" } },
  "drop":             { "36": [0, 1] },
  "patchReplacements":{ "9":  [ { "pattern": "...", "replace": "..." } ] },
  "obsolete":         [4, 71]
}
```

| 字段 | 语义 |
|---|---|
| `patterns` | 按「补丁 id → 替换序号 → 新 needle」替换单条 pattern（needle 必须 ≥ 24 字符且含非标识符字符，见下「needle 的硬要求」） |
| `drop` | 按「补丁 id → 序号数组」删除条目；`replacements` 与 `patterns` 两种形态都支持，字符串下标会被 `Number()` 归一 |
| `patchReplacements` | 整组替换一条补丁的替换表，用于「同一补丁要对不同文件用不同新文案」 |
| `obsolete` | 该补丁本轮不再适用，实现为 `surfaces = ["__none__"]`，状态显示 `na` |

## needle 的硬要求（1.1.77 起）

apply 对字符串 pattern 是「替换**所有**出现」，所以一条太泛的 needle 会把整份宿主文件改烂：

- **长度 ≥ 24 字符**，且**必须含非标识符字符**（换行、`;`、`{`、`}`、`(`、`)`、`=`、`<`、`>`、`[`、`]` 之一）。
  `"function"`、`"return "`、`"configure"` 这类不再接受，会被直接忽略（保持原表 needle）。
- **命中次数必须唯一**：apply 时若这段 needle 在目标文件里出现多次，这条覆盖会被跳过并打印
  `reanchor needle 命中 N 次，已跳过`，而不是替换全部。
- 这两条只约束**外部覆盖注入的 needle**；`lib/core.js` 里内置补丁的替换语义没有改动。

## 安全约定

- 覆盖文件是外部输入：整段 `try` 包裹，`null`/数组/字段类型错误时整份忽略，绝不让它把模块加载搞挂。
- 失败一律静默回退到原表；需要排查时用 `patchStatus()` 对比 `ALL_PATCHES` 的差异。
- 覆盖只在**读取期**生效：`applyPatches()` 拿到的是已覆盖的表，`restore` 不受影响。

## 与生成流程的关系

`lib/core.js` 里的表由上游 `dsh-purge` 导出的 `patches/patches.json` 生成。覆盖文件是**兼容层**：
上游表更新后可以整份替换，覆盖里只保留仍然成立的差异；差异清空后可直接删除该文件。
