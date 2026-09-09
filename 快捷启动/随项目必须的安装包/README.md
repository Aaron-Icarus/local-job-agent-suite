# 随项目必须的安装包

这个目录用于放“随项目走”的本地运行时依赖，目标是让项目换到一台新 Windows 电脑后，不强依赖系统 PATH 里已经装好了 Node.js。

## 推荐方式

在分享包根目录双击：

```text
快捷启动\快捷启动脚本\准备运行环境.cmd
```

它会显示菜单，让使用者自己选择：

- 准备随包 Node.js + pnpm + 飞书 SDK 依赖，不修改 PATH。
- 使用本机已有 Node.js/pnpm，只安装飞书 SDK 运行依赖。
- 准备随包依赖，并把随包 Node 注册到当前 Windows 用户 PATH。
- 只查看状态，不安装。

推荐默认选第 1 项。常用快捷脚本会临时使用随包 Node，不要求注册 PATH；只有你想在任意终端直接运行 `node` / `pnpm`，才需要选择 PATH 注册。

随包模式会做三件事：

1. 如果本目录还没有便携版 Node.js，会从 Node.js 官方下载 Windows x64 便携 zip，并解压到 `node\`。
2. 使用 Node 自带的 `corepack` 准备 pnpm；项目固定使用 `pnpm@9.15.9`。
3. 把消息平台飞书 SDK 依赖安装到 `message-platform-vendor\`，不写入具体项目目录。

准备完成后，常用快捷脚本会优先使用：

如果这里存在便携版 Node.js，快捷启动脚本会优先使用它；否则使用系统 PATH 中的 `node`。

## 准备完成后的目录形态

```text
随项目必须的安装包/
  README.md
  node/                 便携版 Node.js，准备脚本下载生成；node.exe 应直接在这一层
  corepack/             corepack/pnpm 缓存
  pnpm-store/           pnpm 依赖缓存
  message-platform-vendor/
                        消息平台飞书 SDK 运行依赖
  _downloads/           Node.js zip 下载缓存
```

## 为什么 GitHub 里默认不直接放 node.exe

Node.js 运行时和安装包体积较大，放进公开仓库会明显增加仓库体积，也不利于后续更新和安全核验。所以 GitHub/source 版本默认放“准备脚本 + 说明”；如果你要做给电脑小白的离线压缩包，可以先在本机运行一次 `准备运行环境.cmd`，再把生成出来的 `node/`、`corepack/`、`message-platform-vendor/`、`pnpm-store/` 一起打包。

Chrome 建议由使用者自行安装，或在招聘 Agent 的 `.env` 中配置 `CHROME_PATH`。
