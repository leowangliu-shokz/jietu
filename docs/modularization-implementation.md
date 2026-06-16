# jietu 模块化实施说明

## 已拆出的运行入口

- `npm run capture:hourly`
  - 每小时截图主链路。
  - 只负责截图、保存归档和记录 run。
  - 分析刷新后置，不在小时级截图尾部同步执行。
- `npm run compare:worker`
  - 单独执行截图变化比对。
  - 旧的 `npm run compare` 继续可用，并复用同一模块。
- `npm run audit:daily`
  - 每日巡检入口。
  - 生成结构化任务状态和 Markdown 勾选清单。

## 每日巡检清单

每日巡检会从当前 v2 配置矩阵展开任务：

- 页面目标：`targets[]`
- 设备：`deviceProfiles[]`
- 执行矩阵：`capturePlans[]`
- 巡检模块：SEO、啄木鸟、埋点审计

输出位置：

```text
logs/audit-runs/YYYY-MM-DD.json
logs/audit-checklists/YYYY-MM-DD.md
```

JSON 是机器恢复和跳过重复任务的状态源；Markdown 是给人看的进度表。

## OSS 接入边界

当前提交没有接入真实 OSS 账号。后续接入时建议新增：

```text
src/storage/local-cache.js
src/storage/oss-storage.js
```

并在 snapshot 记录中增加：

```text
localPath
imageUrl
ossKey
syncStatus
sha256
```

迁移期仍应保留本地 `archive/` 和 `data/snapshots.json`，不要让 OSS 替代归档事实来源。
