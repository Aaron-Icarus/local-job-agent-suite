# 自动化测试说明

这个目录用于分享包的安全离线烟测，不需要真实 BOSS/猎聘登录、不需要飞书群、不需要 AI Key，也不会修改分享包本体。

测试会临时复制一份完整项目到系统临时目录，在临时副本里套用虚构候选人画像和虚构岗位数据，然后验证以下链路：

1. 空包未配置时，preflight 会中文报错并退出。
2. 消息平台回归测试通过，且不会真实发送飞书消息。
3. 使用“上海软件开发方向”的虚构候选人画像后，preflight 可以通过。
4. 搜索关键词策略可以读取软件开发测试词表。
5. 虚构岗位可以完成评分、入库、岗位编号和日报草稿生成。
6. AI 使用规则模式，不调用 Codex runtime，也不调用 OpenAI/API。
7. 定时发送缺省为草稿、计划任务有独立晚间触发器；岗位缺失薪资/活跃字段时按“未知”评分；BOSS 列表模式能产生“需确认详情”的候选；零岗位日报会说明原因。

运行方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\自动化测试\run_offline_smoke.ps1'"
```

如果需要保留临时副本用于排查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\自动化测试\run_offline_smoke.ps1' -KeepTemp"
```

说明：上面的 `<分享包实际安装目录>` 是静态文档占位符。需要复制即用的真实命令，请打开 `快捷启动/页面UI/index.html`，页面会按当前安装位置自动生成。

说明：当前主项目评分器仍偏“AI 项目/产品/交付/PMO”模板；这里的上海软件开发候选人和岗位数据主要用于验证配置替换与离线链路。若要把产品正式用于纯软件研发岗位筛选，需要继续调整 `recruitment-agent/src/evaluate/evaluate_job_fit.js` 中的权重、标题识别词和关注等级规则。
