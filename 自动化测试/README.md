# 自动化测试说明

这个目录用于分享包的安全离线烟测，不需要真实 BOSS/猎聘登录、不需要飞书群、不需要 AI Key，也不会修改分享包本体。

测试会临时复制一份完整项目到系统临时目录，在临时副本里套用虚构候选人画像和虚构岗位数据，然后验证 v1.3 链路：

1. 空包未配置时，preflight 会中文报错并退出。
2. 消息平台回归测试通过，且不会真实发送飞书消息。
3. 使用“上海软件开发方向”的虚构候选人画像后，preflight 可以通过。
4. 采集结果先入库：必须有平台唯一 ID + 完整 JD；列表字段/缺详情的岗位进入待补；编号按渠道分配。
5. 跨渠道同一岗位照常入库、照常占编号，但标记为“重复于更早编号”，不参与推荐。
6. 评分在入库之后：硬条件（销售/城市/薪资等）先过滤，软评分再排序；AI 只能微调，不能推翻硬条件。
7. 关键词按“历史新增 + 久未使用 + 重复/失败”滚动排序；每个词有目标新增/最大页数。
8. 每日账本按“关键词 × 渠道”汇总看到/重复/新增/失败/页数/停止原因。
9. AI 使用规则模式，不调用 Codex runtime，也不调用 OpenAI/API。

运行方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\自动化测试\run_offline_smoke.ps1'"
```

如果需要保留临时副本用于排查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '<分享包实际安装目录>'; & '.\自动化测试\run_offline_smoke.ps1' -KeepTemp"
```

说明：上面的 `<分享包实际安装目录>` 是静态文档占位符。需要复制即用的真实命令，请打开 `快捷启动/页面UI/index.html`，页面会按当前安装位置自动生成。

说明：v1.3 的评分器已经支持 `candidate_facts.json` 和 `scoring_rules.json`；这里的软件开发候选人用于验证“换一套事实卡/权重也能工作”。真实使用前仍需替换 `config/candidate_profiles/` 里的示例画像。
