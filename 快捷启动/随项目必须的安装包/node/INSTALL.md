# node/ 下载安装说明

本目录用于放“便携版 Node.js”。它不是 GitHub 源码仓库必须包含的二进制；只有当使用者电脑没有 Node.js 20+，或要做离线小白交付包时，才需要生成/保留。

## 推荐自动安装命令

在任意 CMD 或 PowerShell 中执行，把 `<分享包实际安装目录>` 换成项目根目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\prepare_runtime.ps1' -ForceNode -SkipVendorInstall"
```

这条命令会调用项目内置脚本，从 Node.js 官方源下载当前 `latest-v22.x` 的 Windows 便携 zip，校验 SHA256 后解压到本目录。

## 下载来源

- 官方目录：`https://nodejs.org/dist/latest-v22.x/`
- 校验清单：`https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt`
- Windows x64 文件名形态：`node-v*-win-x64.zip`
- Windows arm64 文件名形态：`node-v*-win-arm64.zip`

## 手工下载/解压逻辑

如果不用项目脚本，AI 或维护者可以按下面逻辑重建：

```powershell
$root = '<分享包实际安装目录>'
$packages = Join-Path $root '快捷启动\随项目必须的安装包'
$platform = 'win-x64'
$baseUrl = 'https://nodejs.org/dist/latest-v22.x'
$shaText = (Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -UseBasicParsing).Content
$zipName = (($shaText -split "`n") | Where-Object { $_ -match "node-v.*-$platform\.zip" } | Select-Object -First 1).Trim().Split()[1]
$zipPath = Join-Path $packages "_downloads\$zipName"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $zipPath) | Out-Null
Invoke-WebRequest -Uri "$baseUrl/$zipName" -OutFile $zipPath -UseBasicParsing
Expand-Archive -LiteralPath $zipPath -DestinationPath (Join-Path $packages '_node_extract_tmp') -Force
```

解压后，把 `node-v*-win-x64` 或 `node-v*-win-arm64` 目录整体移动/重命名为本目录 `node/`。

## 准备成功后应该有什么

```text
node/
  node.exe
  npm.cmd
  npx.cmd
  corepack.cmd
  pnpm.cmd        运行 corepack enable/prepare 后生成
  INSTALL.md      本说明
```

验证：

```powershell
.\快捷启动\随项目必须的安装包\node\node.exe -p "process.versions.node"
```

版本主号应为 20 或以上。
