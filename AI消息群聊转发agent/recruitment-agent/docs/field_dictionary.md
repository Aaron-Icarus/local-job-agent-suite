# 岗位数据字段说明

当前项目主要输出 `CSV + JSON`：

- CSV：给人看，可直接用 Excel 打开。新生成的 CSV 前三行分别是：中文字段名、英文字段名、中文解释。
- JSON：给程序看，保留完整结构，便于去重、追踪关键词命中、重新评价和生成推送。

## 采集层字段

| 字段 | 中文名 | 说明 |
| --- | --- | --- |
| platform | 平台 | 岗位来源平台，例如 BOSS直聘或猎聘。 |
| display_id | 岗位编号 | 面向人工引用的短编号，例如 A001、B032、A032-b1；不替代内部去重键。 |
| record_key | 去重键 | 用于判断是否已经记录过同一岗位的稳定键。 |
| search_strategy_type | 搜索策略类型 | 命中岗位时使用的搜索层级，例如岗位信息、经历关键词、宽泛词。 |
| keyword | 搜索关键词 | 首次记录这条岗位时使用的搜索词。 |
| current_search_keyword_group_json | 当前搜索关键词组JSON | 本次搜索词拆分后的词组数组。 |
| used_search_keyword_groups_json | 已用过搜索关键词组JSON | 同一岗位历史上被哪些搜索词组命中过，JSON二维数组。 |
| search_occurrences_json | 搜索出现记录JSON | 同一岗位每次被不同关键词命中的明细。 |
| collected_at | 采集时间 | 程序采集这条记录的时间。 |
| company | 公司 | 公司名称；猎聘匿名猎头岗位可能显示为某类公司。 |
| job_title | 岗位名称 | 岗位标题。 |
| salary | 薪酬 | 页面显示的薪酬文本。 |
| salary_min_k | 薪酬下限K | 从薪酬文本解析出的月薪下限，单位K。 |
| salary_max_k | 薪酬上限K | 从薪酬文本解析出的月薪上限，单位K。 |
| salary_months | 薪资月数 | 从薪酬文本解析出的薪资月数，例如14薪、15薪。 |
| city | 城市 | 当前目标只保留上海。 |
| district | 区县 | 岗位区县，能识别时填写。 |
| address | 工作地址 | 岗位地点文本。 |
| experience | 经验要求 | 页面显示的经验要求。 |
| degree | 学历要求 | 页面显示的学历要求。 |
| job_description | 岗位详细描述 | 详情未补采时使用列表卡片文本兜底。 |
| recruiter_active_text | 招聘方活跃时间文本 | 例如当前在线、3小时前在线。 |
| latest_active_date | 最新活跃日期 | 根据活跃时间文本换算出的日期。 |
| boss_job_url / liepin_job_url | 岗位链接 | 平台岗位链接。 |
| collection_status | 采集状态 | `ok` 表示详情较完整，`page_text_fallback` 表示使用列表卡片文本。 |
| page_card_text | 列表卡片文本 | 列表卡片原始文本，便于人工复核和后续重提取。 |

## 长期岗位库字段

这些字段由 `src/store/job_store_update.js` 维护，主要出现在 `data/job_store.json`、`outputs/job_store_snapshot_*.csv/json` 和 `outputs/*_stage4_tracked_*.csv/json` 中。

| 字段 | 中文名 | 说明 |
| --- | --- | --- |
| job_store_key | 岗位库主键 | 长期岗位库使用的稳定主键；优先使用平台岗位ID。 |
| job_status | 职位状态 | 长期岗位库中的职位状态，例如 `open`、`unknown`、`closed`。 |
| is_open | 职位是否开放 | 面向人工阅读的开放状态：是、否或未知。 |
| closed_at | 职位关闭时间 | 职位被判断为关闭或不可继续跟进的秒级时间。 |
| closed_date | 职位关闭日期 | 职位被判断为关闭或不可继续跟进的日期。 |
| close_reason | 职位关闭/状态原因 | 职位状态变化原因；未刷到但未确认关闭时也会记录说明。 |
| status_checked_at | 状态检查时间 | 最近一次开放状态检查的秒级时间。 |
| status_check_method | 状态检查方式 | 当前主要使用每日刷新结果是否仍出现来判断。 |
| not_seen_refresh_count | 未刷到次数 | 历史开放岗位连续未在每日刷新结果中出现的次数。 |
| missing_since_date | 开始缺失日期 | 历史开放岗位首次未在每日刷新结果中出现的日期。 |
| last_missing_at | 最近缺失时间 | 最近一次未在每日刷新结果中出现的秒级时间。 |
| last_missing_date | 最近缺失日期 | 最近一次未在每日刷新结果中出现的日期；用于避免同一天重复累加未刷到次数。 |
| first_seen_at | 首次发现时间 | 该岗位首次进入长期岗位库的秒级时间。 |
| first_seen_date | 首次发现日期 | 该岗位首次进入长期岗位库的日期。 |
| last_seen_at | 最近发现时间 | 该岗位最近一次在采集或评价结果中出现的秒级时间。 |
| last_seen_date | 最近发现日期 | 该岗位最近一次在采集或评价结果中出现的日期。 |
| data_updated_at | 数据变动时间 | 长期岗位库中该记录任意字段发生变化的秒级时间。 |
| job_content_updated_at | 岗位内容变动时间 | 岗位正文、薪资、地点、活跃时间、评价等核心内容发生变化的秒级时间。 |
| content_hash | 岗位内容哈希 | 用于判断岗位核心内容是否变化的哈希值。 |
| content_changed | 岗位内容是否变动 | 本次入库时岗位核心内容是否相对上次发生变化。 |
| changed_fields_json | 变动字段JSON | 本次检测到变化的字段列表，JSON数组。 |
| refresh_time_changed | 职位刷新时间是否变动 | 平台职位刷新时间字段是否相对上次发生变化。 |
| previous_refresh_time | 上次职位刷新时间 | 职位刷新时间变化前的旧值。 |
| latest_active_date_changed | 活跃日期是否变动 | 招聘方最新活跃日期是否相对上次发生变化。 |
| previous_latest_active_date | 上次活跃日期 | 招聘方活跃日期变化前的旧值。 |
| is_pushed | 是否已推送 | 该岗位是否曾经真实推送成功过。 |
| pushed_today | 今日是否已推送 | 该岗位在评价日期当天是否真实推送成功过。 |
| last_pushed_at | 最近推送时间 | 该岗位最近一次真实推送成功的秒级时间。 |
| last_pushed_date | 最近推送日期 | 该岗位最近一次真实推送成功的日期。 |
| last_pushed_channel | 最近推送渠道 | 该岗位最近一次推送所属渠道，例如 BOSS 或猎聘。 |
| last_pushed_summary | 最近推送摘要 | 最近一次推送时的岗位摘要。 |
| today_pushed_info_json | 今日推送内容JSON | 评价日期当天真实推送的岗位信息明细，JSON数组。 |
| pushed_history_json | 历史推送记录JSON | 该岗位历史推送明细，JSON数组。 |
| is_chatting | 是否在聊 | 人工维护字段，标记是否已在招聘平台沟通中。 |
| chat_status | 沟通状态 | 人工维护字段，例如未沟通、已打招呼、在聊、已结束。 |
| chatting_note | 沟通备注 | 人工维护字段，记录沟通备注。 |

## 后处理字段

| 字段 | 中文名 | 说明 |
| --- | --- | --- |
| screen_priority | 筛选优先级 | 基于薪资、活跃度、岗位类型等规则的初筛结果。 |
| screen_reason | 筛选原因 | 初筛判断原因。 |
| nontechnical_fit | 非技术岗匹配 | 是否符合非技术岗方向。 |
| salary_fit_rechecked | 薪酬复核 | 薪酬是否覆盖目标20-25K区间。 |
| active_days | 距最新活跃天数 | 评价日期与最新活跃日期之间相差的天数。 |
| ai_signal | AI信号 | 是否识别到AI、智能体、大模型等信号。 |
| target_role_signal | 项目/产品/交付信号 | 是否识别到目标角色信号。 |
| semantic_duplicate_key | 语义去重键 | 用公司、岗位、地点生成的语义去重键。 |
| is_semantic_duplicate | 语义重复 | 是否和前面记录形成语义重复。 |
| similar_duplicate | 近似重复 | 是否为跨渠道或跨时间的近似重复岗位；同公司、同岗位名且JD近似时标记。 |
| duplicate_of_display_id | 近似对标编号 | 近似重复岗位对标的主岗位编号。 |
| similar_score | 近似度 | JD文本近似度，当前使用文本分片Jaccard相似度估算。 |
| similar_duplicate_recommended_before | 近似岗位是否已推荐 | 对标近似岗位是否已经在历史报告中推荐过。 |

## 评价字段

| 字段 | 中文名 | 说明 |
| --- | --- | --- |
| evaluation_date | 评价日期 | 本次适配度评价日期。 |
| overall_fit_score | 综合适配分 | 岗位与目标方向的综合匹配分。 |
| application_success_score | 投递成功概率分 | 估算投递成功概率评分。 |
| application_success_band | 投递成功概率档位 | 较高、中高、中、偏低、低。 |
| focus_level | 关注级别 | 重点关注、可关注、低优先、暂不考虑等。 |
| application_recommendation | 投递建议 | 对是否投递或如何处理的建议。 |
| evaluation_summary | 评价摘要 | 一句话评价结论。 |
| match_reasons_json | 匹配原因JSON | 主要匹配点列表。 |
| risk_reasons_json | 风险原因JSON | 主要风险点列表。 |
| reevaluation_required | 是否需要重新评价 | 后续是否应因详情缺失、岗位变化等原因重新评价。 |
| greeting_message | 推荐打招呼话术 | 根据岗位JD和候选人优势生成的招聘平台打招呼话术，默认控制在200字以内。 |
| greeting_strategy | 打招呼话术策略 | 生成打招呼话术时采用的侧重点，例如AI交付、产品需求、运营推广等。 |
| greeting_basis | 打招呼话术依据 | 生成打招呼话术使用的岗位和简历匹配依据。 |
