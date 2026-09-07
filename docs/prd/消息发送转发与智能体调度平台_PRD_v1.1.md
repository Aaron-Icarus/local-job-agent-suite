<title>PRD｜多渠道消息发送、转发与 AI 调度智能体平台（v1.0）</title>

# 多渠道消息发送、转发与智能体调度平台 PRD



版本：v1.1（修订稿）  

状态：设计、开发、测试和验收基线  

更新时间：2026-09-03



## 1. 产品定义与范围



本产品是面向多个消息渠道、多个会话和多个独立智能体的公共消息应用。它提供消息接收、标准化、确定性路由、会话管理、任务调度、主动推送、发送状态、审计和本机调用接口。业务智能体负责自己的专业判断、内容生成和隐私判断。



本期首发飞书群聊，兼容本地长连接、服务端回调和服务端长连接。系统支持入站消息，也支持无入站消息的定时日报、任务告警、进度提醒和恢复通知。



不包含个人微信号自动化、自动添加好友、自动投递、自动向招聘方沟通、平台级用户权限体系和由 AI 自主修改配置或执行高风险外部操作。



### 1.1 背景与现有原型问题



现有本地原型已验证飞书长连接、文本回复和规则版岗位话术，但仍存在全局凭据复用、单 source 启动、入站事件无完整幂等、机器人回发 message_id 未统一保存、会话键过粗、发送回执未标准化、真实 Gateway 调用器未接通，以及附件/重试/死信未形成领域模型等问题。本 PRD 保留这些问题作为 M0/M1 的整改基线。



## 2. 产品原则与边界



- 显式命令和会话绑定优先，确保消息不会路由到错误智能体。
- 入站接收与主动推送是独立能力，共享底层发送模块但不互相依赖。
- 业务智能体优先调用本消息应用发送；当消息应用不可用时，业务智能体可按自身 PRD 使用本地发送兜底，并留下完整日志。
- 消息应用不判断业务内容是否涉及候选人隐私，也不替业务智能体做脱敏决策；业务智能体负责其输入、输出与隐私策略。消息应用仍负责渠道凭据、基础传输安全、最小字段日志和附件受控引用。
- AI 在一期不负责跨智能体的最终选路；其主要用途是协助已确定目标智能体判断“新任务还是续接上下文”。显式命令、任务编号和引用关系永远覆盖 AI 判断。
- 当前不建设成员级权限与拒绝逻辑。系统保留未来权限模型字段和扩展点，但一期不以 sender 白名单阻断已启用群中的用户消息。

## 3. 总体架构



```Plain Text
入站：飞书事件/长连接 → 验签、去重、统一消息信封 → 会话绑定与确定性路由
                                                     ↓
                                             Task / Session Manager
                                                     ↓
                                              Agent Gateway
                                                     ↓
                                    ReplyPlan / OutboundNotificationRequest
                                                     ↓
主动：定时任务、业务智能体告警/日报 ───────────────────→ Outbound Messaging Service
                                                     ↓
                             渠道适配器 → 平台回执 → 发送状态、映射、审计、日志
```



| 层 | 负责 | 不负责 |
|-|-|-|
| 渠道适配器 | 收发 API、验签、原始事件解析、渠道能力、凭据解析。 | 业务路由、业务隐私判断、智能体提示词。 |
| 消息核心 | 配置、标准化、任务、会话、发送、幂等、回执、审计和运行状态。 | 业务专业决策、候选人画像判断。 |
| AI 会话辅助 | 在已确定 Agent 范围内判断新建/续接、抽取意图、辅助摘要。 | 覆盖显式命令、跨越绑定、修改渠道配置或执行高风险动作。 |
| 业务智能体 | 处理专业任务、决定其隐私与脱敏、生成结构化结果。 | 持有消息应用渠道密钥或重复实现常规渠道发送。 |



## 4. 统一身份、数据与配置



会话绑定主键为 `(channel_type, credential_profile_id, channel_account_id, tenant_id, conversation_id)`。飞书群的 conversation_id 为 chat_id；机器人显示名只用于识别 @，不能作为路由主键。



| 对象 | 最低字段 |
|-|-|
| CredentialProfile | id、channel_type、secret_ref、runtime_profile_id、enabled。 |
| ChannelAccount | id、credential_profile_id、渠道身份、capabilities、enabled。 |
| ConversationBinding | id、channel_account_id、tenant_id、conversation_id、trigger_policy、default_agent_id、candidate_context_id、session_scope、enabled。 |
| AgentDefinition | id、kind、endpoint_ref、输入输出 Schema、capabilities、privacy_policy_ref、enabled。 |
| RoutePolicy | binding_id、priority、命令/匹配规则、agent_id、会话策略、fallback。 |
| TaskRun / TaskSession | task_run_id、session_id、agent_id、来源、状态、父消息、摘要、TTL、取消状态。 |
| OutboundMessage | outbound_message_id、source_type、request_id、binding_id、会话、内容哈希、状态、平台 message_id、幂等键。 |
| ScheduledDispatch | dispatch_id、producer_run_id、schedule_id、business_cycle_id、draft_ref、binding_id、截止时间、状态。 |



所有入站消息标准化为统一信封：event_id、channel_type、credential_profile_id、channel_account_id、tenant_id、conversation_id、message_id、root_message_id、parent_message_id、sender_id、mentions、message_type、text、attachments、received_at、raw_ref。



附件只传递受控引用和元数据；原始内容是否下载、解析、脱敏或交给某个智能体由目标业务智能体的策略决定。消息应用日志只记录必要元数据、哈希、状态和引用，不记录渠道密钥。



配置采用草稿、校验、发布、回滚版本。生产实例只读取已发布版本；运行中的 TaskRun 使用创建时配置快照。候选人上下文由 ConversationBinding 显式提供，避免群聊调用岗位、话术等智能体时跨候选人读取。



## 5. 入站接收、确定性路由与会话



### 5.1 入站接收



1. 渠道适配器完成平台要求的验签/鉴权。
2. 以 `(channel_account_id, event_id)` 原子创建事件记录和 TaskRun；重复事件只返回已接收，不重复执行或回复。
3. 解析文本、富文本、@、引用关系与附件引用，形成统一信封。
4. 检查 ConversationBinding 是否启用以及触发条件是否满足。
5. 只移除可验证的 @ 占位符、命令前缀与引用噪声；保留原文和清洗文本供审计。
6. 在渠道时限内入队；耗时智能体任务不得阻塞入站确认。

一期不做成员级权限判断或“无权限拒绝”。sender_id 仅用于会话隔离、审计和后续扩展；已启用会话中的消息按触发策略处理。



### 5.2 路由与 AI 会话辅助



固定顺序为：显式 Agent/命令 → 引用机器人回复 → 明确 task/session ID → 绑定级路由规则 → 默认 Agent。显式命令始终确定目标智能体，AI 无权改写。



确定目标智能体后，再决定 session_action：



- 引用机器人消息：准确续接被引用 TaskSession。
- 明确 task/session ID：按编号续接。
- “新任务”或新的业务对象编号：新建 TaskSession。
- 普通自然语言：先用确定性关键词和有限时间窗判断；仍不确定时，AI 仅在当前 Agent 内输出 `new / continue / clarify` 和置信度。

在私聊或单候选人群，可配置“唯一活跃会话 + 续接关键词”策略；多人协作群默认要求引用或任务编号，防止误续接。session_scope 支持 `personal`、`conversation`、`collaborators`，一期默认 personal。



会话摘要由目标智能体或受控摘要器写入，具备最大轮数、字符数、TTL 和关闭条件。用户可通过统一命令取消、重试或继续任务；具体命令格式在绑定配置中发布。低置信度时返回澄清，不猜测执行。



## 6. Agent Gateway 与子 Agent/业务模块协作



Agent Gateway 是公共消息应用调用下游智能体的统一入口，屏蔽本地规则、Codex、CDH、HTTP API 等差异。它统一处理调用认证、超时、取消、限流、结构化输出和日志。



Gateway 输入包括 task_run_id、clean_text、统一消息、会话摘要、附件引用、结构化业务上下文、agent_prompt；输出包括 status、reply_plan、session_update、structured_result、attachments、requires_confirmation 和 error_code。



每个子 Agent 或业务模块必须以 AgentDefinition 注册：标识、调用路径、输入输出 Schema、支持媒体、会话能力、超时、重试安全性、健康状态、隐私策略引用和发送能力。消息应用只负责把已路由的任务及受控上下文交给目标 Agent，并接收结构化结果；不理解其专业业务，也不读取其内部文件或数据库。



子 Agent 可返回回复计划、主动通知请求、会话摘要、结构化结果、附件引用和错误码。常规渠道发送优先通过消息应用的本机接口完成；当消息应用明确不可用且未接受请求时，子 Agent 是否允许本地发送兜底由其自身 PRD 和 AgentDefinition 声明，并须回写本地日志和结果状态。



### 6.1 示例：招聘打招呼话术 Agent



`job_greeting_agent` 是招聘 Agent 所有的一个业务子 Agent。用户可通过显式命令、岗位编号、岗位链接、截图或 OCR 文字触发；消息应用将已绑定候选人上下文和受控输入交给该 Agent。岗位编号解析、链接/OCR 到岗位文字的转换、候选人简历匹配与 100–200 字话术生成均由招聘 Agent 负责；消息应用不直接读取其内部岗位索引文件。



## 7. 主动推送与统一发送模块



### 7.1 主动推送



主动推送独立于入站消息。定时任务或业务智能体可以创建 ScheduledDispatch，用于日报、告警、恢复通知、进度或提问。创建时必须声明 producer_run_id、source_type、binding_id、业务周期、内容/草稿引用、截止时间、purpose 和 idempotency_key。



系统校验目标 binding 已启用、目标渠道具备能力、该业务周期未成功送达相同内容，并应用会话级频率、安静时段和过期策略。定时任务重跑、进程重启或网络重连不能产生重复主动消息。



招聘日报由招聘 Agent 生成草稿和发送请求；消息应用只负责按绑定发送、回执、限频和审计。告警与日报使用不同类型和幂等键。无入站来源时，系统型 TaskRun 或 ScheduledDispatch 是发送的审计根，而非伪造用户消息。



### 7.2 本机快速调用接口



消息应用提供进程内接口和仅绑定 127.0.0.1 的本机 HTTP API：



| 接口 | 用途 |
|-|-|
| `POST /v1/agent-dispatches` | 创建或转交入站/系统型 TaskRun。 |
| `POST /v1/agent-tools/messages/reply` | 回复当前 TaskRun 的来源消息，调用方不可指定 chat_id。 |
| `POST /v1/agent-tools/messages/send` | 主动发送日报、告警、进度或结果，必须声明已授权 binding_id。 |
| `GET /v1/outbound-messages/{id}` | 查询 queued、sent、failed、delivery_uncertain 等状态。 |



请求至少包含 task_run_id 或 dispatch_id、agent_id、node_run_id、message_key、purpose、content、idempotency_key。消息应用使用本地服务令牌认证，不向调用方暴露飞书密钥。



### 7.3 发送与兜底边界



消息应用是业务智能体的默认发送模块。业务智能体调用失败时，应先查询请求状态：若消息应用明确不可用且确认未接受请求，业务智能体可使用自身本地发送适配器兜底；若返回 delivery_uncertain 或已入队，则不得直接重发。



智能体本地兜底须记录主模块错误、兜底原因、目标、内容哈希、幂等键和本地日志位置；主模块不可用首次和恢复时应产生可读告警。消息应用恢复后不自动补发已经由兜底送达的消息。



## 8. Outbound Sender、内容与状态机



Outbound Sender 接收标准化 ReplyPlan 或 OutboundNotificationRequest，字段至少包括 channel_account_id、binding_id、conversation_id、reply_to_message_id、message_type、content、attachments、priority、purpose、task/dispatch 标识、delivery_policy、idempotency_key。



发送前校验渠道能力、会话绑定、媒体大小、链接有效期和安静时段。回复消息默认保留原上下文；主动发送必须来自已授权 binding。超长文本按渠道能力采用卡片、顺序分段或“摘要 + 受控完整内容链接”降级，并以一个逻辑消息组记录。附件 URL 过期时保留任务状态并提供可重新生成受控引用的路径。



```Plain Text
planned → queued → sending → sent
                  ├→ retrying → sending
                  ├→ delivery_uncertain → manual_check
                  ├→ failed → dead_letter
                  ├→ cancelled
                  └→ expired / suppressed
```



`sent` 表示渠道 API 明确接受并返回可用响应，不等同于已读。`delivery_uncertain` 不自动重发。可重试错误默认最多重试 3 次，次数和退避可配置；超过上限进入 `failed_exhausted`/dead_letter，记录“需要替代方式处理”，一期不自动切换其他渠道。人工编辑死信后重发必须创建新 OutboundMessage、内容哈希和幂等键。



系统提供内部幂等和重复抑制，不承诺所有外部渠道在网络中断下的严格 exactly-once 投递。



## 9. 运行、可靠性与日志



运行模式包括 local_long_connection、server_callback、server_long_connection、batch_or_polling。模式变化不得改变统一信封、路由、Gateway、发送接口和审计语义。



本地长连接按已启用 CredentialProfile 分别启动，单渠道账户保持单活锁、自动重连、心跳和休眠/网络变化检测。所有入站、任务、主动推送、发送、失败、重试和兜底具备 request_id、event_id、task_run_id/dispatch_id、outbound_message_id 和日志关联。



每个 Agent、渠道账户和发送模块都维护 `ready / degraded / offline / disabled` 健康状态。管理视图展示运行实例、连接状态、启用群、任务状态、路由理由、主动推送、发送状态、重试、死信、兜底次数、配置版本和最近错误。



## 10. 安全、权限保留与未来扩展



渠道密钥只保存于本地受保护环境或密钥服务；普通配置只引用 secret_ref。日志不保存 app_secret、token 或不必要附件内容。附件跨 Agent 不得复用未授权引用。



一期不实施平台管理员、群运营、终端用户的成员级访问控制，也不因 sender 身份拒绝消息；但 ConversationBinding、sender_id、session_scope、AgentDefinition 的 privacy_policy_ref 和未来 permission_policy 字段必须保留。未来权限启用时，可在不改变消息模型的前提下增加 sender allowlist、角色、配额和审核。



AI 编排、多 Agent 任务图、邮件、企业微信客服和正式权限控制属于后续阶段；上线前必须在沙箱/测试群验证，不直接接入正式群。



## 11. 关键验收



1. 同一机器人绑定两个群时，显式命令始终进入各群配置的目标 Agent，互不串群。
2. 用户引用机器人结果时准确续接；普通消息仅在绑定允许的会话策略下续接，否则澄清。
3. AI 不可用时，显式命令、引用、任务编号和默认 Agent 仍可工作；AI 不得改写目标 Agent。
4. 定时日报和智能体告警无需入站消息即可发送，重复调度仅产生一条逻辑消息组。
5. 消息应用明确不可用时，业务智能体本地兜底发送并写本地日志；delivery_uncertain 时不双发。
6. 同一 event_id 平台重试多次，只创建一个 TaskRun；同一 idempotency_key 仅创建一个 OutboundMessage。
7. 发送失败最多重试 3 次；超过上限记录失败和替代处理需求，不自动切换其他方式。
8. 长日报能按渠道策略以卡片、分段或摘要链接呈现；附件过期后可重新取得受控引用。
9. job_greeting_agent 能接收岗位编号、链接、截图 OCR 或岗位文字，并由招聘 Agent 返回岗位话术草稿；消息应用不读取内部岗位 JSON。

## 12. 实施顺序



M0：凭据隔离、事件幂等、回发 message_id、TaskRun、基础日志。  

M1：Outbound Sender、主动推送、发送状态机、3 次重试、死信和本机调用接口。  

M2：招聘 Agent 与消息应用的岗位查询和发送契约、本地兜底、日报/告警联调。  

M3：AI 会话续接辅助、真实 Gateway 调用器、测试群回归。  

M4：多渠道、权限控制、AI 编排和生产部署演练。



## 13. 保留并扩展的原有详细需求



本章保留 v1.0 的完整产品模块。除本修订稿明确调整的内容（如主动推送独立、AI 一期仅辅助会话、暂不实施成员权限、智能体发送兜底）外，原有约束继续有效。



### 13.1 配置发布、入站与路由细则



CredentialProfile、ChannelAccount、ConversationBinding、AgentDefinition、RoutePolicy、RuntimeProfile 和 SchedulerPolicy 均须具备草稿、校验、发布和回滚版本。校验至少覆盖凭据引用、渠道能力、chat_id 唯一性、默认 Agent、路由优先级、媒体能力与环境隔离。正在运行的任务使用配置快照，新任务原子切换到新版本。



入站重复事件须在 EventStore 和 TaskRunStore 中原子处理，避免“已创建任务但未写去重记录”导致重放。未绑定群或未满足 @/命令触发策略时不调用智能体，并记录触发未命中原因；这属于绑定/触发判断，不属于一期成员权限拒绝。



未来仍保留 `rule_only`、`ai_route`、`ai_orchestrate` 三档能力模型：一期生产采用 rule_only 加 AI 会话辅助；未来 ai_route 才可在受控白名单内建议 Agent，ai_orchestrate 才可生成有限任务图。任何未来 AI 选路不得覆盖显式命令、引用映射、任务编号或绑定边界。



### 13.2 多媒体、附件与人工处理



文本/富文本保留正文、链接、提及和引用元数据；图片仅向声明视觉能力的 Agent 提供短期引用；文件须有类型、大小、来源、扫描、保留期和下载策略；音视频按 Agent 能力决定是否转写。渠道不支持某类媒体时，明确告知用户并保留任务状态，不伪造处理结果。



智能体超时、下游故障、配置错误、发送失败和限流均应有用户可理解的状态提示与管理员可诊断记录。死信操作台可查看脱敏上下文、失败原因、尝试次数和日志引用；可取消、重试或编辑后新建消息重发。一次任务的进度、最终结果、提问和错误分别标记为 `progress`、`final`、`ask_user`、`error`，并指定唯一 final owner，避免多节点刷屏或相互矛盾。



所有入站、任务和出站消息带 origin、task_run_id、agent_id、node_run_id 和 hop_count。系统忽略本账号已发消息与超过最大跳数的回流，防止跨渠道或机器人之间循环。



### 13.3 运行模式、渠道路线图与质量要求



`local_long_connection` 用于本机开发和真实群联调，要求单实例锁、自动重连、心跳及休眠/网络变化检测；`server_callback` 要求验签/解密、快速 ACK 与无状态接收层；`server_long_connection` 要求渠道账户单活选主；`batch_or_polling` 适用于邮件和低频渠道，要求游标、退避、重复检测和线程映射。无论模式如何，核心消息、路由、会话、Gateway、发送和审计接口保持一致。



飞书为正式首发渠道，支持长连接、事件回调、文本、回复指定 message_id，并逐步扩展图片、文件和卡片。邮件通过 Message-ID、In-Reply-To、References 维护会话，需满足反垃圾、退信、收件人许可和附件扫描。企业微信优先验证客服会话；个人微信自动化不进入生产设计。



可靠性要求包括：渠道时限内完成验签、去重和入队；可关联 request_id、event_id、task_run_id 与 outbound_message_id；智能体超时、熔断、队列等待、附件大小、重试次数与频率均配置化；渠道账户和智能体独立维护 ready、degraded、offline、disabled 健康状态。



### 13.4 当前代码差距、分期和风险



P0：按 channel_account_id 解析凭据、事件幂等、OutboundMessage 持久化、平台 message_id 映射、会话键扩展与自动化测试。P1：多 CredentialProfile 运行管理、ReplyPlan/媒体模型、发送退避和死信、真实 Gateway 调用器。P2：AI 会话辅助及其 Schema/健康/熔断；P3：邮件、企业微信客服和多 Agent 编排。



发布阶段保持为：M0 基线稳定；M1 完整消息模块；M2 招聘 Agent 与主动推送/兜底契约；M3 AI 会话辅助和服务器部署演练；M4 多渠道、权限和编排。每阶段都需模拟重复事件、发送不确定、AI 离线、附件失败、循环拦截、主动推送重跑和越界目标。



上线前仍需确认下游 Agent 的真实调用方式、会话/附件能力、并发与成本限制；每个渠道的官方权限、订阅、频率与消息能力；附件白名单、扫描、保留期；以及服务端队列、数据库、密钥服务和可观测性方案。本 PRD 保持产品接口稳定，但不预先锁死具体基础设施选型。



### 13.5 运营与审计



运营视图除运行日志外应包含消息处理漏斗、路由命中率、人工介入率、重复/循环拦截数、发送失败率、平均完成时长、每类 Agent 调用量、成本、主动推送量、兜底发送量和配置版本。新 Agent 或新群必须先在开发/测试环境以 dry-run、模拟发送或测试群验证，再绑定正式 conversation_id。



## 14. 研究参考



Lark Node.js SDK 用于飞书事件分发和长连接接入参考；Chatwoot 用于多渠道会话、消息与附件分层参考；n8n Webhook 用于快速响应与异步工作流解耦参考；Wechaty 仅用于个人微信自动化风险认知，不作为生产依赖。