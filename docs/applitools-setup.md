# Applitools Eyes 接入说明

## 作用边界

Applitools 只接管视觉比对判断，不替代 jietu 的截图、调度、OSS、SEO、啄木鸟、埋点审计和任务清单。

当前接入方式：

```text
jietu capture:hourly -> 本地/OSS 保存截图 -> compare:worker -> Applitools Images SDK -> data/changes.json + MD 清单
```

## 本机环境变量

不要把 API Key 写入代码或提交到 git。建议在 PowerShell 当前会话里设置：

```powershell
$env:APPLITOOLS_API_KEY="<your-api-key>"
$env:APPLITOOLS_APP_NAME="jietu"
$env:APPLITOOLS_BATCH_NAME="jietu-hourly"
$env:APPLITOOLS_BRANCH_NAME="main"
$env:APPLITOOLS_MATCH_LEVEL="Strict"
```

如果要长期生效，可以设置为 Windows 用户环境变量，或放入本机忽略的 `.env` 文件。`.env` 已在 `.gitignore` 中忽略。

## 首次连通验证

先确保本地已经有至少一张截图记录，然后执行：

```powershell
npm run applitools:smoke
```

这个命令只上传一张已有截图到 Applitools，不修改 `data/changes.json`。

成功后终端会打印：

```text
Applitools smoke uploaded snapshot ...
Status: ...
Dashboard: ...
```

打开 Dashboard 链接，在 Applitools 里确认能看到 `jietu` batch。

## 正式比对

设置 `APPLITOOLS_API_KEY` 后，正常执行：

```powershell
npm run compare:worker
```

`compare:worker` 会默认读取最新 capture run 的 `snapshotIds` 做增量比对。Applitools 的结果会写入变化记录里的：

```text
visualChange.externalVision.provider
visualChange.externalVision.status
visualChange.externalVision.dashboardUrl
visualChange.externalVision.isNew
visualChange.externalVision.isDifferent
```

## 第一次运行的 baseline

Applitools 第一次看到某个页面/设备/区域组合时，会创建新的 baseline。默认情况下，jietu 不把“新 baseline”当成页面变化，以免第一次接入时产生大量误报。

第一次跑完后，需要在 Applitools Dashboard 里人工确认并 Accept baseline。之后同一页面位置再次运行，Applitools 才会稳定判断是否有视觉差异。

如果你希望新 baseline 也写成 jietu 变化记录，可以设置：

```powershell
$env:APPLITOOLS_RECORD_NEW_BASELINES_AS_CHANGES="1"
```

## API Key 安全

如果 API Key 已经出现在聊天、截图或其它可见位置，建议在接入完成后到 Applitools 里重新生成一个 Key，并废弃旧 Key。
