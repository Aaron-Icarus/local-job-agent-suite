# 本地招聘信息智能体与飞书消息转发平台

这是一个本地运行的求职信息自动化项目，用来把“人工反复刷招聘渠道、筛岗位、整理日报、生成打招呼话术”这条链路尽量自动化。

项目会读取候选人的简历和目标岗位要求，通过本地浏览器登录招聘网站，定时获取最新岗位信息，做本地入库、岗位编号、匹配评分、日报草稿和飞书推送。同时支持根据岗位信息和候选人画像生成 100-200 字的招聘方打招呼话术。

## 要解决的问题

- 招聘渠道需要反复刷新，人工检查容易漏掉新岗位。
- 不同平台的岗位信息格式不统一，难以持续记录和去重。
- 每天需要把“新增岗位、重点岗位、风险岗位、建议动作”整理成可读日报。
- 和招聘方沟通前，需要快速生成贴合个人经历和岗位要求的打招呼话术。
- 飞书群里希望能通过岗位编号、岗位链接、JD 文本或截图文字触发 Agent 协作。

## 项目结构

本仓库包含两个可以独立运行，也可以协同使用的应用：

- `AI消息群聊转发agent/recruitment-agent`
  - 招聘信息智能体。
  - 负责读取候选人画像、登录招聘渠道、采集岗位、清洗字段、评分筛选、维护本地岗位库、生成日报和岗位话术。

- `定时执行agent程序/message-platform`
  - 消息发送转发与智能体调度平台。
  - 负责飞书消息发送、重试、发送审计、群消息接收、会话路由和 Agent 调用。

## 大致流程

1. 配置候选人简历、求职意向和岗位筛选规则。
2. 手动触发一次可见浏览器登录 BOSS、猎聘等招聘渠道。
3. 招聘 Agent 按计划采集岗位信息，并写入本地岗位库。
4. 系统对岗位做去重、编号、确定性规则评分，并在启用 AI 时做评分复核。
5. 每日生成岗位报告草稿；确认配置后可推送到飞书群。
6. 群内需要岗位话术时，可通过岗位编号、链接、JD 文本或截图文字触发生成。

## AI 调用策略

本项目的 AI 使用是透明且可配置的。

分享包默认使用最小策略：`AI_DEFAULT_MODE=disabled`，不会自动调用 Codex、OpenAI 兼容 API 或其他外部 LLM，也不会要求 API Key。

如果使用方明确开启 AI 模式，可以通过 `AI消息群聊转发agent/recruitment-agent/.env` 配置：

- `AI_DEFAULT_MODE=auto`
- `AI_DEFAULT_PROVIDER_ORDER=codex_runtime,openai_api`
- `CODEX_RUNTIME_COMMAND=...`
- `AI_OPENAI_API_KEY=...` 或 `OPENAI_API_KEY=...`
- 单步骤覆盖：`AI_PROFILE_*`、`AI_SEARCH_KEYWORDS_*`、`AI_FIT_EVALUATION_*`、`AI_GREETING_*`

调用优先级是：

1. 先尝试本机已配置的 Codex runtime，也就是调用本机已登录的 Codex/LLM 入口；如果未配置自定义命令，则默认尝试 `codex exec`。
2. Codex runtime 不可用时，再尝试 OpenAI 兼容 API。
3. 搜索关键词、岗位评分复核、打招呼话术如果 AI 不可用，会降级到静态策略或确定性规则。
4. 候选人画像生成没有可靠的规则兜底；AI 不可用时会直接报错。

当前接入统一 AI Router 的任务包括：

- `profile`：根据简历和求职目标生成候选人画像 Markdown。
- `search_keywords`：基于候选人画像、`config/search_strategy.json` 和最近历史关键词效果优化每日搜索关键词；失败时回退静态关键词。空构建包首次运行没有历史数据时，会自然退化为“画像 + 静态策略”。
- `fit_evaluation`：在确定性评分之后复核前 N 个岗位，补充匹配理由、风险和建议；失败时保留规则评分。
- `greeting`：生成 100-200 字打招呼话术；失败时回退规则模板。

提示词目前是源码内联，不是单独的配置文件。对应位置是 `src/greeting/build_candidate_profile.js`、`src/strategy/search_keyword_generator.js`、`src/evaluate/ai_fit_refiner.js` 和 `src/greeting/greeting_recommender.js`。部署者可以修改源码提示词，但尚未提供面向非开发者的 prompt 配置面板或 JSON prompt 文件。

这意味着：仓库本身不包含 Codex 账号、OpenAI Key 或任何模型凭据；是否调用 AI、调用哪种 AI，都由部署者本地配置决定。

AI 调用采用“握手 + 流式 + 长总时限”协议，避免模型已开始运行却被短超时误杀：

- `AI_DEFAULT_HANDSHAKE_TIMEOUT_MS`（默认 90000，兼容旧 `AI_DEFAULT_TIMEOUT_MS`）：等待模型进程**开始产出输出**的窗口；窗口内无任何输出才 Kill。
- 收到首个输出即视为已启动，此后不再使用短时限，改用 `AI_DEFAULT_TOTAL_TIMEOUT_MS`（默认 1800000，即 30 分钟）作为总预算并持续等待；Codex 以 `codex exec --ephemeral --skip-git-repo-check --sandbox read-only --json` 调用，JSONL 事件流与进度实时写入 `logs/ai_runtime/`，最终答案优先取事件流 result 事件。
- 单步可用 `AI_<用途>_HANDSHAKE_TIMEOUT_MS` / `AI_<用途>_TOTAL_TIMEOUT_MS` 覆盖；OpenAI 兼容 API 兜底同样按长总时限执行。详细说明见 `AI消息群聊转发agent/recruitment-agent/README.md`。

## 搜索、评分与跟踪规则

每日搜索关键词的基础策略在 `AI消息群聊转发agent/recruitment-agent/config/search_strategy.json`。它按三层组织：

- 岗位信息：直接搜索目标岗位名，命中更准。
- 经历关键词：用简历经历和目标方向组合，发现标题不标准但职责匹配的岗位。
- 宽泛词：扩大召回，再靠后续筛选和评分过滤。

启用 AI 后，系统会先读取当前候选人画像，再调用统一 AI Router 优化关键词；如果 AI 不可用或返回格式不合格，就继续使用静态 `search_strategy.json`。

关键词优化会参考最近采集和评分产物中的效果数据，包括关键词候选数、实际入库数、高匹配岗位数、空结果、重复和平台异常。它的目标不是只搜岗位名，而是组合“AI/智能体/Agent/大模型 + 项目管理/交付/产品/平台/解决方案”等职责词，尽量发现标题不标准但职责匹配的机会。

当前采集仍以搜索结果第一页为主；BOSS 的滚动用于定位当前页详情，不等于跨页采集。后续如要避免通用关键词长期只看到第一页，应增加低频、可配置、带风控降频的页码轮换策略。

岗位评分分两段执行：

- `src/evaluate/evaluate_job_fit.js`：确定性规则评分，生成角色类型、非技术匹配、AI/智能体相关性、项目交付、产品能力、行业经验、薪资、地点、活跃度和详情可信度等分项分。
- `src/evaluate/ai_fit_refiner.js`：AI 复核层，默认只复核前 `AI_FIT_EVALUATION_MAX_ROWS` 条，并把结果写回 `overall_fit_score`、`application_success_score`、`focus_level`、`match_reasons_json`、`risk_reasons_json` 等字段。

评分规则是显性的，但尚未完全配置化。`config/profile_rules.json` 当前直接影响目标城市、低优先区域、薪资区间和活跃度阈值；分数权重、标题/职责识别词、关注等级阈值仍在 `src/evaluate/evaluate_job_fit.js` 中。也就是说，规则集中在招聘 Agent 的 `config/` 与 `src/evaluate/` 区域，能看、能改，但还不能只靠一个配置文件完成所有调整。

岗位跟踪使用本地文件维护，不依赖数据库：

- `data/job_store.json`：长期岗位库。
- `data/job_display_index.json`：对外岗位编号和近似重复关系。
- `data/push_state.json`：推送去重、送达记录和报告状态。
- `src/store/job_store_update.js`：入库、快照和开放状态刷新。
- `src/push/job_push_draft_and_send.js`：挑选新增/变化岗位生成日报，送达后才标记已推送。

晚间 19:00-21:00 日报只有 `success` 会封版；如果出现 `partial_success` 或 `failed`，会在窗口内按 `SCHEDULE_REPORT_RETRY_GAP_MINUTES` 重试，默认 30 分钟。采集告警会写明含义、保存记录数、失败关键词、平台错误、影响和建议动作，便于判断是登录态、安全验证、平台风控还是浏览器/CDP 问题。

## 当前适配环境

当前第一目标环境是个人电脑或个人 Windows 工作站：

- Node.js 20+
- PowerShell
- Chrome 或 Chromium
- 可持久化的浏览器 Profile
- 本地文件系统
- 飞书机器人或飞书应用凭据

理论上可以迁移到服务器运行，但需要额外适配：

- 服务器需要安装 Chrome/Chromium，并开放或启动 CDP 调试端口。
- 招聘网站登录、验证码、安全验证仍可能需要人工介入或远程可视化环境。
- Windows 任务计划程序需要替换为服务器上的 cron、systemd timer 或其他调度系统。
- PowerShell 脚本可在 PowerShell 7 环境下运行；也可以直接调用 Node.js 入口自行接入调度。
- 需要自行处理服务器上的浏览器 Profile 持久化、网络访问、进程守护和日志归档。

因此，本仓库不是开箱即用的云服务或 SaaS 后端；它更接近“本地自动化 Agent 套件”。

## 暂不支持的事项

- 暂未使用正式数据库；岗位库、发送审计和运行状态主要使用本地 JSON/JSONL 文件。
- 暂未提供多用户系统、账号权限后台或 SaaS 部署面板。
- AI 调用采用最小策略，默认不调用外部模型；高级模型编排、成本控制、多模型评估和独立 prompt 配置暂未产品化。
- 岗位沟通跟进模块尚未上线，例如是否已沟通过、沟通进展、面试状态、后续提醒等。
- 暂未承诺服务器无人值守采集成功率；招聘平台安全验证仍可能中断采集。
- 当前重点围绕 BOSS、猎聘和飞书链路，其他招聘渠道需要新增采集适配器。

## 快速开始

完整操作见根目录的 `项目快速使用说明.txt`。

首次使用建议顺序：

1. 复制两个应用中的 `.env.example` 为 `.env`，只填自己的凭据。
2. 替换 `config/candidate_profiles/sample_candidate.md` 为自己的简历和求职目标。
3. 保持采集、发送和浏览器自动启动默认关闭，先跑本地测试。
4. 使用可见登录脚本完成招聘网站登录。
5. 先运行草稿模式，确认岗位数据和日报内容。
6. 最后再开启飞书真实推送和定时任务。

## 版本迭代

- **2026-09-04 v0.3.0**：本地 Codex 调用链升级为“握手 + 流式 + 长总时限”协议（`src/core/ai_router.js`）；统一 AI Router 覆盖候选人画像、搜索关键词、评分复核与打招呼话术；新增 `src/strategy/search_keyword_generator.js`（AI 关键词优化）、`src/evaluate/ai_fit_refiner.js`（AI 评分复核）；空包/示例画像下话术返回“候选人画像尚未配置”引导；晚间报告 `partial_success/failed` 在 21:00 前自动重试。

## 安全说明

本分享包是脱敏空项目，不包含真实候选人信息、岗位库、Chrome 登录态、飞书群 ID、飞书密钥或 GitHub token。

不要提交或分享以下运行产物：

- `.env`
- `logs/`
- `data/`
- `outputs/`
- Chrome Profile
- 真实简历、真实岗位库和真实飞书群配置
