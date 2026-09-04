# 多平台岗位定时 Agent

这个目录是“定时搜索岗位 -> 存本地 -> 评价匹配度 -> 生成岗位搜索汇总草稿 -> 可选推送”的项目根目录。

## 当前工程结构

```text
recruitment-agent/
  run_daily_job_agent.ps1              # 根目录兼容入口，Windows 计划任务仍可调用
  package.json
  .env                                 # 真实配置，不提交
  .env.example
  plan.md
  README.md

  bin/                                 # 命令入口和计划任务脚本
    run_daily_job_agent.ps1
    create_windows_task.example.ps1

  src/
    main/                              # 日常流程编排
      scheduled_entry.js
      daily_workflow.js
    core/                              # 共享工具
      load_env.js
      time_utils.js
      field_dictionary.js
      cdp_common.js
    platforms/
      boss/                            # BOSS 采集、登录检查、后处理
      liepin/                          # 猎聘采集、登录检查、后处理
    evaluate/                          # 岗位适配度评价
    greeting/                          # 打招呼话术推荐与岗位查询智能体
    push/                              # 草稿、飞书、邮件推送
    store/                             # 长期岗位库、推送记录、开放状态刷新

  tools/                               # 人工登录、CDP 修复和调试工具
  config/                              # 搜索策略和画像规则
  docs/                                # 简历画像、需求说明、字段说明
  data/                                # 调度状态、推送状态、草稿
  outputs/                             # CSV/JSON 采集与评价结果
  logs/                                # 定时和流程日志
  chrome-cdp-profile/                  # 项目专用 Chrome 登录态
```

## 已内置流程

1. `src/platforms/boss/boss_batch_collect.js`：通过已登录 Chrome CDP 读取 BOSS 搜索列表，并尽量监听详情接口。
2. `src/platforms/liepin/liepin_batch_collect.js`：通过同一个项目专用 Chrome CDP profile 读取猎聘搜索页列表卡片，写入猎聘自己的原始表；详情补采默认关闭。
3. `src/platforms/boss/postprocess_boss_stage2.js` / `src/platforms/liepin/postprocess_liepin_stage2.js`：分别补充中文表头、去重键、活跃日期、薪资和初筛字段。
4. `src/evaluate/evaluate_job_fit.js`：基于你的简历画像和目标岗位规则追加适配度评价字段；BOSS 和猎聘分别输出评价文件。
5. `src/push/job_push_draft_and_send.js`：合并多个平台的评价结果，并默认按平台拆分成多条每日推送草稿；只有 `SEND_MODE=send` 或 `--send` 时才发送。
6. `src/store/job_store_update.js`：维护长期岗位库，记录岗位开放状态、关闭时间、推送历史、在聊状态和数据变动时间。
7. `src/greeting/greeting_recommender.js`：根据单个岗位 JD 和当前推荐人画像生成招聘平台打招呼话术；AI 模式优先使用最近 3 年、其次最近 5 年的可验证经历。
8. `src/greeting/candidate_profile.js` / `build_candidate_profile.js`：维护当前推荐人，并可从简历文字和求职目标生成候选人画像 Markdown。
9. `src/greeting/job_greeting_agent.js`：供飞书消息转发或其他组件调用；支持岗位编号、本次岗位 JSON、截图 OCR 文字三种输入，统一返回岗位摘要和打招呼话术。
10. `src/main/daily_workflow.js`：串起完整日常流程。
11. `src/main/scheduled_entry.js`：判断当前时间段是否需要执行搜索、评价和推送。

## 配置

复制 `.env.example` 为 `.env`，填入真实配置。旧材料里的飞书应用配置可映射到：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_CHAT_ID`，也兼容旧字段 `FEISHU_TEST_CHAT_ID`

邮件配置兼容旧项目的 SMTP 思路：

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASSWORD` 或 `SMTP_PASS`
- `MAIL_FROM`
- `MAIL_TO`

默认 `SEND_MODE=draft`，只写草稿，不发送。当前定时晚间推送由 `SCHEDULE_SEND_MODE` 控制。

## 常用命令

先确保 Chrome 用 CDP 模式启动，并且已经登录需要采集的平台：

```powershell
powershell -ExecutionPolicy Bypass -File .\run_daily_job_agent.ps1 -DraftOnly
```

根目录 `run_daily_job_agent.ps1` 是兼容 wrapper，真实实现位于 `bin/run_daily_job_agent.ps1`。保留这个 wrapper 是为了不破坏已经注册的 Windows 计划任务。

单独检查 BOSS 登录态并新开一个页面：

```powershell
node .\src\platforms\boss\check_boss_login_status.js --new
```

单独检查猎聘登录态：

```powershell
node .\src\platforms\liepin\check_liepin_login_status.js --new
```

如果定时任务失败在登录态预检，先打开本项目专用 CDP Chrome 做人工扫码或安全验证：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\open_chrome_cdp_for_login.ps1
```

如果猎聘需要首次登录或重新验证：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\open_liepin_cdp_for_login.ps1
```

确认草稿无误后，可手动发送最新草稿：

```powershell
powershell -ExecutionPolicy Bypass -File .\run_daily_job_agent.ps1 -SendLatestDraft
```

创建 Windows 计划任务示例：

```powershell
powershell -ExecutionPolicy Bypass -File .\bin\create_windows_task.example.ps1
```

默认任务名仍是历史遗留的 `BOSS Job Agent Daily`，但实际执行的是当前多平台流程。保留这个名字是为了避免和已经注册的计划任务割裂。

## npm scripts

这些是辅助命令；如果当前 PowerShell 环境没有 `npm`，直接使用上面的 `node ...` 或 `powershell ...` 命令即可。

```powershell
npm run scheduled
npm run daily
npm run login-check
npm run liepin-login-check
npm run collect
npm run liepin-collect
npm run screen
npm run evaluate
npm run job-store
npm run status-refresh
npm run draft
npm run send
npm run greeting -- A001
npm run greeting-agent -- --id A001 --json
```

这些命令已经指向整理后的 `src/` 和 `tools/` 路径。

## 自动执行逻辑

计划任务建议从 09:00 到 21:00 每 30-60 分钟触发一次 `-Scheduled`，由 `src/main/scheduled_entry.js` 判断本次是否真正执行采集：

- 09:00-12:00：当天上午未执行过，则执行一次。
- 12:00-19:00：当天下午未执行过，则执行一次。
- 19:00-21:00：进入日报窗口；如果距离上次成功采集已经超过 2 小时，则先补采再汇总。
- 其他时间：不执行采集。
- 如果电脑当时没开，就自然跳过该时间段，不补跑。
- 晚间日报只有 `success` 会封版；`partial_success` 或 `failed` 不封版，会在 21:00 前按 `SCHEDULE_REPORT_RETRY_GAP_MINUTES` 重试，默认间隔 30 分钟。

触发命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\run_daily_job_agent.ps1 -Scheduled
```

上午和下午时段只做：登录态预检 -> 搜索岗位。

19:00-21:00 时段做当天汇总推送：

- 如果距离上次成功搜索已满 2 小时：先搜索岗位，再后处理 -> 适配度评价 -> 生成草稿 -> 按 `SCHEDULE_SEND_MODE` 推送。
- 如果距离上次成功搜索不足 2 小时：直接用当天已有岗位数据做后处理 -> 适配度评价 -> 生成草稿 -> 按 `SCHEDULE_SEND_MODE` 推送。
- 如果某个平台登录态失败、平台风控或只采到部分数据，流程会记录 `partial_success`，发送可读告警，并继续使用其他平台或已确认的新鲜数据；不会用历史旧文件补齐。
- 如果晚间报告因为单平台失败变成 `partial_success`，当日 21:00 前下一次计划任务会尝试重跑，而不是把当天直接结束。

评价之后会先写入长期岗位库并生成 `outputs/*_stage4_tracked_*.csv/json`；推送完成后会把本次真实送达的岗位写入推送历史，再刷新历史开放岗位状态。当天新录入的岗位不会参与关闭判断。

当前报告标题为“日期 + 渠道 + 岗位搜索汇总”。正文保留序号、岗位编号、岗位简要信息、一句话匹配点、推荐打招呼话术和链接。`REPORT_SPLIT_BY_PLATFORM=true` 时，BOSS 和猎聘会分别生成、分别推送。

岗位编号由 `data/job_display_index.json` 持久化维护：

- BOSS 默认使用 `A001...`
- 猎聘默认使用 `B001...`
- 跨渠道或跨时间出现同公司、同岗位名且 JD 相似度达到阈值的近似岗位，会使用主岗位编号加后缀，例如 `A032-b1`。
- 近似重复岗位仍按原渠道正常推送，但排序靠后；如果对标岗位之前已经在报告中推荐过，会额外提示。
- 相似度阈值和比较窗口可用 `SIMILAR_JOB_THRESHOLD`、`SIMILAR_JOB_WINDOW_DAYS` 调整，默认分别为 `0.8` 和 `45` 天。

## 版本迭代说明

- **2026-09-04（v0.3.0）本地 Codex 调用链升级**：AI 调用改为“握手 + 流式 + 长总时限”协议——等待模型**开始产出输出**的握手窗口内无响应才 Kill（默认 90s，兼容旧 `AI_DEFAULT_TIMEOUT_MS`）；一旦启动则不再用短超时，改用 30 分钟总时限并持续流式记录进度（`logs/ai_runtime/`），避免 Codex 已在运行却因 90s 一刀切被误杀。同时统一 AI 路由覆盖画像、搜索关键词、评分复核与话术四类用途。
- 分享包安全性：空包/示例画像下话术生成会返回“候选人画像尚未配置”引导，不会输出虚构感模板话术；渠道/路由默认关闭，须自行替换群 ID 并显式启用。

## 统一 AI 调用

候选人画像、搜索关键词、岗位评分复核和打招呼话术均通过 `src/core/ai_router.js` 调用。共享包默认 `AI_DEFAULT_MODE=disabled`，不会在未配置时调用 Codex 或 API。需要启用时，将 `.env` 中的模式改为 `auto`，它会优先使用已登录的本机 Codex，再尝试可选的 OpenAI 兼容 API。

Windows 计划任务或后台进程可能拿不到交互终端里的 `PATH`。如果日志里出现 `spawn codex ENOENT`，应在 `.env` 中把 `CODEX_RUNTIME_BIN` 配为本机 `codex.exe` 的绝对路径，或配置 `CODEX_RUNTIME_COMMAND`。不要把个人机器上的绝对路径提交到共享仓库；分享包仅保留模板。

AI 调用采用“握手 + 流式 + 长总时限”：`AI_DEFAULT_HANDSHAKE_TIMEOUT_MS`（默认 90000，兼容旧 `AI_DEFAULT_TIMEOUT_MS`）等待模型进程开始产出输出，窗口内无输出才 Kill；收到首个 stdout/stderr 即视为启动成功，改用 `AI_DEFAULT_TOTAL_TIMEOUT_MS`（默认 1800000，即 30 分钟）作为总预算并持续等待。Codex 以 `codex exec --ephemeral --skip-git-repo-check --sandbox read-only --json` 调用，JSONL 事件流实时写入 `logs/ai_runtime/<purpose>_<时间>.log`（含握手、进度与最终结果，空闲每 30 秒记录心跳），最终答案优先取事件流的 result 事件；OpenAI 兼容 API 兜底同样按长总时限（响应头到达即握手成功）。单步可用 `AI_<用途>_HANDSHAKE_TIMEOUT_MS` / `AI_<用途>_TOTAL_TIMEOUT_MS` 覆盖默认值。

全局配置使用 `AI_DEFAULT_*`；也可用 `AI_GREETING_*`、`AI_PROFILE_*`、`AI_FIT_EVALUATION_*`、`AI_SEARCH_KEYWORDS_*` 覆盖单个步骤。步骤配置失败后才会完整回退至默认配置。调用日志不含简历、JD 或提示词；评分、关键词和话术输出都会标记 AI 成功或规则/静态降级。

提示词目前是源码内联，不是独立配置文件：画像生成在 `src/greeting/build_candidate_profile.js`，关键词优化在 `src/strategy/search_keyword_generator.js`，评分复核在 `src/evaluate/ai_fit_refiner.js`，打招呼话术在 `src/greeting/greeting_recommender.js`。部署者可以改源码 prompt，但暂未提供面向非开发者的 prompt JSON 或管理界面。

确定性评分分两层：`config/profile_rules.json` 当前直接驱动城市、低优先区域、薪资和活跃度参数；`src/evaluate/evaluate_job_fit.js` 管理分项权重、岗位/职责识别词和关注等级阈值。`targetRoles`、`preferredTopics`、`avoidTopics` 目前尚未自动驱动评价器，修改它们本身不会改变分数；需要同步改评价器，或后续将这些规则完全外置。建议先在草稿模式验证再调整代码权重。

当前推荐人由 `config/candidate_profiles/current.json` 指向一个 Markdown 画像。构建包内仅保留不含个人信息的 `sample_candidate.md`；使用前请替换为自己的可验证经历、求职目标和约束。AI 关键词会读取画像和现有搜索策略；AI 评分复核会读取岗位文本、画像规则和确定性基线；AI 话术会读取画像和单个岗位文本。日报只会对最终进入推送的岗位生成话术，不会为未推送岗位调用话术 AI。

AI 关键词优化还会读取 `outputs/` 中最近的采集与评分结果，形成历史关键词效果：哪些关键词产出高匹配岗位、哪些关键词空结果、重复较多或容易触发平台异常。空构建包首次使用时没有历史数据，会自然退化为“候选人画像 + 静态策略”的优化。

更新简历或求职目标时，先把已提取的简历文字、补充信息和预期岗位写入一个文本文件，再执行：

```powershell
npm run candidate-profile -- --input .\candidate_source.txt --id my_candidate
```

该命令走统一 AI 路由；未启用 AI 时会明确报错而不会写入伪造画像。成功后会重写对应候选人 Markdown 并将其设为当前推荐人。

## 话术智能体接口

消息转发组件可直接引入 `src/greeting/job_greeting_agent.js` 的 `createGreetingResponse(request)`；它返回稳定 JSON，包含岗位摘要、`greeting_message`、生成策略和匹配依据。

请求可采用以下任一种形式：

```json
{ "display_id": "A001" }
{ "job": { "company": "某公司", "job_title": "AI项目经理", "job_description": "岗位JD" } }
{ "image_ocr_text": "从岗位截图识别出的完整文字" }
```

岗位编号会从 `data/job_display_index.json` 和对应评价结果中回查最新岗位数据。截图文件本身应由上游消息框架的视觉/OCR能力提取文字后，以 `image_ocr_text` 传入。本模块不发送招聘平台消息，只生成可供人工确认的话术。

## 长期岗位库

长期岗位库文件：

```text
data/job_store.json
```

相关脚本：

```powershell
node .\src\store\job_store_update.js upsert .\outputs\boss_stage3_fit_evaluated_xxx.json .\outputs\liepin_stage3_fit_evaluated_xxx.json
node .\src\store\job_store_update.js refresh .\outputs\boss_stage4_tracked_xxx.json .\outputs\liepin_stage4_tracked_xxx.json
node .\src\store\job_store_update.js snapshot
```

长期岗位库会记录：

- 职位是否开放：`job_status` / `is_open`
- 职位关闭时间：`closed_at` / `closed_date`
- 是否已推送和推送内容：`is_pushed`、`pushed_today`、`today_pushed_info_json`、`pushed_history_json`
- 是否在聊：`is_chatting`、`chat_status`、`chatting_note`
- 数据变动时间：`data_updated_at`
- 岗位内容变动时间：`job_content_updated_at`
- 职位刷新时间或活跃日期是否变化：`refresh_time_changed`、`latest_active_date_changed`

当前开放状态刷新采用保守策略：如果历史开放岗位没有在当天刷新结果中出现，先标记为 `unknown`；连续缺失达到 `JOB_CLOSE_AFTER_MISSING_DAYS` 后才标记为 `closed`。默认阈值是 7 天，避免因为搜索排序波动误判岗位关闭。

## 策略文件

- 搜索策略：`config/search_strategy.json`
- 匹配规则摘要：`config/profile_rules.json`
- 简历画像模板：`docs/candidate_profile.template.md`
- 当前候选人画像：`config/candidate_profiles/current.json`
- 字段说明：`docs/field_dictionary.md`

当前搜索策略分三层：

- 岗位信息：直接搜 AI 项目经理、AI 产品经理等岗位名。
- 经历关键词：用 Agent、智能体、大模型、项目管理等经历组合。
- 宽泛词：AI、人工智能、大模型、项目等，用于发现遗漏机会。

启用 AI 后，关键词优化不仅读取候选人画像和静态策略，还会读取最近历史产物中的关键词效果；AI 不可用或返回格式不合格时，仍回退 `config/search_strategy.json`。

## 注意

- 只做搜索、读取、记录、评价和报告，不自动沟通、不投递、不收藏。
- BOSS 有风控，建议每日总量先控制在 50 条左右。
- 猎聘第一版采集以页面 DOM 列表卡片为主，字段和 BOSS 分开保存，再在评价阶段映射到统一打分字段。
- 为避免页面跳转后出现 `about:blank` 干扰，猎聘详情补采默认关闭；需要单独验证详情页稳定性时再设置 `LIEPIN_ENABLE_DETAIL=true`。
- BOSS/猎聘当前采集仍以搜索结果第一页为主；BOSS 的页面滚动用于定位当前页详情，不等于跨页轮换。后续如要避免通用关键词长期只看到第一页，应增加低频、可配置、带风控降频的页码轮换策略。
- 采集失败或部分成功的告警会写明含义、保存记录数、失败关键词、平台错误、影响和建议动作；原始诊断仍保存在 `logs/daily_workflow.log`。
