# Page Shot Archive

一个本地网页截图归档工具。默认监控 `https://shokz.com`，可以手动截图，也可以在工具运行期间按固定间隔自动截图。所有截图都会保存在 `archive/` 目录，并在网页界面里按时间查看。

## 启动

```powershell
npm start
```

打开终端里显示的本地地址，通常是：

```text
http://127.0.0.1:4173
```

## 立即截一次图

网页里点“立即截图”，或在命令行运行：

```powershell
npm run capture
```

也可以临时指定一个 URL：

```powershell
npm run capture -- https://shokz.com
```

## 数据位置

- 截图文件：`archive/YYYY-MM-DD/<site>/...png`
- 截图索引：`data/snapshots.json`
- 工具配置：`data/config.json`

## 浏览器

工具会优先使用环境变量 `BROWSER_PATH`，否则自动寻找本机 Edge 或 Chrome。它通过浏览器的 headless 模式截取全页面截图，不需要安装额外 npm 包。
