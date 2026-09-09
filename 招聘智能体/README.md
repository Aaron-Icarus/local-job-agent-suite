# 招聘信息智能体

可运行代码位于 [`recruitment-agent`](./recruitment-agent)。它负责 BOSS/猎聘采集、匹配评分、岗位编号、100–200 字话术、草稿和日报推送；消息接收与统一发送位于相邻的消息平台项目。

常用操作：

```powershell
# 让调度器按当前时段判断是否执行
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>\招聘智能体'; & '.\recruitment-agent\run_daily_job_agent.ps1' -Scheduled"

# 打开可见浏览器，供 BOSS/猎聘单次人工登录或验证
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>\招聘智能体'; & '.\recruitment-agent\tools\open_chrome_cdp_for_login.ps1'"

# 手工跑完整流程；默认以 .env 中 SEND_MODE 决定草稿或发送
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>\招聘智能体'; & '.\recruitment-agent\run_daily_job_agent.ps1'"
```

说明：上面的 `<分享包实际安装目录>` 是静态文档占位符。需要复制即用的真实命令，请打开 `快捷启动/页面UI/index.html`，页面会按当前安装位置自动生成。

分享包首次使用时需要接收者明确同意后自行创建 Windows 计划任务。当前时间配置在 `recruitment-agent/config/schedule_policy.json`，主任务含 14 个独立时间点，另有 21:05 日报缺失 watchdog；不再沿用“09:00 单一起点 + 重复”的任务结构。自动流程不使用历史岗位文件补位；单个平台登录失效时只处理当天其他成功平台的数据并记录部分成功。

2026-09-04 之后的关键行为：

- 采集失败或部分成功告警会用中文说明“发生了什么、保存了多少、失败关键词、影响和建议动作”，不再只输出 `collect ended with partial data`。
- 晚间 19:00-21:00 日报只有 `success` 会封版；`partial_success` / `failed` 会在 21:00 前按默认 30 分钟间隔重试。
- BOSS/猎聘整条任务流通过 `recruitment-agent/config/platform_channels.json` 独立开关；BOSS 详情采集默认开启。
- AI 关键词生成、评分复核和话术均走统一 AI Router；Windows 定时环境如果找不到 `codex`，需要在自己的 `.env` 配置 `CODEX_RUNTIME_BIN` 绝对路径或 `CODEX_RUNTIME_COMMAND`，不要把个人路径提交到仓库。
- 搜索关键词优化会结合候选人画像、静态策略和最近历史关键词效果；空构建包首次运行时没有历史数据，会自动退化为画像+静态策略。当前采集仍以搜索结果第一页为主，跨页/页码轮换属于下一阶段优化项。
