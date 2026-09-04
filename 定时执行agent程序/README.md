# 消息发送转发与智能体调度平台

可运行代码位于 [`message-platform`](./message-platform)。它负责飞书入站事件、@触发、命令路由、多轮会话、主动推送、三次重试、幂等和发送审计。

```powershell
# 回归自测
node .\message-platform\tests\run_tests.js

# 启动飞书长连接接收（需已配置本地环境文件）
node .\message-platform\src\cli\start_feishu_long_connection.js

# 从标准输入发送一条主动通知
'{"text":"测试消息","topic":"manual_test","idempotency_key":"manual-test-001"}' | node .\message-platform\src\cli\send_notification.js
```

消息平台只通过招聘 Agent 接口处理岗位话术，不读取招聘项目内部岗位 JSON。根目录 `plan.md` 和 `飞书机器人配置与接收格式参考.txt` 保留历史与配置参考。
