# 消息发送转发与智能体调度平台

这是一个空配置的本地消息桥接工程：接收群内消息、按路由调用 Agent，并通过飞书自建应用发送结果。构建包不含任何真实群、凭据、会话或发送记录；所有渠道默认关闭。

## 首次配置

1. 复制 `.env.example` 为 `.env`，填写你自己的飞书应用凭据和测试群 ID。
2. 在 `channels.config.json` 中把 `allowed_chat_ids` 的示例值替换为自己的群 ID。
3. 在 `routes.config.json` 中替换相同的示例群 ID。
4. 完成飞书应用权限、事件订阅和机器人入群后，才将对应 `enabled` 改为 `true`。
5. 如需岗位话术，先在相邻招聘项目创建自己的候选人画像与岗位索引。

## 目录与命令

- `src/`：渠道、路由、发送与会话逻辑。
- `tests/`：仅使用虚构群聊和示例岗位的回归测试。
- `data/`、`logs/`：首次运行时自动创建的本地状态与日志，不应上传。

```powershell
node .\tests\run_tests.js
node .\src\cli\simulate_event.js .\tests\fixtures\feishu_greeting_event.json --force-enabled --no-send
node .\src\cli\start_feishu_long_connection.js
```

最后一条命令会连接你配置的飞书应用；未完成配置前不要运行。发送侧会使用三次重试、幂等键和本地审计状态；不应把 `.env`、`data/` 或 `logs/` 加入分享包。
