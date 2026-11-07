# 招聘信息智能体客户端 PRD v3.1

- 版本：v3.1
- 日期：2026-11-07
- 状态：v1.5.1 已实现；v1.5 增补需求见第 11 节
- 需求来源：`docs/requirements/v1.4_客户端化与多角色_需求说明.md`
- 替代：`docs/prd/招聘信息智能体_PRD_v2.1.md`（v2.1 为 CLI 版本，客户端能力以本 PRD 为准）

---

## 1. 产品概述

### 1.1 一句话

把现有的招聘 CLI 工具升级为 Windows 桌面客户端：常驻托盘、后台采集、任务可恢复、角色独立评分、可视化任务与岗位库、Excel 导出、AI 供应商可配置。

### 1.2 目标用户

- 同一台 Windows 电脑上，一位求职者管理最多 3 个求职角色；
- 使用 BOSS、猎聘两个渠道；
- 需要长时间后台运行，但不想被采集打扰；
- 需要知道采集是否卡住、登录是否失效、是否触发风控；
- 需要按角色看岗位、评分、日报。

### 1.3 产品边界

- 不自动投递、不自动聊天、不破解验证码；
- 不打包 Chrome，不把 Chrome 嵌入客户端窗口；
- 单机单用户，不做多 Windows 用户隔离；
- 每平台只保留一个当前登录账号；
- 最多 3 个角色。

---

## 2. 信息架构

```text
主窗口
├─ 首页 / 运行状态
├─ 角色
│   ├─ 角色列表
│   ├─ 新建角色（简历 → AI 画像 → 目标/要求 → 对话调整）
│   └─ 角色详情（确认/启动/暂停/复制/软删除）
├─ 任务
│   ├─ 今日关键词（按角色，最多 6 个）
│   ├─ 渠道状态（BOSS/猎聘，点击登录）
│   ├─ 执行中任务 / 子任务 / 关键词
│   └─ 历史任务 / 日志
├─ 职位库
│   ├─ 岗位列表（按角色评分）
│   ├─ 岗位详情
│   └─ 导出 Excel
├─ AI 能力
│   ├─ 供应商列表/排序
│   ├─ Key/模型/Base URL
│   └─ 测试/启用/删除/逐级重试
├─ 日报
│   ├─ 飞书群机器人配置
│   ├─ 角色通知通道
│   └─ 日报日志（2 周）
└─ 设置
    ├─ 采集设置
    ├─ 录入/日报设置
    ├─ 空闲策略
    ├─ 登录检查
    └─ 浏览器/账号
```

---

## 3. 核心用户流程

### 3.1 首次启动

1. 安装客户端，检测 Chrome；
2. 打开软件，进入首页；
3. 检查 BOSS/猎聘登录状态，红灯提示登录；
4. 配置 AI 供应商（可跳过，走规则兜底）；
5. 新建角色：上传简历 → AI 生成画像 → 目标/要求 → 确认；
6. 配置采集/日报/飞书；
7. 启动角色任务。

### 3.2 新建角色

```text
角色列表 → 新建
  → 输入昵称/编号（自动）
  → 上传或粘贴简历
  → AI 识别 → 生成 profile.md
  → 填写目标岗位、城市、薪资、特殊要求
  → AI 对话调整（可多轮）
  → 确认
      → 本地相似度 + AI 相似度
      → 高重合：提示，允许取消/仍然确认
  → 待启动
  → 首次启动 → 运行中，锁定
```

### 3.3 每日运行

```text
启动软件
  → 检查登录（两个渠道）
  → 启动调度器
  → 采集窗口内按空闲/间隔/次数执行采集
  → 采集写 raw，登记入库队列
  → 入库 worker 随时处理 pending raw（低优先级）
  → R-2h：0 次/勾选时兜底采集
  → R-1h：停止采集，入库、评分、生成日报
  → R：发送飞书日报
```

### 3.4 登录/风控/卡住

```text
登录失效 → 红灯 + Toast + 托盘 + 飞书
风控/验证码 → 暂停该平台 + 通知 + 等人工
任务 5 分钟无心跳 → 通知；不自动重启 Chrome
子任务 3 次新标签重试失败 → 跳过；同平台第二个也失败 → 切平台
```

### 3.5 导出

```text
职位库 → 选角色 → 筛选 → 导出 Excel
  → 默认下载文件夹
  → 链接可点
```

---

## 4. 功能规格

### 4.1 角色

#### 4.1.1 列表

字段：编号、昵称、状态、创建时间、最近修改、首次启动、渠道、关键词数、已评分数、日报通道。

操作：新建、查看、编辑（锁定前）、确认、启动、暂停、复制、软删除。

#### 4.1.2 状态机

```text
pending_confirm --确认--> pending_start --首次启动--> running
      ^                         |                         |
      |                         | 修改                    | 暂停/继续
      +-------------------------+                         v
                                                     paused
```

- `pending_confirm`：可编辑、AI 对话；
- `pending_start`：已确认未启动，可编辑；修改后回 `pending_confirm` 重新确认（建议）；
- `running`：首次启动后锁定；
- `paused`：锁定，可继续；
- `has_started=true` 后不可修改。

#### 4.1.3 确认校验

- 本地相似度：画像文本/关键词/目标岗位指纹；
- AI 相似度：比较已有角色；
- 高重合提示，允许仍然确认；
- 最多 3 个活跃角色；软删除不占名额需要产品确认。

#### 4.1.4 角色字段

`role_uuid`、`role_number`、`nickname`、`status`、`profile_md`、`resume_source`、`target_roles`、`target_city`、`target_salary`、`special_requirements`、`keywords`、`channels`、`collection_weight`、`ai_provider_id`、`report_channel_id`、`created_at`、`updated_at`、`confirmed_at`、`modified_at`、`first_started_at`、`has_started`、`deleted_at`。

### 4.2 任务与关键词

#### 4.2.1 今日关键词

- 每天一次 AI 生成/更新；
- 每角色最多 6 个；
- 展示：角色、关键词、渠道、优先级、今日是否执行、历史成功率；
- 人工添加/删除/调整执行数量（1–6）；
- 默认执行 2 个，可调为 6 个；
- AI 失败时用历史关键词 + 静态规则兜底。

#### 4.2.2 任务结构

```text
collection_event
  ├─ collection_subtask（platform × role，最多 6）
  │    ├─ keyword_task
  │    └─ account snapshot（当前平台账号）
  └─ event log
```

#### 4.2.3 状态

```text
queued → running → success / partial_success / failed
              ├→ paused → running
              ├→ retrying → running
              └→ canceled
```

- 子任务独立状态；
- 事件执行即计数；成功/失败单独统计；
- 失败子任务窗口内重试，单子任务短时间最多 3 次；
- 子任务新标签重试 3 次（等待 1 分钟/次）；
- 5 分钟无心跳只通知，不自动重启 Chrome；
- 同平台第二个子任务卡住 → 切另一个平台；
- 任务完成/全部关闭 → 关闭 Chrome。

#### 4.2.4 人工操作

- 暂停单个子任务/整体事件；
- 继续；
- 重试单个子任务/整体；
- 强制关闭（关闭标签页）；
- 显示浏览器。

### 4.3 调度

#### 4.3.1 配置

| 配置 | 默认 | 校验 |
| --- | --- | --- |
| 采集周期 | 工作日 | 全天/工作日/指定周几 |
| 采集时段 | 09:00–18:00 | 可全天；需容纳最低次数 |
| 最低采集次数 | 2 | ≥1 |
| 最小间隔 | 3h | ≥1h；<1h 弹窗改 1h |
| 每小时上限 | 1 | 固定 |
| 日报窗口 | 19:00–22:00 | — |
| 日报时间 | 21:00 | 窗口内 |
| R-2h 例外采集 | 开 | 0 次或勾选 |
| 录入时再采集 | 关 | 勾选后 R-2h 尝试 |
| 空闲分钟 | 5 | — |
| CPU 上限 | 30% | — |
| 电量下限 | 30% | — |
| 登录检查 | 12h | 启动 + 12h + 唤醒补检 |
| 最多角色 | 3 | — |

#### 4.3.2 时间线

```text
09:00 采集窗口开始
12:30 若 executed_count=0，强制一次
窗口结束前 若 executed_count<min_runs，补采
18:00 采集窗口结束
19:00 R-2h：0 次/勾选时兜底采集
20:00 R-1h：立即停止采集，入库/评分/日报
21:00 R：发送日报
```

- 强制采集只绕过空闲，不绕过 1 小时间隔；
- R-1h 不等待采集；
- 采集窗口可 4h，窗口内可多次事件，事件间守 1h；
- 时间不足优先入库/评分/日报。

### 4.4 采集与浏览器

- Electron 不打包 Chrome；检测安装；
- 启动参数：独立 Profile、CDP 端口、`--start-minimized`；
- 可显示/隐藏/最小化；
- 不嵌入窗口；
- 监控 PID、端口、任务心跳；
- 登录检查 12h；
- 渠道状态红绿灯，点击打开登录；
- 风控暂停、通知、人工处理；
- 不自动重启 Chrome。

### 4.5 入库

```text
raw_files: pending → processing → done/failed/archived
```

- 扫描所有 pending/failed，不只当天；
- 按 collected_at 旧→新；
- 平台 ID + 完整 JD 才入库；
- upsert、全局编号；
- collected_at / first_seen / last_seen / ingested_at；
- 归档/保留策略；
- 再次看到老岗位更新状态/时间，关闭→open 重新评分。

### 4.6 岗位与评分

#### 4.6.1 主库

`jobs`：job_uuid、display_id、platform、platform_job_id、url、company、title、salary、city、district、jd、source_account_id、collected_at、first_seen_at/date、last_seen_at/date、ingested_at、content_hash、facts_updated_at、job_status、status_updated_at、closed_at、reopen_count、duplicate_of、duplicate_status、long_lived_days。

#### 4.6.2 角色库

`role_jobs`：role_uuid、job_uuid、job_display_id、job_status、duplicate_status、status_updated_at、job_updated_at、score_id、score、score_time、score_explanation、reasons/risks、note、greeting_status、score_version、candidate_version、needs_score、skip_reason。

#### 4.6.3 评分选择

```text
可操作 = 非重复、非关闭
待评分 = 无评分 OR score_time < role.modified_at
        OR ingested_at > role.modified_at
        OR needs_score
排序 = job_updated_at 新→旧，新入库优先
job_updated_at = max(facts_updated_at, status_updated_at)，不含单纯 last_seen
额度 = 单次最多 100，时间够再处理旧岗位
```

- 主库状态变化先标记 `needs_score`；
- 只有需要发日报的角色重新评分；
- 长期岗位 >30 天提示，不直接跳过；
- 关闭→open 重新进入评分。

### 4.7 AI 能力

- 供应商列表：名称、类型（OpenAI 兼容 / Codex 本地命令）、Base URL/命令、模型、Key、排序、启用、测试、删除；
- 逐级降级：按排序 1→2→3 尝试；前一个失败自动用下一个；全部失败报错；手动重启检测并逐级重试；
- 连接成功绿色；无 AI 走规则兜底；
- Key 加密（DPAPI/凭据管理器），不存明文；
- 角色可覆盖；
- 缓存 key 含角色/规则/候选人版本。

### 4.8 日报

- 飞书群机器人（本期唯一渠道）；
- 角色分配通道；默认运行中角色需要分配；
- 日报日志按天/角色，保留 2 周；
- 生成 21:00 前，发送 21:00；
- 失败重试/通知；
- 内容含岗位、评分、理由、风险、链接。

### 4.9 职位库/Excel

- 角色筛选；
- 字段见需求；
- 默认下载文件夹；
- 超链接；
- 冻结表头/筛选；
- 当前筛选/全部。

### 4.10 设置/托盘/安装

- 托盘：显示、暂停/继续、立即执行、退出；
- 单实例；
- 开机自启可选；
- 关闭窗口到托盘；
- NSIS 安装包，检测 Chrome；
- 崩溃恢复，任务持久化。

---

## 5. 技术架构

```text
Electron main
  ├─ window/tray
  ├─ scheduler + idle monitor
  ├─ Chrome process manager
  ├─ task queue (SQLite)
  ├─ IPC/local API
  └─ secure credential store
Worker process
  ├─ collect (CDP)
  ├─ ingest
  ├─ score
  ├─ report/push
  └─ login_check
Renderer (React/Vite)
  └─ pages
```

- 数据库：SQLite（WAL，单写入队列）；原始响应 JSON 保留；
- 任务/队列/角色/评分/日志入库；
- Worker 与 UI 隔离，避免卡顿；
- Chrome 外置，CDP；
- 密钥 DPAPI；
- 打包 electron-builder/NSIS。

---

## 6. 数据迁移

- 现有 `job_store.json` → `jobs` + 默认角色评分；
- 保留编号；
- 旧 `candidate_facts.json`/`profile_rules.json` → 默认角色；
- 旧 outputs → raw_files 队列（未处理的登记 pending）；
- 旧日报/日志保留只读。

---

## 7. 非功能与安全

- 本地优先，不上传简历/岗位/Key；
- 日志脱敏；
- 任务可恢复；
- 通知可见；
- 资源占用可控；
- 不绕过风控；
- 单机单用户，最多 3 角色；
- 软删除。

---

## 8. 验收

1. 首次启动引导、Chrome 检测；
2. 创建角色、AI 画像、相似度、确认、锁定；
3. 今日关键词生成/人工调整/执行；
4. 6 子任务独立状态、重试、卡住通知；
5. 调度三处强制、R-2h/R-1h；
6. 入库跨天补录、采集时间正确；
7. 主库/角色库分离、评分选择、重新开放；
8. AI 供应商排序/降级/测试；
9. 飞书日报/日志 2 周；
10. Excel 导出/链接；
11. 任务恢复、Chrome 关闭；
12. 离线烟测 + 手动验证。

---

## 9. 版本与里程碑

- v1.4.0：客户端基础 + 队列 + 多角色（本 PRD）
- v1.4.x：稳定性/真实平台回归
- 后续：多账号扩展、更多渠道、自动投递（非目标）

---

## 10. 待确认

- 角色相似度阈值/算法（高重合允许仍然确认）；
- 子任务重试“5/1/1”的具体含义；
- 软删除角色是否占 3 个名额；
- Excel 是否默认当前角色（当前产品选择：按所选角色导出）。

---

## 11. v1.5 增补需求（对话、消息路由、历史岗位确认、日志、跨平台）

### 11.1 信息架构增补

```text
主窗口
├─ 首页
├─ 角色
├─ 任务
├─ 职位库（搜索/筛选/分页/历史岗位确认）
├─ 设置（采集/日报/本地运行日志）
├─ AI 能力
├─ 消息（飞书应用/群配置/通知历史/帮助）
├─ 日报
└─ 对话（放在最后）
```

### 11.2 对话与 ReAct

- 支持 Markdown 简历上传/粘贴；
- 缺少目标岗位、城市、薪资、经历时先追问，不编造；
- 本地 Skill：`skills/resume_profile_skill.md`；
- 画像必须包含：基础信息、职业发展期望、工作经历、能力标签、技能关键词、每日搜索关键词、搜索排除词、风险/需确认；
- 可选 AI Provider；AI 失败回退本地规则；
- 消息 metadata 记录 ReAct 步骤；
- 支持按角色查询岗位编号、岗位 JD/评分/链接、角色日报、生成打招呼；
- 群内 @机器人 使用群绑定的 `reply_role_uuid` 作为回复角色。

### 11.3 飞书消息路由

- 配置 App ID、App Secret、群 Chat ID、Verification Token、Encrypt Key；
- 最多 10 个群；
- 群 × 角色 × 通知节点（登录/异常/日报）为多对多；
- 每个群可设置默认通知群、群回复角色；
- 新角色自动加入默认群（登录/异常/日报全开）；
- 每个群可单独测试，测试消息带时间戳；
- 群内 @机器人 事件进入本地对话；
- 无匹配群时只写本地通知，不外发；
- 配置、测试、默认群、角色绑定均需人工保存确认。

### 11.4 历史岗位确认

- 入口：职位库“历史岗位确认”；
- 筛选：未关闭、最后看到 ≥ 7 天、`last_recheck_at` 为空或超过 24 小时；
- 排序：`last_seen_date` 从远到近；
- 不设每次数量上限；
- 点击后检查是否有其他运行中任务；有则不启动；
- 启动后显示待执行、已完成、百分比，持续刷新；
- 再次点击中断；中断后隐藏数字和进度；
- 完成写通知；
- 每个处理过的岗位更新 `last_recheck_at`（总刷时间）；
- 确认不存在才关闭；无法确认记 unknown，不强行关闭；
- 批次表记录触发/结束时间、总数、已完成、关闭、跳过、状态。

### 11.5 本地日志

- 写入 `data/logs/app.log`；
- JSON 行：时间、级别、操作、说明、数据；
- 默认总上限 5 MB，最多 3 个文件轮转；
- 支持设置页查看和 `GET /api/logs`；
- 日志不得包含 API Key、App Secret 等敏感值。

### 11.6 跨平台与启动器

- Windows：`.cmd` ASCII+CRLF+UTF-8 控制台；`.ps1` UTF-8 BOM；直接启动 Electron；
- macOS：`.command` 可执行；Electron 失败时本地服务+浏览器兜底；
- 启动器失败时显示错误，不静默退出；
- 依赖检查 `npm run doctor`。

### 11.7 安全与隐私

- API Key、App Secret 只存本机加密数据库或 `.env`；
- 不把真实简历、角色画像、求职目标、飞书群 ID、API Key 写入仓库；
- 仓库中的示例数据必须脱敏/虚构；
- 日志不记录密钥和完整个人联系方式。

### 11.8 验收补充

- 对话缺信息追问→补全→画像；
- 群配置保存→测试消息→群列表刷新；
- 群内 @机器人→按群回复角色回答；
- 历史岗位确认：进度、完成、中断、其他任务阻塞；
- `npm run v14:clear-demo` 可清理业务数据并保留设置/AI/飞书群；
- Windows 干净状态双击 `.cmd` 打开窗口；
- 单元测试与离线烟测通过。
