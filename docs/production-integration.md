# jietu 生产接入步骤

本文档对应“截图主链路只求快和准，上层能力异步接入”的新架构。

## 1. 运行边界

- `npm run capture:hourly`：只截图、保存本地归档、同步 OSS、生成 MD 任务清单；默认保留长截图和轮播/相关截图。
- `npm run scheduler:local`：默认按小时只跑截图，不自动跑视觉比对。
- `npm run compare:worker`：独立视觉比对入口，可接 Applitools 或其它视觉 API。
- `npm run audit:daily`：独立每日巡检入口，用于 SEO、啄木鸟、埋点审计。

如果临时需要兼容旧链路，可以显式开启比对：

```powershell
npm run scheduler:local -- --compare
```

或者设置：

```powershell
[Environment]::SetEnvironmentVariable("PAGE_SHOT_SCHEDULER_COMPARE", "1", "User")
```

## 2. 阿里云 OSS 接入

### 2.1 创建 Bucket

1. 进入阿里云控制台，打开“对象存储 OSS”。
2. 创建 Bucket，例如 `jietu-prod-screenshots`。
3. 选择离运行机器近的 Region，例如广州可用 `oss-cn-guangzhou`。
4. 存储类型先用“标准存储”。
5. 如果外部视觉 API 需要直接打开图片链接，Bucket 或 CDN 域名必须能公开读取这些图片；如果不希望公开读取，就优先使用 Applitools Images SDK 的本地文件上传模式。

### 2.2 创建 RAM AccessKey

不要使用主账号 AccessKey。建议新建 RAM 用户，只给当前 Bucket 的最小权限。

权限策略示例，把 bucket 名和 prefix 改成你的实际值：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject",
        "oss:ListObjects"
      ],
      "Resource": [
        "acs:oss:*:*:jietu-prod-screenshots",
        "acs:oss:*:*:jietu-prod-screenshots/jietu/*"
      ]
    }
  ]
}
```

### 2.3 设置 Windows 用户环境变量

在 PowerShell 中设置，重开终端后生效：

```powershell
[Environment]::SetEnvironmentVariable("PAGE_SHOT_OBJECT_STORAGE", "aliyun", "User")
[Environment]::SetEnvironmentVariable("PAGE_SHOT_OSS_REGION", "oss-cn-guangzhou", "User")
[Environment]::SetEnvironmentVariable("PAGE_SHOT_OSS_BUCKET", "jietu-prod-screenshots", "User")
[Environment]::SetEnvironmentVariable("PAGE_SHOT_OSS_PREFIX", "jietu", "User")
[Environment]::SetEnvironmentVariable("PAGE_SHOT_OSS_ACCESS_KEY_ID", "<your-ram-access-key-id>", "User")
[Environment]::SetEnvironmentVariable("PAGE_SHOT_OSS_ACCESS_KEY_SECRET", "<your-ram-access-key-secret>", "User")
[Environment]::SetEnvironmentVariable("PAGE_SHOT_OBJECT_STORAGE_PUBLIC_BASE_URL", "https://jietu-prod-screenshots.oss-cn-guangzhou.aliyuncs.com/", "User")
```

注意：`PAGE_SHOT_OBJECT_STORAGE_PUBLIC_BASE_URL` 填 Bucket 根域名或 CDN 根域名即可，不要重复带上 `jietu` prefix。代码会自动拼出 `jietu/...png`。

### 2.4 验证 OSS 上传

重开终端后执行一次截图：

```powershell
npm run capture:hourly -- --platform pc
```

然后检查最新 `data/snapshots.json` 记录，应看到：

```json
{
  "syncStatus": "synced",
  "ossKey": "jietu/2026-06-24/shokz-com/...",
  "objectImageUrl": "https://jietu-prod-screenshots.oss-cn-guangzhou.aliyuncs.com/jietu/..."
}
```

如果 OSS 上传失败，截图仍会成功保存到本地，snapshot 会写：

```json
{
  "syncStatus": "failed",
  "syncError": "..."
}
```

这种失败后续补传即可，不需要重跑整轮截图。

## 3. 接入视觉比对工具

### 方案 A：Applitools Eyes

适合直接采用成熟视觉 AI 和 Dashboard 审核。它不要求图片链接公网可访问，因为 SDK 可以从本地归档上传图片。

```powershell
[Environment]::SetEnvironmentVariable("APPLITOOLS_API_KEY", "<your-applitools-key>", "User")
[Environment]::SetEnvironmentVariable("APPLITOOLS_APP_NAME", "jietu", "User")
[Environment]::SetEnvironmentVariable("APPLITOOLS_BATCH_NAME", "jietu-hourly", "User")
[Environment]::SetEnvironmentVariable("APPLITOOLS_BRANCH_NAME", "main", "User")
[Environment]::SetEnvironmentVariable("APPLITOOLS_MATCH_LEVEL", "Strict", "User")
[Environment]::SetEnvironmentVariable("PAGE_SHOT_COMPARE_PROVIDER", "applitools", "User")
```

首次验证：

```powershell
npm run applitools:smoke
```

正式比对：

```powershell
npm run compare:worker
```

首次运行会创建 baseline。需要到 Applitools Dashboard 里人工 Accept，之后才会稳定判断变化。

### 方案 B：其它视觉 API

适合你后续接一个“只接收两张图片链接并返回是否变化”的成熟 API 服务。

设置环境变量：

```powershell
[Environment]::SetEnvironmentVariable("VISION_COMPARE_ENDPOINT", "https://vision.example.com/compare", "User")
[Environment]::SetEnvironmentVariable("VISION_COMPARE_API_KEY", "<your-api-key>", "User")
[Environment]::SetEnvironmentVariable("VISION_COMPARE_TIMEOUT_MS", "30000", "User")
```

jietu 会发送：

```json
{
  "oldImageUrl": "https://.../old.png",
  "newImageUrl": "https://.../new.png",
  "targetId": "...",
  "deviceProfileId": "...",
  "capturePlanId": "...",
  "platform": "pc",
  "comparisonKey": "..."
}
```

视觉 API 建议返回：

```json
{
  "provider": "your-provider",
  "changed": true,
  "confidence": 0.97,
  "summary": "Hero banner changed",
  "dashboardUrl": "https://...",
  "regions": [],
  "ratio": 0.12
}
```

运行：

```powershell
npm run compare:worker
```

如果要指定某一次截图结果：

```powershell
npm run compare:worker -- --run-id <captureRunId>
```

## 4. 推荐生产启动顺序

1. 先只开截图：`npm run scheduler:local`。
2. 确认每小时截图成功，MD checklist 都是完成状态。
3. 打开 OSS，确认主图和轮播图都有 `synced` 和 `objectImageUrl`。
4. 再接 Applitools 或通用视觉 API，单独跑 `npm run compare:worker`。
5. 最后再接 `npm run audit:daily` 做每日 SEO、啄木鸟、埋点审计。

初期不需要拆成多个仓库；先用多个独立命令/进程拆模块。等截图、比对、每日巡检都稳定后，再考虑把视觉比对服务单独部署。

如果临时只想跑极简主图以压测速度，可以在当前 PowerShell 会话里显式开启：

```powershell
$env:PAGE_SHOT_FAST_MAIN_CAPTURE = "1"
$env:PAGE_SHOT_FAST_RELATED = "1"
```

正式生产巡检不建议长期打开这两个开关，因为它们会减少长截图或轮播/相关截图覆盖。
