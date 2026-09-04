# 招聘信息智能体

可运行代码位于 [`recruitment-agent`](./recruitment-agent)。它负责 BOSS/猎聘采集、匹配评分、岗位编号、100–200 字话术、草稿和日报推送；消息接收与统一发送位于相邻的消息平台项目。

常用操作：

```powershell
# 让调度器按当前时段判断是否执行
powershell -ExecutionPolicy Bypass -File .\recruitment-agent\run_daily_job_agent.ps1 -Scheduled

# 打开可见浏览器，供 BOSS/猎聘单次人工登录或验证
powershell -ExecutionPolicy Bypass -File .\recruitment-agent\tools\open_chrome_cdp_for_login.ps1

# 手工跑完整流程；默认以 .env 中 SEND_MODE 决定草稿或发送
powershell -ExecutionPolicy Bypass -File .\recruitment-agent\run_daily_job_agent.ps1
```

Windows 任务 `BOSS Job Agent Daily` 已指向该工程。自动流程不使用历史岗位文件补位；BOSS 登录失效时只处理当日成功平台的数据并记录部分成功。
