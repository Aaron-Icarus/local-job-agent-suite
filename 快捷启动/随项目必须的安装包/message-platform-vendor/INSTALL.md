# message-platform-vendor/ 下载安装说明

本目录用于放消息平台飞书长连接 SDK 的运行依赖，主要是 `@larksuiteoapi/node-sdk`。

它不属于源码，不应提交真实 `node_modules` 到 GitHub。公开仓库只保留本说明；需要真实运行飞书长连接时再安装。

## 推荐自动安装命令

如果本机已有 Node.js 20+ 和 pnpm：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\prepare_runtime.ps1' -UseSystemNode"
```

如果本机没有 Node/pnpm：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\prepare_runtime.ps1'"
```

## 依赖来源

安装源不是随便联网拉一个包，而是读取项目内的锁定文件：

```text
定时执行agent程序/message-platform/vendor/package.json
定时执行agent程序/message-platform/vendor/pnpm-lock.yaml
定时执行agent程序/message-platform/vendor/pnpm-workspace.yaml
```

准备脚本会把这几个文件复制到本目录，再执行 `pnpm install --frozen-lockfile`，确保安装版本与项目锁文件一致。

## 手工安装命令

```powershell
$root = '<分享包实际安装目录>'
$packages = Join-Path $root '快捷启动\随项目必须的安装包'
$source = Join-Path $root '定时执行agent程序\message-platform\vendor'
$target = Join-Path $packages 'message-platform-vendor'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $source 'pnpm-lock.yaml') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $source 'pnpm-workspace.yaml') -Destination $target -Force
$env:PNPM_STORE_DIR = Join-Path $packages 'pnpm-store'
Set-Location -LiteralPath $target
pnpm install --frozen-lockfile
```

## 准备成功后应该有什么

```text
message-platform-vendor/
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  node_modules/
    @larksuiteoapi/node-sdk/
    .pnpm/
  INSTALL.md
```

验证：

```powershell
node -e "require('<分享包实际安装目录>/快捷启动/随项目必须的安装包/message-platform-vendor/node_modules/@larksuiteoapi/node-sdk'); console.log('ok')"
```

如果只跑离线测试或草稿，不启用飞书长连接，可以暂时不安装本目录。
