# 多平台岗位定时 Agent 项目说明

更新时间：2026-09-01

## 1. 项目目标

本项目用于自动辅助找工作：围绕用户简历背景，定时搜索上海地区 AI 相关的项目、产品、交付、PMO 等非技术岗位，记录岗位信息，做匹配度评价，并在每天晚上生成简短推送。

项目只做：

- 搜索岗位
- 记录岗位
- 去重和追踪关键词来源
- 根据简历和求职目标做适配度评价
- 生成草稿和推送

项目不做：

- 不自动投递
- 不自动沟通
- 不自动收藏
- 不绕过平台登录、验证码或风控

## 2. 最初需求摘要

用户目标：

- 找 AI 相关的项目岗或产品岗。
- 地点优先上海，浦东优先级相对低但可考虑。
- 需要非技术岗。
- 目前不优先考虑数据标注。
- 更关注 AI 智能体、Agent、大模型、AI 平台、项目交付、产品化相关岗位。
- 目标薪资约 20K-25K。
- 如果薪资最高值低于 20K，暂不考虑。
- 如果薪资最低值高于 25K，先降级或暂不考虑。
- 最近一周以上不活跃降优先级，超过两周不活跃判断为不太可行，一个月以上不活跃直接不用考虑。

数据记录要求：

- 记录公司、岗位、薪酬、地点、岗位描述、活跃时间、岗位链接、发布人或招聘方信息。
- 记录搜索关键词来源。
- 如果同一岗位在多个关键词里出现，要合并记录关键词来源。
- CSV 需要中文表头，便于 Excel 打开阅读。
- JSON 需要保留结构化数据，便于程序继续处理。

推送要求：

- 每天晚上生成岗位搜索汇总。
- 内容不要太长，只发序号、岗位简要信息、一句话匹配点、岗位链接。
- BOSS 和猎聘按渠道拆开推送，标题带渠道名。

定时要求：

- 电脑开着时执行，不要求关机后补跑。
- 09:00-12:00 上午时段至少执行一次岗位搜索。
- 12:00-19:00 下午时段至少执行一次岗位搜索。
- 19:00-21:00 晚间时段执行汇总推送。
- 晚间如果距离上次成功搜索超过 2 小时，先再搜索一次，再后处理、评价、推送。
- 晚间如果距离上次成功搜索不足 2 小时，直接基于当天已有数据后处理、评价、推送。

## 3. 当前总体方案

当前采用本地 Node.js + PowerShell + Chrome CDP 的方案。

整体链路：

```text
Windows 计划任务
  -> run_daily_job_agent.ps1 -Scheduled
  -> bin/run_daily_job_agent.ps1
  -> tools/ensure_chrome_cdp.ps1
  -> src/main/scheduled_entry.js
  -> src/main/daily_workflow.js
      -> BOSS 分支采集
      -> 猎聘分支采集
      -> 平台分别后处理
      -> 平台分别适配度评价
      -> 按渠道拆分生成草稿
      -> 飞书或邮件推送
```

关键设计：

- BOSS 和猎聘是两个独立采集分支。
- 两个平台各自保存原始表和后处理表。
- 两个平台共享同一套适配度评价脚本。
- 推送阶段按 `platform` 拆成多条消息。
- CSV 面向人工查看，JSON 面向程序处理。
- `.env` 保存真实配置和密钥，`.env.example` 保存模板。
- 根目录 `run_daily_job_agent.ps1` 保留为兼容 wrapper，避免已经注册的 Windows 计划任务失效。

## 4. 当前代码框架结构

```text
定时执行agent程序/
  run_daily_job_agent.ps1
  package.json
  .env
  .env.example
  .gitignore
  README.md
  plan.md

  bin/
    run_daily_job_agent.ps1
    create_windows_task.example.ps1

  src/
    main/
      scheduled_entry.js
      daily_workflow.js

    core/
      load_env.js
      time_utils.js
      field_dictionary.js
      cdp_common.js

    platforms/
      boss/
        boss_batch_collect.js
        check_boss_login_status.js
        postprocess_boss_stage2.js

      liepin/
        liepin_batch_collect.js
        check_liepin_login_status.js
        postprocess_liepin_stage2.js

    evaluate/
      evaluate_job_fit.js

    greeting/
      greeting_recommender.js
      generate_greeting_for_job.js
      job_greeting_agent.js

    push/
      job_push_draft_and_send.js
      send_existing_draft.js
      send_latest_draft_email.ps1

    store/
      job_store.js
      job_store_update.js

  tools/
    ensure_chrome_cdp.ps1
    open_chrome_cdp_for_login.ps1
    open_liepin_cdp_for_login.ps1
    open_liepin_page.js
    close_blank_cdp_tabs.js

  config/
    search_strategy.json
    profile_rules.json

  docs/
    candidate_profile.md
    task_brief_boss_job_search.txt
    boss_search_strategy_v2.md
    field_dictionary.md

  data/
  outputs/
  logs/
  chrome-cdp-profile/
```

## 5. 有效文件说明

### 5.1 日常入口层

| 文件 | 状态 | 作用 |
| --- | --- | --- |
| `run_daily_job_agent.ps1` | 兼容入口 | 根目录 wrapper，转发到 `bin/run_daily_job_agent.ps1`，用于兼容已注册的 Windows 计划任务。 |
| `bin/run_daily_job_agent.ps1` | 主链路必需 | PowerShell 总入口；负责启动 CDP Chrome、进入定时/草稿/发送等模式。 |
| `src/main/scheduled_entry.js` | 主链路必需 | 判断当前时间段是否应该执行：上午、下午、晚间汇总或跳过。维护 `data/schedule_state.json`。 |
| `src/main/daily_workflow.js` | 主链路必需 | 串起完整工作流：登录检查、采集、后处理、评价、生成草稿/推送。 |

### 5.2 平台采集层

| 文件 | 状态 | 作用 |
| --- | --- | --- |
| `src/platforms/boss/boss_batch_collect.js` | BOSS 主采集脚本 | 用已登录的 Chrome CDP 读取 BOSS 搜索列表，并尽量通过自然点击监听详情接口。 |
| `src/platforms/liepin/liepin_batch_collect.js` | 猎聘主采集脚本 | 用已登录的 Chrome CDP 读取猎聘列表卡片；当前详情补采默认关闭，避免跳转到 `about:blank`。 |
| `src/platforms/boss/check_boss_login_status.js` | BOSS 必需辅助 | 采集前检查 BOSS 登录态、安全验证状态和页面状态。 |
| `src/platforms/liepin/check_liepin_login_status.js` | 猎聘必需辅助 | 采集前检查猎聘登录态和页面状态。 |

### 5.3 后处理和评价层

| 文件 | 状态 | 作用 |
| --- | --- | --- |
| `src/platforms/boss/postprocess_boss_stage2.js` | BOSS 后处理必需 | 补充去重、活跃日期、薪资复核、非技术岗初筛、地点优先级、关键词聚合等。 |
| `src/platforms/liepin/postprocess_liepin_stage2.js` | 猎聘后处理必需 | 对猎聘字段做同类后处理，保留猎聘自己的岗位 ID、链接和卡片文本。 |
| `src/evaluate/evaluate_job_fit.js` | 评价必需 | 根据简历画像和目标岗位规则，追加多维度评分、综合分、投递成功概率、关注级别和评价摘要。 |
| `src/greeting/greeting_recommender.js` | 话术推荐必需 | 根据岗位 JD、评价信号和候选人优势生成招聘平台打招呼话术。 |
| `src/greeting/candidate_profile.js` / `build_candidate_profile.js` | 推荐人画像 | 维护当前推荐人 Markdown 画像；可由 AI 从简历文字、补充信息和预期岗位提取并更新。 |
| `src/greeting/generate_greeting_for_job.js` | 对话辅助 | 根据岗位编号生成单条话术，后续可被飞书群聊机器人复用。 |
| `src/greeting/job_greeting_agent.js` | 对话接口 | 接收岗位编号、结构化岗位信息或截图 OCR 文字，回查本地岗位索引并返回统一话术 JSON，供消息转发框架调用。 |
| `src/core/field_dictionary.js` | 表结构必需 | 统一维护字段中文名和字段解释。新生成 CSV 前三行依次为中文名、英文字段名、中文解释。 |

### 5.4 长期岗位库层

| 文件 | 状态 | 作用 |
| --- | --- | --- |
| `src/store/job_store.js` | 岗位库核心 | 维护长期岗位库的主键、upsert、推送记录、开放状态刷新、快照输出。 |
| `src/store/job_store_update.js` | 岗位库命令入口 | 支持 `upsert`、`refresh`、`snapshot`，供每日流程和人工调试调用。 |

### 5.5 推送层

| 文件 | 状态 | 作用 |
| --- | --- | --- |
| `src/push/job_push_draft_and_send.js` | 主推送脚本 | 读取一个或多个评价 JSON，按平台拆分生成草稿，并按配置发送飞书/邮件。维护 `data/push_state.json`。 |
| `src/push/send_latest_draft_email.ps1` | 邮件发送脚本 | 使用 SMTP 配置发送本地草稿。当前邮件默认关闭。 |
| `src/push/send_existing_draft.js` | 手动发送辅助 | 手动发送最新或指定草稿，适合人工检查草稿后再发。不是定时主链路必需。 |

### 5.6 CDP 和登录运维层

| 文件 | 状态 | 作用 |
| --- | --- | --- |
| `tools/ensure_chrome_cdp.ps1` | 运行必需 | 确保项目专用 Chrome profile 以 CDP 调试端口启动。 |
| `src/core/cdp_common.js` | 共享底层库 | 封装 CDP 基础连接、打开页面、执行 JS、读取 JSON 等。 |
| `tools/open_chrome_cdp_for_login.ps1` | 人工登录辅助 | 显示打开项目专用 Chrome，给 BOSS 扫码登录或过安全验证。 |
| `tools/open_liepin_cdp_for_login.ps1` | 人工登录辅助 | 显示打开项目专用 Chrome，给猎聘登录或验证。 |
| `tools/open_liepin_page.js` | 猎聘页面修复辅助 | 找到真实猎聘页、关闭空白页、避免停在 `about:blank`。 |
| `tools/close_blank_cdp_tabs.js` | 临时修复工具 | 手动清理 CDP 中残留的 `about:blank` tab。不是日常主链路。 |

## 6. 运行时数据目录

这些目录不是源码，不应当作为代码结构理解。

| 路径 | 作用 | 备注 |
| --- | --- | --- |
| `chrome-cdp-profile/` | 项目专用 Chrome 登录态和浏览器缓存 | 非代码，不要全文搜索，不要提交。 |
| `outputs/` | 每轮采集、后处理、评价的 CSV/JSON/摘要 | 数据产物，会持续增长。 |
| `data/drafts/` | 每日推送草稿 | 草稿文本和 Markdown。 |
| `data/sent/` | 已发送草稿备份 | 用于追踪发送历史。 |
| `data/push_state.json` | 推送去重状态 | 记录已见岗位、已发草稿哈希、报告历史。 |
| `data/job_display_index.json` | 岗位编号索引 | 维护 A001/B001 等人工短编号、近似重复关系和已推荐状态。 |
| `data/job_store.json` | 长期岗位库 | 记录岗位开放状态、关闭时间、推送历史、在聊状态、内容变动和刷新状态。 |
| `data/schedule_state.json` | 定时执行状态 | 记录上午/下午/晚间是否执行成功。 |
| `logs/` | 运行日志 | 定时入口和每日工作流日志。 |

## 7. 搜索策略

搜索策略文件：`config/search_strategy.json`。

当前三层策略：

- 岗位信息：直接搜 AI 项目经理、AI 产品经理、智能体项目经理、大模型项目经理、AI PMO 等岗位名。
- 经历关键词：用 Agent、智能体、大模型、AI 平台、AIGC、项目管理、项目交付等经历词组合。
- 宽泛词：AI、人工智能、人工智能体、大模型、智能体、Agent、项目经理、项目等，用于发现遗漏机会。

## 8. 数据主键、去重和更新时间

当前每条岗位都有 `record_key`。

当前另有 `display_id` 作为人工引用编号：

- BOSS 默认从 `A001` 自增。
- 猎聘默认从 `B001` 自增。
- 如果跨渠道或跨时间出现同公司、同岗位名且 JD 近似度达到阈值的岗位，视为近似重复岗位，编号使用主岗位编号加后缀，例如 `A032-b1`、`A032-b2`。
- 近似重复岗位仍保留自己的平台、链接和渠道推送逻辑，只是在排序时后置，并在对标岗位曾推荐过时提示。

打招呼话术推荐默认走本地规则，不调用外部 AI。可通过 `GREETING_MODE=rules|auto|ai` 切换。AI 模式读取 `config/candidate_profiles/current.json` 指向的候选人 Markdown，并与单个岗位文本一起调用模型，优先使用最近 3 年、其次最近 5 年的相关经历。日报仅对最终推送岗位调用话术生成：

- `rules`：只用本地规则。
- `auto`：配置 API key 时调用 AI，否则回落规则。
- `ai`：优先调用 AI，失败时按 `GREETING_AI_FALLBACK` 决定是否回落规则。
- AI 调用使用 OpenAI Responses API 形态，可配置 `GREETING_OPENAI_MODEL`、`GREETING_OPENAI_BASE_URL`、`GREETING_MAX_LENGTH` 和超时。

BOSS：

- 优先使用 BOSS 岗位加密 ID。
- 缺失时用公司、岗位、薪资、地址生成兜底键。

猎聘：

- 优先使用猎聘岗位 ID。
- 缺失时用公司、岗位、薪资、地点生成兜底键。

同一岗位被多个关键词搜到时：

- 不重复写多条。
- 聚合到 `used_search_keyword_groups_json`。
- 明细记录到 `search_occurrences_json`。

已有时间字段：

- `collected_at`：采集时间。
- `latest_active_date`：招聘方活跃时间换算日期。
- `active_days`：距最新活跃日期的天数。
- `evaluation_date`：评价日期。
- `data/push_state.json` 中的 `last_seen_at`：推送层最后见到该岗位的时间。

长期岗位库已新增：

- `job_store_key`：长期岗位库主键。
- `job_status` / `is_open`：职位状态和开放状态。
- `closed_at` / `closed_date` / `close_reason`：职位关闭或不可继续跟进的时间与原因。
- `first_seen_at` / `first_seen_date`：首次进入岗位库的时间。
- `last_seen_at` / `last_seen_date`：最近一次在采集/评价结果中出现的时间。
- `data_updated_at`：该岗位库记录任意字段发生变化的秒级时间。
- `job_content_updated_at`：岗位正文、薪资、地点、活跃时间、评价等核心内容变化的秒级时间。
- `content_hash` / `content_changed` / `changed_fields_json`：内容变动判断依据。
- `refresh_time_changed` / `previous_refresh_time`：平台职位刷新时间是否变化。
- `latest_active_date_changed` / `previous_latest_active_date`：招聘方活跃日期是否变化。
- `is_pushed` / `pushed_today` / `last_pushed_at` / `today_pushed_info_json` / `pushed_history_json`：岗位推送状态和推送内容。
- `is_chatting` / `chat_status` / `chatting_note`：人工维护的沟通状态字段。

开放状态刷新采用保守判断：

- 当天新录入岗位不参与关闭判断。
- 历史开放岗位如果当天刷新结果中没出现，先标记为 `unknown`。
- 连续缺失达到 `JOB_CLOSE_AFTER_MISSING_DAYS` 后才标记为 `closed`，默认 7 天。
- 当前关闭判断依据是“每日刷新结果是否仍出现”，不是逐个岗位详情页强校验；这是为了避免 BOSS/猎聘详情页跳转和风控造成误判。

## 9. 输出文件结构

每轮产物大致分三层：

```text
outputs/
  boss_<stage>_jobs_<timestamp>.json
  boss_<stage>_jobs_<timestamp>.csv
  liepin_<stage>_jobs_<timestamp>.json
  liepin_<stage>_jobs_<timestamp>.csv

  boss_stage2_screened_<timestamp>.json
  boss_stage2_screened_<timestamp>.csv
  liepin_stage2_screened_<timestamp>.json
  liepin_stage2_screened_<timestamp>.csv

  boss_stage3_fit_evaluated_<timestamp>.json
  boss_stage3_fit_evaluated_<timestamp>.csv
  liepin_stage3_fit_evaluated_<timestamp>.json
  liepin_stage3_fit_evaluated_<timestamp>.csv

  boss_stage4_tracked_<timestamp>.json
  boss_stage4_tracked_<timestamp>.csv
  liepin_stage4_tracked_<timestamp>.json
  liepin_stage4_tracked_<timestamp>.csv

  job_store_snapshot_<timestamp>.json
  job_store_snapshot_<timestamp>.csv
```

CSV：

- 第 1 行：中文字段名。
- 第 2 行：英文字段名。
- 第 3 行：中文字段解释。

JSON：

- 保留完整结构化记录。
- 后续程序以 JSON 为主要输入。

## 10. 推送结构

当前配置：

```text
REPORT_SPLIT_BY_PLATFORM=true
REPORT_TOP_N=8
SCHEDULE_SEND_MODE=send
EMAIL_SEND_ENABLED=false
```

推送拆分：

- BOSS 单独生成一条：`YYYY-MM-DD BOSS岗位搜索汇总`
- 猎聘单独生成一条：`YYYY-MM-DD 猎聘岗位搜索汇总`

每条推送包含：

- 序号
- 岗位编号
- 平台
- 公司
- 岗位
- 薪资
- 地点
- 活跃时间
- 一句话匹配点
- 推荐打招呼话术
- 岗位短链接

## 11. 当前本机关键开关

当前本机 `.env` 中和流程有关的非密钥开关为：

```text
AUTO_START_CDP=true
CDP_PORT=9222
SEND_MODE=draft
SCHEDULE_SEND_MODE=send
ENABLE_COLLECT=true
ENABLE_LOGIN_CHECK=true
ENABLE_SCREEN=true
ENABLE_EVALUATE=true
ENABLE_PUSH=true
ENABLE_JOB_STORE=true
ENABLE_STATUS_REFRESH=true
ENABLE_BOSS=true
ENABLE_LIEPIN=true
LIEPIN_ENABLE_DETAIL=false
JOB_CLOSE_AFTER_MISSING_DAYS=7
EMAIL_SEND_ENABLED=false
REPORT_SPLIT_BY_PLATFORM=true
```

含义：

- 定时执行时会自动尝试启动项目专用 Chrome CDP。
- 当前 BOSS 和猎聘都启用。
- 猎聘详情页补采关闭，主要采列表卡片，避免 `about:blank` 问题。
- 长期岗位库和推送后开放状态刷新都启用。
- 历史岗位连续 7 天未在刷新结果中出现后，才会标记为 `closed`。
- 晚间定时模式会尝试发送飞书；邮件仍关闭。
- 手动完整运行默认只写草稿，除非显式传 `-Send` 或 `-SendLatestDraft`。

## 12. 当前自动执行顺序

上午和下午时段：

```text
计划任务触发
  -> 根目录 wrapper
  -> bin/run_daily_job_agent.ps1 -Scheduled
  -> tools/ensure_chrome_cdp.ps1
  -> src/main/scheduled_entry.js
  -> 若满足上午/下午执行条件
  -> src/main/daily_workflow.js
     # scheduled_entry.js 通过 ENABLE_COLLECT=true、ENABLE_SCREEN=false、ENABLE_PUSH=false 控制为仅采集
  -> BOSS 登录检查 + 采集
  -> 猎聘登录检查 + 采集
```

晚间 19:00-21:00：

```text
计划任务触发
  -> 判断是否需要补采
  -> 如需要，先执行 BOSS/猎聘采集
  -> BOSS 后处理
  -> 猎聘后处理
  -> BOSS 适配度评价
  -> 猎聘适配度评价
  -> 写入长期岗位库并生成 stage4_tracked 文件
  -> 按平台生成草稿
  -> 按配置飞书推送或只留草稿
  -> 记录真实送达的岗位推送历史
  -> 刷新历史开放岗位状态，当天新岗位不参与关闭判断
```

## 13. 给后续对话的交接说明

后续如果在其他 Codex 对话里追加功能，建议先读取本文件和 `README.md`，再按下面边界动代码：

- 新增平台采集：放在 `src/platforms/<platform>/`，保持“采集 -> 后处理 -> 评价 -> 推送”的结构，不要把新脚本放回根目录。
- 新增跨平台逻辑：优先放在 `src/main/`、`src/core/`、`src/evaluate/` 或 `src/push/`，不要写到某个平台目录里。
- 新增字段：同时更新 `src/core/field_dictionary.js` 和 `docs/field_dictionary.md`。
- 新增搜索策略：优先改 `config/search_strategy.json`，必要时补充 `docs/boss_search_strategy_v2.md`。
- 新增长期状态或数据库：数据放在 `data/`，源码和维护命令放在 `src/store/`。
- 不要修改或清空 `chrome-cdp-profile/`，这里保存项目专用 Chrome 登录态。
- 不要把真实密钥写进文档；`.env` 只在本机保存，`.env.example` 只放模板。
- Windows 计划任务当前可继续调用根目录 `run_daily_job_agent.ps1`，不要删除这个 wrapper。

长期岗位库已经落地。后续如果要增强，可以优先补“逐个岗位详情页/接口强校验”：

```text
data/job_store.json 中仍开放且非当天新岗位
  -> 平台专用状态检查器
  -> 轻量打开/请求岗位链接
  -> 判断 open / closed / security_check / unknown
  -> 回写 job_status、closed_at、status_check_method、data_updated_at
```

## 14. 常用命令

执行完整流程并只生成草稿：

```powershell
powershell -ExecutionPolicy Bypass -File .\run_daily_job_agent.ps1 -DraftOnly
```

执行定时判断：

```powershell
powershell -ExecutionPolicy Bypass -File .\run_daily_job_agent.ps1 -Scheduled
```

检查 BOSS 登录态：

```powershell
node .\src\platforms\boss\check_boss_login_status.js --new
```

检查猎聘登录态：

```powershell
node .\src\platforms\liepin\check_liepin_login_status.js --new
```

打开 BOSS 登录辅助窗口：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\open_chrome_cdp_for_login.ps1
```

打开猎聘登录辅助窗口：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\open_liepin_cdp_for_login.ps1
```

创建或更新 Windows 计划任务示例：

```powershell
powershell -ExecutionPolicy Bypass -File .\bin\create_windows_task.example.ps1
```

默认任务名仍是历史遗留的 `BOSS Job Agent Daily`，但实际执行的是当前多平台流程。保留这个名字是为了兼容已注册任务。

手动维护长期岗位库：

```powershell
node .\src\store\job_store_update.js upsert .\outputs\boss_stage3_fit_evaluated_xxx.json .\outputs\liepin_stage3_fit_evaluated_xxx.json
node .\src\store\job_store_update.js refresh .\outputs\boss_stage4_tracked_xxx.json .\outputs\liepin_stage4_tracked_xxx.json
node .\src\store\job_store_update.js snapshot
```

## 15. 改版记录

### 2026-08-26 初版 BOSS 探测

- 验证 BOSS 页面需要登录和安全验证。
- 通过 Chrome CDP 读取登录态页面。
- 跑通 BOSS 列表搜索、详情监听、CSV/JSON 落盘。
- 建立简历画像和任务说明。

### 2026-08-26 搜索和评价规则

- 增加三层搜索策略：岗位信息、经历关键词、宽泛词。
- 增加关键词来源记录。
- 增加 `latest_active_date` 活跃日期换算。
- 增加去重键 `record_key`。
- 增加适配度评价脚本，输出综合分、成功概率和关注级别。

### 2026-08-26 定时和推送

- 建立 `src/main/daily_workflow.js`。
- 建立 `src/main/scheduled_entry.js`。
- 建立飞书和邮件草稿优先推送流程。
- 注册 Windows 计划任务 `BOSS Job Agent Daily`。

### 2026-08-28 CDP 和登录态加固

- 增加 `tools/ensure_chrome_cdp.ps1`，定时任务可自动启动项目专用 Chrome CDP profile。
- 增加 BOSS 和猎聘登录态检查。
- 修复 scheduled task 失败时退出码不正确的问题。

### 2026-08-28 猎聘分支

- 增加猎聘采集、后处理和评价链路。
- BOSS 和猎聘改为并行平台分支。
- 两个平台各自保存数据，各自评价，最后合并或拆分推送。
- 猎聘详情补采默认关闭，列表卡片为稳定采集源。

### 2026-08-28 字段说明和 Excel 可读性

- 增加 `src/core/field_dictionary.js`。
- 增加 `docs/field_dictionary.md`。
- 新 CSV 改为三行表头：中文名、英文字段、中文解释。

### 2026-08-28 按渠道拆分推送

- 增加 `REPORT_SPLIT_BY_PLATFORM=true`。
- BOSS 和猎聘分开发送。
- 标题带渠道名。
- 缩短岗位链接、公司、岗位、活跃时间，避免飞书单条消息过长。

### 2026-09-01 工程目录整理

- 将根目录散落脚本归档到 `src/`、`bin/`、`tools/`。
- 保留根目录 `run_daily_job_agent.ps1` 作为兼容 wrapper。
- 更新 `package.json`、`README.md` 和本文档中的路径。
- 平台脚本直接运行时也会读取根目录 `.env`。

### 2026-09-02 长期岗位库和推送记录

- 增加 `src/store/job_store.js` 和 `src/store/job_store_update.js`。
- 增加 `data/job_store.json` 长期岗位库，记录岗位开放状态、关闭时间、推送历史、在聊状态和数据变动时间。
- 每日评价后新增 `stage4_tracked` 输出，给岗位记录追加生命周期字段。
- 推送成功后记录每个实际出现在报告里的岗位、推送渠道、推送摘要、推送内容和推送时间。
- 推送后刷新历史开放岗位状态；当天新岗位不参与关闭判断，连续缺失达到 `JOB_CLOSE_AFTER_MISSING_DAYS` 后才标记为关闭。
- 增加 `data_updated_at` 和 `job_content_updated_at`，用于区分记录任意字段变动和岗位核心内容变动。

## 16. 后续建议

下一步最值得补的是平台级强校验状态检查器。当前 `job_store` 已能基于每日刷新结果保守判断 `open` / `unknown` / `closed`，但还没有逐个岗位打开详情页确认“确实已关闭”。如果后续要进一步提高准确性，可以给 BOSS 和猎聘分别增加低频、限速、可中断的详情页状态检查器，并把结果回写到 `data/job_store.json`。

## 2026-09-04 当前执行说明（以本章为准）

本目录当前承载**消息发送转发与智能体调度平台**，可运行工程位于 `message-platform/`；招聘采集和日报编排属于 `../AI消息群聊转发agent/recruitment-agent/`。

- 入站：飞书事件先校验来源群、触发规则，再以 `(channel_account_id, event_id)` 持久化去重；重复事件不重复调用 Agent 或回复。
- 会话：机器人回发的 `message_id` 会写入会话索引，因此用户引用机器人结果可准确续接。显式命令、引用、任务 ID 的优先级高于默认路由。
- 发送：主动推送独立于入站消息，最多三次可重试；成功、失败耗尽和不确定送达均留本地状态。相同幂等键成功后不重复投递。
- 凭据：channel 使用 `credential_profile_id` 和 `credential_env` 映射；当前两个飞书来源可共用默认机器人，后续新增机器人只需新增独立环境变量引用。
- 边界：消息平台只调用招聘 Agent 的本地接口，不再读取其岗位索引 JSON。岗位编号、链接、截图/OCR 和候选人匹配均由招聘 Agent 负责。
- 触发：仅配置机器人 ID/别名或飞书 app 提及才触发；@普通群成员不会唤起 Agent。未知岗位编号返回补充信息提示。
