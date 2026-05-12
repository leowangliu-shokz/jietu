# Page Shot Archive

一个本地网页截图时间档案工具。默认监控 `https://shokz.com`，截图会保存在 `archive/`，索引和变更汇总会写入 `data/`，页面可按时间、URL、设备查看历史截图和变更。

## 启动

```powershell
npm start
```

默认地址通常是：

```text
http://127.0.0.1:4173
```

## 默认可用能力

- 查看截图档案
- 预览大图和更多截图
- 手动删除单次截图卡，并自动重算变更汇总

## 管理员模式能力

手动截图和配置修改仍然需要管理员模式。默认情况下：

- `POST /api/capture` 会返回 `403`
- `POST /api/config` 会返回 `403`

如果确实需要临时打开这些写接口，可以这样启动服务：

```powershell
$env:PAGE_SHOT_ADMIN = "1"
npm start
```

也可以直接从命令行做一次手动截图：

```powershell
npm run capture
```

指定 URL：

```powershell
npm run capture -- https://shokz.com
```

## 修复运行时中文 `???`

如果 `data/snapshots.json` 或 `data/changes.json` 里的派生展示字段被写成了 `???`，可以运行一次修复脚本：

```powershell
npm run repair:data
```

这个脚本会：

- 按当前配置修复 `targetLabel` / `displayUrl`
- 按设备预设修复 `deviceLabel`
- 按分区元数据修复 `sectionLabel` / `sectionTitle`
- 立即重建 `data/changes.json`

它不会改动 `archive/` 里的原图文件，也不会重写 `logs/` 历史日志。

## 数据位置

- 截图文件：`archive/YYYY-MM-DD/<site>/...png`
- 截图索引：`data/snapshots.json`
- 变更汇总：`data/changes.json`
- 工具配置：`data/config.json`

## 浏览器

工具会优先使用环境变量 `BROWSER_PATH`；否则自动寻找本机 Edge 或 Chrome。截图通过浏览器 headless 模式完成，不需要额外安装 npm 包。
