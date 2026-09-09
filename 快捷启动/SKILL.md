# 本地招聘 Agent 分享包使用 Skill

你是接手本分享包的新 AI。请先遵守以下规则：

1. 不要读取、输出或提交 `.env`、Chrome Profile、Cookie、token、真实日志中的密钥。
2. 不要在用户未明确授权时触发真实飞书发送、招聘平台自动采集、长连接监听或定时任务注册。
3. 优先使用 `快捷启动/快捷启动脚本` 下的入口脚本；它们会用脚本自身路径推导分享包根目录，不依赖当前工作目录。
4. 需要理解产品设计时，先读根目录 `README.md`，再读 `docs/prd/` 下两份 PRD。
5. 需要修改代码时，招聘 Agent 在 `招聘智能体/recruitment-agent`，消息平台在 `消息平台/message-platform`。这两个顶层目录已按实际职责命名；招聘采集和 19:00 日报调度均在招聘 Agent 内，消息平台只负责收发、重试、审计和群聊 Agent 路由。
6. 需要给用户可复制命令时，不要只给 `.\快捷启动\...` 相对路径；必须给出会先进入分享包根目录的完整命令。若不知道实际安装目录，先让用户打开 `快捷启动/页面UI/index.html` 复制页面动态生成的命令，或把 `<分享包实际安装目录>` 替换为真实目录。

## 快速路径

分享包四块主结构：

```text
招聘智能体/recruitment-agent   招聘 Agent
消息平台/message-platform       消息发送/转发平台
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

- 招聘 Agent 配置：`招聘智能体/recruitment-agent/.env.example` 复制为 `.env`。
- 消息平台配置：`消息平台/message-platform/.env.example` 复制为 `.env`。
- 候选人画像：`招聘智能体/recruitment-agent/config/candidate_profiles/`。
- 搜索策略：`招聘智能体/recruitment-agent/config/search_strategy.json`。
- 评分规则摘要：`招聘智能体/recruitment-agent/config/profile_rules.json`。
- 招聘平台总开关：`招聘智能体/recruitment-agent/config/platform_channels.json`。
- 定时策略唯一配置源：`招聘智能体/recruitment-agent/config/schedule_policy.json`。

## 首次使用必须核对的配置

下面按“必须”和“按需”区分，不要一次把所有开关都打开：

1. **运行环境（必须）**：Node.js 22.4.0+；消息平台依赖由 `准备运行环境.cmd` 安装。低版本必须停止并给出中文提示。
2. **候选人资料（必须）**：替换 `config/candidate_profiles/` 中的示例画像，并在 `config/profile_rules.json` 填写真实目标城市、目标薪资和筛选规则。示例画像未替换时不得正式运行。
3. **招聘平台（必须选择至少一个）**：在 `config/platform_channels.json` 或本地控制台开启 BOSS/猎聘整条任务流；BOSS `detail_capture` 默认保持 `true`。
4. **浏览器登录（已开启平台必须）**：确认 `CHROME_PATH`、`CHROME_CDP_PROFILE_DIR`、`CDP_HOST/CDP_PORT`，然后只为已开启的平台运行可见登录入口。验证码与风控必须由用户人工完成。
5. **日报模式（必须确认）**：`SCHEDULE_SEND_MODE` 缺失时保持 `draft`。首次先跑草稿；只有用户确认内容和飞书目标后才设为 `send`。`WATCHDOG_SEND_MODE` 也必须单独确认。
6. **飞书主动发送（真实发送时必须）**：填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_CHAT_ID`，同时确认 `FEISHU_SEND_MODE`。消息平台的 channel/route 白名单和群 ID 必须一致。
7. **HTTP 入站（仅使用回调时）**：填写 `FEISHU_EVENT_VERIFY_TOKEN`；启用 Encrypt Key 时再填 `FEISHU_EVENT_ENCRYPT_KEY`。默认 `HTTP_HOST=127.0.0.1`，不得为图省事暴露到所有网卡。
8. **AI（可选）**：分享包默认关闭。需要 AI 时再配置本机 Codex 或 OpenAI 兼容 API；不可用时应按项目规则降级，不能阻止确定性主流程。
9. **定时策略（启用计划任务前必须）**：展示并确认 `schedule_policy.json` 当前时间；先用 `-GenerateOnly` 预览，再经用户同意注册。项目移动或改名后，必须重新注册，因为 Windows action 保存的是绝对路径。

## 首次登录前必须向用户说明

1. 先确认 `platform_channels.json` 中要使用的平台已开启。`enabled=false` 会关闭该平台从登录检查、采集、筛选、评分、岗位状态刷新到日报的整条链路；不要只改旧的 `ENABLE_BOSS` / `ENABLE_LIEPIN` 环境变量。
2. BOSS 的 `detail_capture` 默认应为 `true`，含义是采集列表后继续打开岗位详情、补齐完整 JD。它不是平台开关，也不代表登录状态。关闭后只得到列表摘要，候选必须标记“详情待确认”。
3. 只为已启用的平台打开可见登录窗口，人工完成扫码、验证码或安全验证。自动化不得保存密码、代做验证码或绕过风控。
4. 向用户展示 `schedule_policy.json` 的当前时间：上午 09:00/10:00/11:00/12:00，下午 13:00–18:00 每小时，日报 19:00/19:30/20:00/20:30，watchdog 21:05；所有时间错过不补、不唤醒电脑。
5. 当前策略还要求上午、下午各最多成功采集一次，两次成功至少相隔 2 小时；只有 `success` 占用半天名额，失败或部分成功可在下一独立时间重试。19:00–21:00 若最后一次成功采集已满 2 小时则先采集再出日报，否则直接汇总。
6. 修改时间 JSON、移动安装目录或修改文件夹名后，只有在用户明确同意注册定时任务时才能运行 `bin/create_windows_task.example.ps1`。注册脚本会重建主任务和 watchdog，并自动用 `bin/verify_windows_tasks.ps1` 校验；只改 JSON 或只移动目录而不重建 Windows 任务不会生效。

`SCHEDULE_SEND_MODE` 缺失时必须保持草稿模式。只有用户明确授权真实发送、飞书配置检查通过并且草稿已确认后，才可改为 `send`。

分享包默认关闭采集、发送和 AI。配置不完整时，程序应输出中文配置清单并退出，不应启动 Chrome 或真实发送。

首次换电脑运行时，先执行 `快捷启动/快捷启动脚本/准备运行环境.cmd`。它会先检查本机 Node.js 22.4.0+ 和 pnpm；这是因为项目直接使用 Node 的全局 `WebSocket`，22.4.0 起该能力为稳定版本。本机可用时优先使用本机环境并只补飞书 SDK 依赖，本机缺失或版本过低时才准备随包 Node/pnpm。首次配置检查和每个正式运行入口都必须阻止低版本 Node 继续运行。

不要把命令粘贴到 Windows 文件管理器地址栏；文件管理器地址栏只适合输入文件夹路径，不执行命令。HTML 控制台的“复制命令”会生成实际安装路径下的完整一行命令。
