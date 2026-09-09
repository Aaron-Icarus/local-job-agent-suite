# 飞书消息发送转发与群聊 Agent 路由平台

可运行代码位于 [`message-platform`](./message-platform)。它负责飞书入站事件、@触发、命令路由、多轮会话、主动推送、三次重试、幂等和发送审计。

`消息平台` 已是按实际职责调整后的正式目录名。招聘岗位采集、评分以及 19:00 日报定时判断并不在这里，而在相邻的 `招聘智能体/recruitment-agent` 中；本项目只发送上游交来的日报/告警，或把群聊请求路由给相应 Agent。

```powershell
# 回归自测
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>\消息平台'; node '.\message-platform\tests\run_tests.js'"

# 启动飞书长连接接收（需已配置本地环境文件）
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>\消息平台'; node '.\message-platform\src\cli\start_feishu_long_connection.js'"

# 从标准输入发送一条主动通知
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>\消息平台'; '{\"text\":\"测试消息\",\"topic\":\"manual_test\",\"idempotency_key\":\"manual-test-001\"}' | node '.\message-platform\src\cli\send_notification.js'"
```

说明：上面的 `<分享包实际安装目录>` 是静态文档占位符。需要复制即用的真实命令，请打开 `快捷启动/页面UI/index.html`，页面会按当前安装位置自动生成。

消息平台只通过招聘 Agent 接口处理岗位话术，不读取招聘项目内部岗位 JSON。根目录 `plan.md` 和 `飞书机器人配置与接收格式参考.txt` 保留历史与配置参考。

与招聘 Agent 的边界：

- BOSS/猎聘采集、19:00-21:00 日报补跑、搜索关键词优化、岗位评分和可读告警内容均由 `../招聘智能体/recruitment-agent/` 负责。
- 本项目负责把招聘 Agent 交来的主动通知可靠发送到飞书，包括凭据校验、幂等、重试和发送审计。
- 如果告警内容显示 BOSS 登录态、安全验证或平台风控，需要到招聘 Agent 侧处理登录/采集；消息平台只记录是否送达。
