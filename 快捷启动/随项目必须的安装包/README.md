# 随项目必须的安装包

这个目录名按交付结构保留，但实际含义更准确地说是“可选便携运行环境”。

项目运行需要 Node.js 22.4.0+，消息平台飞书长连接需要 `@larksuiteoapi/node-sdk`；但这些依赖不一定要放在这个目录里。如果电脑本机已经安装了合格的 Node.js/pnpm，可以优先使用本机环境，只把飞书 SDK 依赖安装/修复到快捷启动依赖区即可。

这个目录真正适合两种场景：

1. 使用者是电脑小白，不想单独安装/配置 Node.js。
2. 需要把项目拷贝到另一台电脑，尽量减少对系统 PATH 的依赖。

## 推荐方式

在分享包根目录双击：

```text
快捷启动\快捷启动脚本\准备运行环境.cmd
```

它会先检查本机 Node.js/pnpm，再显示菜单，让使用者自己选择：

- 如果本机已有 Node.js 22.4.0+ 和 pnpm：推荐使用本机环境，只安装/修复飞书 SDK 运行依赖。
- 如果本机没有合格 Node/pnpm：推荐准备随包 Node.js + pnpm + 飞书 SDK 依赖，不修改 PATH。
- 准备随包依赖，并把随包 Node 注册到当前 Windows 用户 PATH。
- 只查看状态，不安装。

菜单会根据当前电脑状态动态推荐。默认不修改 PATH；只有你想在任意终端直接运行随包 `node` / `pnpm`，才需要选择 PATH 注册。

随包模式会做三件事：

1. 如果本目录还没有便携版 Node.js，会从 Node.js 官方下载 Windows x64 便携 zip，并解压到 `node\`。
2. 使用 Node 自带的 `corepack` 准备 pnpm；项目固定使用 `pnpm@9.15.9`。
3. 把消息平台飞书 SDK 依赖安装到 `message-platform-vendor\`，不写入具体项目目录。

准备完成后，常用快捷脚本的 Node 选择顺序是：

1. 优先使用系统 PATH 中合格的 Node.js 22.4.0+。
2. 如果本机没有或版本过低，再使用这里的便携版 Node.js。
3. 两者都没有时，提示运行环境准备菜单。

## 准备完成后的目录形态

```text
随项目必须的安装包/
  README.md
  node/                 便携版 Node.js，准备脚本下载生成；node.exe 应直接在这一层
    INSTALL.md          下载来源、命令、校验和目录要求
  corepack/             corepack/pnpm 缓存
    INSTALL.md          corepack/pnpm 准备命令
  pnpm-store/           pnpm 依赖缓存
    INSTALL.md          pnpm store 生成和清理说明
  message-platform-vendor/
                        消息平台飞书 SDK 运行依赖
    INSTALL.md          飞书 SDK vendor 安装命令
  _downloads/           Node.js zip 下载缓存
    INSTALL.md          下载缓存用途和可删除说明
```

## 为什么 GitHub 里默认不直接放 node.exe

Node.js 运行时和安装包体积较大，放进公开仓库会明显增加仓库体积，也不利于后续更新和安全核验。所以 GitHub/source 版本默认放“准备脚本 + 说明”；如果你要做给电脑小白的离线压缩包，可以先在本机运行一次 `准备运行环境.cmd`，再把生成出来的 `node/`、`corepack/`、`message-platform-vendor/`、`pnpm-store/` 一起打包。

Chrome 建议由使用者自行安装，或在招聘 Agent 的 `.env` 中配置 `CHROME_PATH`。

## 已有本机 Node/pnpm 时能不能删除这里的大目录

可以。只要确认本机 `node -v` 是 20 或以上，并且 `pnpm -v` 可用，就不需要随包 Node/pnpm 缓存。可以删除准备脚本生成的这些目录来减小体积：

```text
node/
corepack/
pnpm-store/
message-platform-vendor/
_downloads/
```

删除后，保留本 README 即可。后续如果换到没有 Node/pnpm 的电脑，再重新运行 `准备运行环境.cmd` 生成。

## 给 AI/维护者的重建入口

每个子目录都有独立 `INSTALL.md`，可直接交给 AI 或维护者按说明重建：

- `node/INSTALL.md`：下载官方 Node.js 便携 zip、校验 SHA256、解压为 `node/`。
- `corepack/INSTALL.md`：通过 Node 自带 corepack 准备 `pnpm@9.15.9`。
- `pnpm-store/INSTALL.md`：说明 pnpm 缓存如何在安装依赖时生成。
- `message-platform-vendor/INSTALL.md`：从 `message-platform/vendor` 的锁文件安装飞书 SDK。
- `_downloads/INSTALL.md`：说明下载缓存用途；该目录可以为空或删除。
