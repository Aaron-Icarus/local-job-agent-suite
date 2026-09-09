# _downloads/ 下载缓存说明

本目录只用于临时缓存下载文件，例如 Node.js 官方 zip。它不参与项目运行。

如果 `node/` 已经解压好了，或者使用本机 Node.js/pnpm，本目录可以删除。删除后不影响启动控制台、草稿测试或正式流程；未来需要重新准备随包 Node 时，脚本会再次下载。

## 推荐生成方式

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\prepare_runtime.ps1' -ForceNode -SkipVendorInstall"
```

## 下载来源

- 官方目录：`https://nodejs.org/dist/latest-v22.x/`
- 校验清单：`https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt`
- 缓存文件形态：`node-v*-win-x64.zip` 或 `node-v*-win-arm64.zip`

## 准备成功后可能有什么

```text
_downloads/
  node-v22.x.x-win-x64.zip
  INSTALL.md
```

清理原则：可以随时删除。公开 GitHub 仓库不应提交 zip、exe、msi 等二进制安装包。
