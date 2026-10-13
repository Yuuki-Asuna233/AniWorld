# 白羽 Agent

白羽是 AniWorld 的动漫助手，负责检索、推荐、比较、资料查证、追番操作与记忆管理。它使用模型原生 Tool Calling；当前工具在本地注册执行，未接入 MCP。

[返回项目首页](../README.md) · [配置与部署](../docs/development.md) · [可观测性](../docs/agent-observability.md)

## 请求生命周期

1. 服务端校验请求、账户、会话与待确认操作引用，建立取消和运行超时边界。
2. 内部模型调用 `interpret_memory_request` 理解本轮记忆范围、任务切换与确认／取消语义，生成结构化提案。它不是对模型公开的常规业务工具，也不直接执行修改。
3. 加载可见记忆和原文，检查上下文预算；必要时先压缩，再组装主模型上下文。
4. 模型请求原生工具。运行时验证参数、权限和执行顺序，执行后回填对应的 `tool_call_id`。
5. 信息充分后进入独立最终作答阶段，关闭工具选择，流式发布正文；最终提交会话并发送权威结果。

自然语言意图不由固定句式判断。提案校验、确认 ID、权限、版本和数据格式仍由确定性的代码负责；语义判断与执行许可不是一回事。取消待确认操作的语义解析也需要可用的模型服务，不能保证在模型不可用时完成自然语言取消。

## 上下文组装

[agents/context.js](agents/context.js) 构建消息，[agents/runner.js](agents/runner.js) 补充本轮提案并管理循环：

| 顺序 | 内容 | 策略 |
|---|---|---|
| 1 | 固定系统规则 | 稳定前缀 |
| 2 | Skill 目录 | 只列能力，正文按需加载 |
| 3 | 最新结构化滚动摘要 | 带覆盖水位 |
| 4 | 未被摘要覆盖的近期原文 | 保留用户与助手的真实对话 |
| 5 | 历史缺失提示、会话状态、待确认操作 | 随会话变化 |
| 6 | 用户负向偏好和硬约束 | 必要约束，不作为可选证据丢弃 |
| 7 | 已加载 Skill、相关正向记忆与证据 | 按需提供，部分证据可因预算移除 |
| 8 | 当前日期、页面快照可用性 | 页面正文通过工具读取 |
| 9 | 确认决策与记忆提案 | 仅在本轮有相应内容时提供 |
| 10 | 当前用户消息 | 当前要求优先 |

工具完整定义在独立的 `tools` 字段中发送，按名称排序，和消息一起计算预算。执行过程中追加助手的原生工具调用及对应结果。固定内容尽量靠前，动态内容靠后有助于前缀缓存，但供应商是否命中缓存还取决于其实现，不能保证每轮命中。

页面工具读取的是**发送该消息时的快照**，不是任意时刻的实时页面；页面数据也不是操作授权。当前装配默认不自动检索旧会话证据，模型可通过 `query_context_evidence` 按需读取。

## 记忆与压缩

| 类型 | 用途与边界 |
|---|---|
| 会话原文 | 保存真实用户与助手消息，为历史证据提供来源 |
| 滚动摘要 | 在预算内承接较早对话，记录覆盖到的消息 ID |
| 用户记忆条目 | 正向／负向偏好、约束和事实，支持按 ID 修订、删除 |
| 会话状态 | 当前作品引用、任务状态、展示结果和临时约束 |
| 工具附件 | 保存需要分页读取的证据，受账户、会话和遗忘范围限制 |

[MemoryManager](memory/manager.js) 管理本轮可见范围和控制提案。[interpret.js](memory/interpret.js) 用模型识别语义；`update_memory` 执行已登记提案，不能自行扩大修改范围。任务切换通过 `start_task` 处理，不等于删除长期偏好。追番列表和观看进度由 `get_user_library` 读取真实业务数据，记忆不能代替实时查询。

[compaction.js](memory/compaction.js) 使用“旧结构化摘要 + 本次覆盖的新原文 + 会话状态”重写摘要，并非不断在旧摘要末尾追加。持久化成功才推进水位；失败不能将未摘要的消息标记为已覆盖。后台维护同样使用覆盖目标和记忆版本，避免遗忘后重新引入旧内容。

配置模板的预算为 128,000 Token，高水位 96,000、低水位 64,000，工具预留 12,000、安全预留 4,000；这些不是简单相加后的可用输入。实际输入还需预留输出，并受 `LLM_CONTEXT_WINDOW` 和 `AGENT_CONTEXT_TOKEN_BUDGET` 中较小容量约束。触及高水位或发现原文已因预算移出时尝试压缩，另有后台压缩维护。Token 统计是估算，不能替代供应商计数。

## 工具职责

当前注册 23 个公开工具，登录用户可用全部工具；游客过滤 5 个需要账户的工具，保留 18 个。参数定义见 [schemas.js](tools/schemas.js)，执行契约见 [contracts.js](tools/contracts.js)。

| 类别 | 工具 | 职责 |
|---|---|---|
| 身份与候选 | `resolve_anime`、`search_anime` | 前者确定作品身份并处理歧义；后者返回搜索候选 |
| 站内资料 | `get_anime_detail`、`retrieve_anime_knowledge` | 结构化详情；主题知识与证据检索 |
| 站外资料 | `lookup_external_anime_info`、`web_search_anime_evidence` | 单部作品的外部资料；稳定事实或最新消息的网页证据 |
| 推荐与比较 | `get_user_profile`、`recommend_anime`、`compare_anime` | 读取版本化画像、生成候选推荐、本地批量比较 |
| 日历与片单 | `get_airing_schedule`、`get_my_airing_schedule`、`get_user_library` | 公共日历、个人追番日历、真实追番和观看记录 |
| 页面与记忆读取 | `get_page_context`、`search_memory`、`query_context_evidence` | 页面快照、当前有效记忆、历史原文或工具附件 |
| 业务操作 | `follow_anime`、`unfollow_anime`、`delete_watch_history`、`open_anime_playback` | 追番、取消追番、删除观看记录、派发播放请求 |
| 记忆与任务 | `update_memory`、`start_task` | 执行结构化记忆提案、切换任务状态 |
| 工作流与展示 | `load_skill`、`present_anime_results` | 按需加载流程、选择最终作品卡片 |

工具可以串联，但输出语义不同：搜索候选不等于身份确认，画像不等于片单，记忆不等于历史原文，派发播放请求不等于播放器已经成功加载。

`query_context_evidence` 的搜索历史、读取消息、读取附件三种模式互斥。`compare_anime` 不内置站外调查。`present_anime_results` 是查询类卡片的明确选择入口，业务回执有独立来源。

## Skill

| 名称 | 工作流程 |
|---|---|
| [anime_recommendation](skills/anime_recommendation/SKILL.md) | 多条件推荐、参考作品和偏好约束、筛选与展示 |
| [anime_comparison](skills/anime_comparison/SKILL.md) | 确认作品、选择维度、按需补资料并比较 |
| [anime_research](skills/anime_research/SKILL.md) | 多来源调查、稳定事实与最新消息、证据评估 |

Skill 提供流程指导，不授予权限，也不增加一套重复业务工具。简单查询无需加载 Skill。

## 执行可靠性与输出

[ToolRegistry](tools/registry.js) 校验工具、参数和登录要求；[ToolCallRuntime](tools/call-runtime.js) 管理调用、缓存、重试和轨迹。独立只读工具有界并行，默认并发 3；业务修改、控制、技能加载、展示选择及推荐依赖按契约形成执行边界。

结果区分 success、partial、empty、not_found、needs_input、requires_login、awaiting_confirmation、rejected 和 error。工具返回结果不意味着查到了完整证据。已提交业务操作的回执独立保留，后续生成失败不会重放该操作，也不会把已执行的动作说成未执行。

对前端使用 NDJSON 事件：`progress`、`tool_start`、`tool_result`、`answer_start`、`delta`、`done`。`delta` 追加正文，`done.answer` 替换校准正文，不能再次追加整篇回答。详见 [流式输出说明](../docs/agent-streaming.md)。

## RAG

`retrieve_anime_knowledge` 通过 [rag-service.js](retrieval/rag-service.js) 检索。明确作品 ID 时优先读取对应实体知识；通用检索结合向量、关键词和来源可信度。向量失败时可降级到本地元数据证据；没有选中本地证据时才按条件尝试外部检索，并标记不足、降级或外部错误。

向量模型名也是索引标识。例如 `BAAI/bge-m3` 必须与服务端配置和已存索引一致，不能随意改成 `bge-m3`。建索引和生产运维见 [开发与部署指南](../docs/development.md)。

## 核心目录

- [entry.js](entry.js)：服务端调用入口；[index.js](index.js)：工具注册。
- `agents/`：提示词、上下文、预算、运行循环、进度与展示。
- `core/`、`providers/`：配置、数据边界和模型接入。
- `tools/`、`actions/`、`skills/`：工具契约、业务动作和工作流程。
- `memory/`：会话存储、语义提案、用户记忆、状态和压缩。
- `retrieval/`：知识检索、推荐、Embedding 与网页检索。
- `diagnostics/`、`shared/`：诊断与公共工具。

## 配置入口

完整可配置项以 [环境模板](../.env.example) 为准，流式事件见 [输出说明](../docs/agent-streaming.md)。
