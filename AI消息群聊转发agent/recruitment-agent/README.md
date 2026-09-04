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
- 19:00-21:00：如果距离上次成功采集已经超过 2 小时，则再执行一次。
- 其他时间：不执行采集。
- 如果电脑当时没开，就自然跳过该时间段，不补跑。

触发命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\run_daily_job_agent.ps1 -Scheduled
```

上午和下午时段只做：登录态预检 -> 搜索岗位。

19:00-21:00 时段做当天汇总推送：

- 如果距离上次成功搜索已满 2 小时：先搜索岗位，再后处理 -> 适配度评价 -> 生成草稿 -> 按 `SCHEDULE_SEND_MODE` 推送。
- 如果距离上次成功搜索不足 2 小时：直接用当天已有岗位数据做后处理 -> 适配度评价 -> 生成草稿 -> 按 `SCHEDULE_SEND_MODE` 推送。

评价之后会先写入长期岗位库并生成 `outputs/*_stage4_tracked_*.csv/json`；推送完成后会把本次真实送达的岗位写入推送历史，再刷新历史开放岗位状态。当天新录入的岗位不会参与关闭判断。

当前报告标题为“日期 + 渠道 + 岗位搜索汇总”。正文保留序号、岗位编号、岗位简要信息、一句话匹配点、推荐打招呼话术和链接。`REPORT_SPLIT_BY_PLATFORM=true` 时，BOSS 和猎聘会分别生成、分别推送。

岗位编号由 `data/job_display_index.json` 持久化维护：

- BOSS 默认使用 `A001...`
- 猎聘默认使用 `B001...`
- 跨渠道或跨时间出现同公司、同岗位名且 JD 相似度达到阈值的近似岗位，会使用主岗位编号加后缀，例如 `A032-b1`。
- 近似重复岗位仍按原渠道正常推送，但排序靠后；如果对标岗位之前已经在报告中推荐过，会额外提示。
- 相似度阈值和比较窗口可用 `SIMILAR_JOB_THRESHOLD`、`SIMILAR_JOB_WINDOW_DAYS` 调整，默认分别为 `0.8` 和 `45` 天。

打招呼话术默认使用本地规则生成，不调用外部 AI。需要 AI 生成时可配置：

- `GREETING_MODE=rules`：默认值，只用本地规则。
- `GREETING_MODE=auto`：配置了 `GREETING_OPENAI_API_KEY` 或 `OPENAI_API_KEY` 时调用 AI；否则自动回落本地规则。
- `GREETING_MODE=ai`：优先调用 AI；如果 `GREETING_AI_FALLBACK=true`，失败时回落本地规则。
- `GREETING_OPENAI_MODEL`、`GREETING_OPENAI_BASE_URL`、`GREETING_MAX_LENGTH`、`GREETING_AI_TIMEOUT_MS` 可分别配置模型、接口地址、长度和超时。

当前推荐人由 `config/candidate_profiles/current.json` 指向一个 Markdown 画像。构建包内仅保留不含个人信息的 `sample_candidate.md`；使用前请替换为自己的可验证经历、求职目标和约束。AI 话术模式会将该画像和单个岗位文本一同发送给模型；日报只会对最终进入推送的岗位生成话术，不会为未推送岗位调用 AI。

更新简历或求职目标时，先把已提取的简历文字、补充信息和预期岗位写入一个文本文件，再执行：

```powershell
npm run candidate-profile -- --input .\candidate_source.txt --id my_candidate
```

该命令需要配置 `PROFILE_OPENAI_API_KEY`、`OPENAI_API_KEY` 或 `GREETING_OPENAI_API_KEY`，会重写对应候选人 Markdown 并将其设为当前推荐人。

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

## 注意

- 只做搜索、读取、记录、评价和报告，不自动沟通、不投递、不收藏。
- BOSS 有风控，建议每日总量先控制在 50 条左右。
- 猎聘第一版采集以页面 DOM 列表卡片为主，字段和 BOSS 分开保存，再在评价阶段映射到统一打分字段。
- 为避免页面跳转后出现 `about:blank` 干扰，猎聘详情补采默认关闭；需要单独验证详情页稳定性时再设置 `LIEPIN_ENABLE_DETAIL=true`。
