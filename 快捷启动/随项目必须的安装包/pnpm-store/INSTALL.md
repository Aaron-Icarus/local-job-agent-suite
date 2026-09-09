# pnpm-store/ 下载安装说明

本目录用于放 pnpm 依赖缓存。它不是手动下载的安装包，而是运行 `pnpm install` 时自动生成的缓存目录。

本项目目前只有消息平台的飞书长连接 SDK 需要 pnpm 安装依赖。只做草稿、本地测试、不启用飞书长连接时，可以没有本目录。

## 推荐自动生成命令

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\prepare_runtime.ps1' -UseSystemNode"
```

如果本机没有 Node/pnpm，则改用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\prepare_runtime.ps1'"
```

## 手工生成命令

```powershell
$root = '<分享包实际安装目录>'
$packages = Join-Path $root '快捷启动\随项目必须的安装包'
$env:PNPM_STORE_DIR = Join-Path $packages 'pnpm-store'
Set-Location -LiteralPath (Join-Path $packages 'message-platform-vendor')
pnpm install --frozen-lockfile
```

## 准备成功后应该有什么

本目录内容由 pnpm 决定，可能是空目录，也可能包含 `v3/files/...` 等缓存结构。只要 `message-platform-vendor/node_modules/` 已安装成功，pnpm-store 是否为空都不影响直接运行。

```text
pnpm-store/
  INSTALL.md
  v3/              可能存在，由 pnpm 自动生成
```

清理原则：可以随时删除；下次 `pnpm install` 会重新生成。
