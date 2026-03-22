# OpenClaw Windows 安装器

## 本地打包步骤

### 1. 把项目拉到本地

把 `/root/openclaw-installer-win/` 这个目录下载到你的 Windows 电脑。

### 2. 下载 Node.js 便携版（内嵌用）

访问 https://nodejs.org/dist/v20.11.0/node-v20.11.0-win-x64.zip
下载后解压，把文件夹改名为 `node-win`，放到项目根目录：

```
openclaw-installer-win/
  ├── node-win/          ← Node.js 便携版放这里
  │   ├── node.exe
  │   ├── npm.cmd
  │   └── ...
  ├── src/
  ├── assets/
  └── package.json
```

### 3. 准备图标

在 `assets/` 目录放一个 `icon.ico` 文件（256x256，可以用在线工具转换）。
没有图标也可以先跳过，打包时会用默认图标。

### 4. 安装依赖并打包

在项目目录打开终端，运行：

```bash
npm install
npm run pack
```

打包完成后，`dist/` 目录里会有：
- `OpenClaw 安装器 Setup 1.0.0.exe` — 安装包，发给用户

### 5. 用户使用流程

1. 下载 `OpenClaw 安装器 Setup 1.0.0.exe`
2. 双击安装
3. 填写 API Base URL 和 API Key
4. 点"开始安装"
5. 等待完成，自动打开 OpenClaw

## 注意事项

- 打包后的 exe 约 150-200MB（含 Electron + Node.js）
- 首次安装需要联网下载 openclaw npm 包（约 50MB）
- 用户数据存在 `C:\Users\用户名\.openclaw\` 目录
- Gateway 默认跑在 `http://127.0.0.1:18789`
