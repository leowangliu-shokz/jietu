# Page Shot Archive

一个本地网页截图归档查看工具。默认监控 `https://shokz.com`，服务运行期间会在每个整点自动截图所有设备预设。所有截图都会保存在 `archive/` 目录，并在网页界面里按时间、URL 和设备查看。

## 启动

```powershell
npm start
```

打开终端里显示的本地地址，通常是：

```text
http://127.0.0.1:4173
```

## 开发者手动截图

普通网页界面是只读查看模式，不提供手动截图或配置修改入口。开发者可以在命令行运行：

```powershell
npm run capture
```

也可以临时指定一个 URL：

```powershell
npm run capture -- https://shokz.com
```

如果确实需要临时打开 HTTP 管理接口，可以用 `PAGE_SHOT_ADMIN=1` 启动服务；默认情况下 `/api/capture` 和 `/api/config` 会拒绝写操作。

## 数据位置

- 截图文件：`archive/YYYY-MM-DD/<site>/...png`
- 截图索引：`data/snapshots.json`
- 工具配置：`data/config.json`

## 浏览器

工具会优先使用环境变量 `BROWSER_PATH`，否则自动寻找本机 Edge 或 Chrome。它通过浏览器的 headless 模式截取全页面截图，不需要安装额外 npm 包。
