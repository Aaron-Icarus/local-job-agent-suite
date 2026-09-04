# AI消息群聊转发agent PLAN

## 初始目标

搭建一个可配置的群聊消息转发 Agent 框架，使飞书群、未来微信群等外部对话源可以作为智能体输入入口。用户在群里 `@机器人` 发送指令后，系统能识别真实消息、路由到指定 Agent、执行逻辑，并把结果回发到群里。

## 初始需求

- 支持对话配置：可配置多个来源渠道、多个群、不同群的逻辑和开关。
- 支持 Agent 配置：先注册 Agent 的输入口、用途、输入格式和输出逻辑，再由群配置引用。
- 默认关闭：开关默认关；不配置 Agent 或配置不完整时只能关闭，不能监听和转发。
- 消息清洗：外部渠道消息至少要支持 @ 或固定格式触发，并脱掉 @、前缀、引用文本等噪声。
- 可切换 AI 识别器：当前先用规则，未来可配置为 Codex、CDH 或其他 API。
- 多轮对话：需要能判断是续接已有任务，还是新建任务，避免每条消息都是新对话，也避免无限累加上下文。
- 文件组织：根目录只留两个 md 文件和配置文件，代码、测试、数据、日志放子文件夹。
- 初始群：构建包不包含真实群聊；接收者须在 `message-platform/.env`、`channels.config.json` 与 `routes.config.json` 填入自己的测试群，并在确认前保持渠道关闭。

## 设定方向

采用“确定性规则为主，AI 判断为辅”的方案：

- 确定性规则负责安全开关、白名单、@ 触发、任务 ID、回复关系、路由命令。
- AI 识别器只作为后续增强，用来从自然语言中提取意图、岗位信息和续接/新建判断。
- 每个明确任务创建 `task_session`，而不是把整个群聊塞进一个无限上下文。

## 指定方案

总体链路：

```text
飞书事件
  -> feishu_event_parser
  -> channel/conversation 开关和白名单校验
  -> message_cleaner
  -> agent_router
  -> session_router
  -> executor_factory
  -> feishu_sender
  -> data/logs 记录
```

多轮续接优先级：

1. 消息包含明确任务 ID，续接对应 `task_session`。
2. 消息回复/引用机器人上一条结果，续接对应 `task_session`。
3. 消息包含“刚才、上一个、这条、修改”等续接关键词，且有效时间窗口内只有一个活跃任务，续接。
4. 消息包含“新任务、重新开始、换一个”等关键词，新建任务。
5. 不确定时，未来交给可配置 AI 识别器判断。

## 代码框架说明

根目录：

- `README.md`：运行说明。
- `PLAN.md`：给 AI 读取的项目全局说明。
- `runtime.config.json`：运行配置和状态路径。
- `channels.config.json`：外部渠道配置。
- `agents.config.json`：Agent 注册表。
- `routes.config.json`：群配置、命令路由和 session 策略。

子目录：

- `src/core/`：配置加载、环境变量加载、JSON 文件工具。
- `src/channels/`：飞书事件解析和飞书消息发送。
- `src/messages/`：外部消息清洗。
- `src/routing/`：Agent 路由和 session 路由。
- `src/sessions/`：session store。
- `src/executors/`：不同 Agent 执行器。
- `src/app/`：事件处理入口和 HTTP server。
- `src/cli/`：本地模拟、状态消息发送等命令行入口。
- `tests/`：自测脚本和事件样例。
- `data/`：运行状态。
- `logs/`：事件日志。

## 当前内置 Agent

### `job_greeting_agent`

用途：根据岗位信息生成招聘平台打招呼消息。

输入：清洗后的用户消息、群信息、session、附件元数据。

输出：带任务 ID 的群聊回复文本。

当前执行器：规则版 `job_greeting`。后续可替换为 Codex/CDH/OpenAI API。

### `ping_agent`

用途：验证链路连通性。

输入：`ping` 或测试消息。

输出：`pong`。

## 当前限制

- 新飞书测试群已实现飞书长连接接收；旧岗位群仍保留 HTTP 回调样式的解析和本地 HTTP server。
- 第一版消息 AI 使用规则实现，`runtime.config.json` 已预留 Codex/CDH/API 切换配置。
- 微信接入仅保留配置扩展方向，尚未实现适配器。
- 正式开启监听前，需要手动把对应 channel 和 conversation 的 `enabled` 改为 `true`，并完成飞书事件订阅或长连接接入。

## 当前补充：岗位编号与话术协作

群内用户可以仅写“处理 A004”或“给 A004 写打招呼话术”。系统应从既有岗位推送程序的 `data/job_display_index.json` 解析编号，向下游 Agent 提供完整岗位档案，而不是依赖群消息历史。

当前执行边界是：消息平台负责清洗群消息、判断显式命令/引用续接、维护 session 和回发；招聘 Agent 负责岗位编号解析、候选人画像、岗位匹配、AI/规则降级和最终话术生成。消息平台不直接读取招聘项目内部岗位 JSON。

岗位打招呼提示词参考存放于消息平台的 `prompts/job_greeting_agent.md`，真实执行器会调用招聘 Agent 的 `recruitment-agent/src/greeting/job_greeting_agent.js#createGreetingResponse(request)`。招聘 Agent 内部再通过统一 AI Router 决定使用本机 Codex、OpenAI 兼容 API，还是规则兜底。分享包默认关闭 AI，需要使用者明确配置后才会调用模型。

## 当前测试状态

2026-09-01 已按用户指令打开初始飞书群的 channel 和 conversation 开关，并将实际机器人显示名 `moi智能体接收和回复调用` 加入消息清洗别名。入站接收仍依赖飞书开放平台授权：实测读取群消息接口返回缺少 `im:message.group_msg` 权限；在飞书后台补齐权限或配置 `im.message.receive_v1` 事件订阅/长连接前，外部群消息无法送达本地程序。

## 2026-09-02 新飞书测试群

已新增 `feishu_moi_test_group`：使用长连接（WebSocket）接收 `im.message.receive_v1`，目标群由本地密钥文件配置。接收端会解析 `content` 的 JSON 字符串，并按 `mentions[].key` 去掉飞书的 `@_user_1` 等提及占位符；处理成功后调用消息 reply 接口，引用回复用户触发的原消息。

相关实现：`src/channels/feishu_long_connection.js`、`src/channels/feishu_sender.js`、`src/messages/message_cleaner.js`。运行命令为 `node src/cli/start_feishu_long_connection.js`。项目配置看板位于 `ui/project-dashboard.html`，只展示脱敏后的模块和配置状态。

当前桌面环境的通用代理变量会干扰该 SDK 的 WebSocket 建连。因此启动器仅在自身 Node 进程中清除相关代理变量后再建立飞书长连接；这一处理不修改操作系统的代理配置。

## 自测验收记录

已完成本地自测：

- `node --check src/**/*.js` 等价语法检查通过。
- `node .\tests\run_tests.js` 通过。
- `node .\src\cli\simulate_event.js .\tests\fixtures\feishu_greeting_event.json --force-enabled --no-send` 通过。
- HTTP `/health` 检查通过。
- 根目录文件布局检查通过：根目录文件仅包含 `README.md`、`PLAN.md` 和 `.config.json` 配置文件。

## 2026-09-04 当前执行说明（以本章为准）

本目录当前承载**招聘信息智能体**，可运行工程位于 `recruitment-agent/`；历史中关于“本目录直接承载消息转发代码”的描述仅保留为演进记录。

- 入口：`recruitment-agent/run_daily_job_agent.ps1 -Scheduled`。Windows 任务 `BOSS Job Agent Daily` 已指向该入口，并每 30 分钟唤起一次，由程序自行决定是否执行。
- 采集：上午、下午各最多一次；19:00–21:00 进行日报。电脑未开机不补跑。当天 BOSS 或猎聘任一平台失败时，不会回退使用历史文件。
- 新鲜度：自动工作流只接受当天采集链路产生的产物；手工复跑历史数据必须显式设置 `ALLOW_STALE_INPUT=true`。
- 状态：支持 `success`、`partial_success`、`failed`。单平台失败会告警并保留另一平台的当日结果；不会把部分成功记成完整成功。采集告警必须说明含义、保存记录数、失败关键词、平台错误、影响和建议动作。
- 晚间补跑：19:00–21:00 日报只有 `success` 会封版；`partial_success` 或 `failed` 会按 `SCHEDULE_REPORT_RETRY_GAP_MINUTES` 在窗口内重试，默认 30 分钟。
- 推送：岗位按稳定 ID、目标分组、内容变化和实际送达记录去重。安静日可发送空摘要，但不会因日期变化重复列出历史岗位。
- 话术：支持岗位编号、岗位文字、链接/OCR 转文字。未知 A/B 编号必须明确提示，不生成“未知岗位”话术。AI 不可用时按配置降级到规则话术。
- 登录：日常 CDP 浏览器后台运行；需要人工扫码、失效恢复或安全验证时，使用 `recruitment-agent/tools/open_chrome_cdp_for_login.ps1` 打开可见浏览器。BOSS 登录失败会被隔离，不使用旧数据。
- AI：候选人画像、搜索关键词、岗位评分和打招呼话术统一通过 `recruitment-agent/src/core/ai_router.js` 调用。分享包默认关闭 AI；启用后默认优先本机已登录 Codex，`openai_api` 仅作为可选兜底。步骤可用 `AI_<用途>_*` 覆盖模型/提供方，失败后才整体回退 `AI_DEFAULT_*`；调用状态写入脱敏的 `logs/ai_calls.log`，评分、关键词和话术均保留是否降级的可见状态。Windows 定时环境可能没有交互终端 `PATH`，如出现 `spawn codex ENOENT`，应在自己的 `.env` 设置 `CODEX_RUNTIME_BIN` 绝对路径或 `CODEX_RUNTIME_COMMAND`，不要提交个人路径。
- 关键词：静态策略仍在 `recruitment-agent/config/search_strategy.json`；启用 AI 后，关键词生成必须结合当前候选人画像、静态策略和最近历史关键词效果，减少空结果、重复首页和风控高发关键词，并补充 AI+项目/交付/产品/智能体/大模型等组合词。空构建包首次运行没有历史数据，会自然退化为画像+静态策略。
- 翻页：当前 BOSS/猎聘采集仍以搜索结果第一页为主，BOSS 滚动只用于定位当前页详情；跨页采集、页码轮换和基于历史重复率的低频翻页是后续优化项，实施时必须考虑平台风控降频。
