# corepack/ 下载安装说明

本目录用于放 Corepack 的本地缓存。Corepack 随 Node.js 官方发行版自带，用来准备固定版本的 pnpm。

它不是必须长期保留的源码内容；如果本机已经有可用 pnpm，或不需要离线交付，可以删除本目录。需要时重新运行准备脚本即可生成。

## 推荐自动安装命令

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\prepare_runtime.ps1' -SkipVendorInstall"
```

这条命令会：

1. 找到可用 Node.js。
2. 设置 `COREPACK_HOME=快捷启动\随项目必须的安装包\corepack`。
3. 执行 `corepack prepare pnpm@9.15.9 --activate`。

## 手工生成命令

如果已经有 Node.js 22.4.0+：

```powershell
$root = '<分享包实际安装目录>'
$packages = Join-Path $root '快捷启动\随项目必须的安装包'
$env:COREPACK_HOME = Join-Path $packages 'corepack'
$env:PNPM_HOME = Join-Path $packages 'node'
$env:PNPM_STORE_DIR = Join-Path $packages 'pnpm-store'
corepack enable
corepack prepare pnpm@9.15.9 --activate
```

如果使用随包 Node，请把 `corepack` 换成：

```powershell
& "$packages\node\corepack.cmd" enable --install-directory "$packages\node"
& "$packages\node\corepack.cmd" prepare pnpm@9.15.9 --activate
```

## 准备成功后应该有什么

```text
corepack/
  lastKnownGood.json
  v1/
    pnpm/
      9.15.9/
  INSTALL.md
```

验证：

```powershell
pnpm --version
```

或使用随包 pnpm：

```powershell
.\快捷启动\随项目必须的安装包\node\pnpm.cmd --version
```
