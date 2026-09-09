# 本地招聘 Agent 分享包使用 Skill

你是接手本分享包的新 AI。请先遵守以下规则：

1. 不要读取、输出或提交 `.env`、Chrome Profile、Cookie、token、真实日志中的密钥。
2. 不要在用户未明确授权时触发真实飞书发送、招聘平台自动采集、长连接监听或定时任务注册。
3. 优先使用 `快捷启动/快捷启动脚本` 下的入口脚本；它们会用脚本自身路径推导分享包根目录，不依赖当前工作目录。
4. 需要理解产品设计时，先读根目录 `README.md`，再读 `docs/prd/` 下两份 PRD。
5. 需要修改代码时，招聘 Agent 在 `AI消息群聊转发agent/recruitment-agent`，消息平台在 `定时执行agent程序/message-platform`。
6. 需要给用户可复制命令时，不要只给 `.\快捷启动\...` 相对路径；必须给出会先进入分享包根目录的完整命令。若不知道实际安装目录，先让用户打开 `快捷启动/页面UI/index.html` 复制页面动态生成的命令，或把 `<分享包实际安装目录>` 替换为真实目录。

## 快速路径

分享包四块主结构：

```text
AI消息群聊转发agent/recruitment-agent   招聘 Agent
定时执行agent程序/message-platform       消息发送/转发平台
docs/prd/                               两份产品 PRD
快捷启动/                               启动脚本、页面 UI、AI 使用说明
```

## 常用动作

准备运行环境：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\prepare_runtime.ps1'"
```

新手菜单入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\prepare_runtime_menu.ps1'"
```

查看运行环境状态：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\check_runtime.ps1'"
```

打开本地控制台：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\start_dashboard.ps1'"
```

首次配置检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\first_config_check.ps1'"
```

BOSS 可见登录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\open_boss_login.ps1'"
```

猎聘可见登录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\open_liepin_login.ps1'"
```

草稿测试：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\快捷启动\快捷启动脚本\run_draft.ps1'"
```

## 配置重点

- 招聘 Agent 配置：`AI消息群聊转发agent/recruitment-agent/.env.example` 复制为 `.env`。
- 消息平台配置：`定时执行agent程序/message-platform/.env.example` 复制为 `.env`。
- 候选人画像：`AI消息群聊转发agent/recruitment-agent/config/candidate_profiles/`。
- 搜索策略：`AI消息群聊转发agent/recruitment-agent/config/search_strategy.json`。
- 评分规则摘要：`AI消息群聊转发agent/recruitment-agent/config/profile_rules.json`。

分享包默认关闭采集、发送和 AI。配置不完整时，程序应输出中文配置清单并退出，不应启动 Chrome 或真实发送。

首次换电脑运行时，先执行 `快捷启动/快捷启动脚本/准备运行环境.cmd`。它会先检查本机 Node.js 20+ 和 pnpm；本机可用时优先使用本机环境并只补飞书 SDK 依赖，本机缺失或版本过低时才准备随包 Node/pnpm。快捷运行入口应优先使用本机 Node.js 20+，再用随包 Node 兜底。

不要把命令粘贴到 Windows 文件管理器地址栏；文件管理器地址栏只适合输入文件夹路径，不执行命令。HTML 控制台的“复制命令”会生成实际安装路径下的完整一行命令。
