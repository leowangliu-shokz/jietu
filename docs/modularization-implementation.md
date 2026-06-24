# jietu 模块化实施说明

## 已拆出的运行入口

- `npm run capture:hourly`
  - 每小时截图主链路。
  - 只负责截图、保存归档、记录截图 run 和生成本轮截图任务清单。
  - 默认保留长截图和轮播/相关截图，但不在小时级截图尾部同步执行重分析。

- `npm run compare:worker`
  - 单独执行截图变化比对。
  - 默认读取最新 capture run 里的 `snapshotIds` 做增量比对，不再全量扫描全部历史截图。
  - 如需全量重建，显式执行 `npm run compare:worker -- --all`。
  - 如需指定某次截图批次，执行 `npm run compare:worker -- --run-id <captureRunId>`。
  - 旧的 `npm run compare` 继续保留全量重建语义，并复用同一个 worker。

- `npm run audit:daily`
  - 每日巡检入口。
  - 面向 SEO、啄木鸟文本检查、埋点审计这类低频任务。
  - 输出结构化任务状态和 Markdown 勾选清单。

- `npm run scheduler:local`
  - 本地调度入口。
  - 默认常驻运行，按小时只执行 `capture:hourly`，不把视觉比对串进截图主链路。
  - `--once` 可以执行一次小时链路。
  - `--compare` 可以显式附带执行一次异步比对；也可以设置 `PAGE_SHOT_SCHEDULER_COMPARE=1` 恢复旧式串联。
  - `--daily` 可以在 one-shot 模式里附带执行每日巡检。

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

JSON 是机器恢复和避免重复执行的状态源；Markdown 是给人看的进度表。

## 小时截图和比对清单

小时截图和异步比对也会输出任务清单：

```text
logs/workflow-runs/<runId>.json
logs/workflow-checklists/<runId>.md
```

截图清单会对每个截图任务做轻量自检：

- 是否生成 snapshot
- 是否有图片链接
- 图片尺寸是否正常
- 是否被标记为截断或低置信

比对清单会区分三种状态：

- 本轮有截图并已完成比对
- 本轮完成比对但没有发现可记录变化
- 没有可比对的截图 run 或 snapshot 记录缺失

## 任务状态 API

后端提供轻量任务状态接口：

```text
GET /api/tasks?type=audit&date=YYYY-MM-DD
GET /api/tasks?type=workflow&runId=<runId>
```

前端后续可以基于这个接口展示完成率、失败项和需要补跑的任务。

## OSS 接入边界

当前已有对象存储适配层：

```text
src/storage/object-storage.js
```

默认不上载远端，snapshot 会写入：

```text
localPath
ossKey
syncStatus
sha256
```

如果需要本地模拟 OSS：

```powershell
$env:PAGE_SHOT_OBJECT_STORAGE = "local"
$env:PAGE_SHOT_OBJECT_STORAGE_DIR = "D:\jietu-object-storage"
$env:PAGE_SHOT_OBJECT_STORAGE_PUBLIC_BASE_URL = "https://example-cdn.test/"
```

迁移期仍应保留本地 `archive/` 和 `data/snapshots.json`，不要让 OSS 替代归档事实源。

如果需要接入阿里云 OSS：

```powershell
$env:PAGE_SHOT_OBJECT_STORAGE = "aliyun"
$env:PAGE_SHOT_OSS_REGION = "oss-cn-guangzhou"
$env:PAGE_SHOT_OSS_BUCKET = "<bucket>"
$env:PAGE_SHOT_OSS_PREFIX = "jietu"
$env:PAGE_SHOT_OSS_ACCESS_KEY_ID = "<ram-access-key-id>"
$env:PAGE_SHOT_OSS_ACCESS_KEY_SECRET = "<ram-access-key-secret>"
$env:PAGE_SHOT_OBJECT_STORAGE_PUBLIC_BASE_URL = "https://<bucket>.oss-cn-guangzhou.aliyuncs.com/"
```

OSS 上传失败不会让截图任务失败；snapshot 会保留本地链接，并记录 `syncStatus=failed` 和 `syncError`，后续可补传。

## 外部视觉 API

默认仍使用本地比对。配置以下环境变量后，比对模块会在预筛后调用外部视觉 API：

```powershell
$env:VISION_COMPARE_ENDPOINT = "https://vision.example.test/compare"
$env:VISION_COMPARE_API_KEY = "<secret>"
$env:VISION_COMPARE_BASE_URL = "https://your-jietu-image-host.test/"
$env:VISION_COMPARE_TIMEOUT_MS = "30000"
```

请求体包含：

```json
{
  "oldImageUrl": "...",
  "newImageUrl": "...",
  "targetId": "...",
  "deviceProfileId": "...",
  "capturePlanId": "...",
  "platform": "pc"
}
```
