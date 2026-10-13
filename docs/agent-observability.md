# Agent 可观测性

## 目录职责

```text
apps/server/src/services/agent-telemetry.js  遥测脱敏、运行生命周期和管理员身份判断
apps/server/database.js                       遥测表的写入、聚合和详情查询
apps/server/src/routes/agent-admin.js         管理员只读 API
apps/web/admin/agent.html                     管理页面结构
apps/web/admin/agent.css                      管理页面样式
apps/web/admin/agent.js                       管理页面交互和图表渲染
```

## 数据流

```text
Agent 请求
  -> agent_runs
  -> agent_model_calls
  -> agent_tool_calls
  -> agent_answer_feedback / user_anime_events
  -> /api/admin/agent/overview
  -> /admin/agent.html
```

`agent_runs` 记录一次完整请求，`agent_tool_calls` 记录工具链，用户的回答反馈和推荐行为分别写入反馈表和行为表。工具参数和结果只保存脱敏、截断后的摘要，不保存完整系统提示词、API Key 或原始工具响应。

`agent_model_calls` 记录每一轮模型调用，包括模型名、调用状态、耗时、输入 Token、输出 Token、总 Token 和工具数量。模型供应商返回 usage 时优先使用供应商数据；供应商没有返回 usage 时，系统按字符数做近似估算，并在页面上作为估算值展示。

## 管理员配置

在服务端 `.env` 中配置以下任意一项：

```env
AGENT_ADMIN_USER_IDS=1,2
AGENT_ADMIN_EMAILS=admin@example.com
```

配置后访问 `/admin/agent.html`。管理员接口为 `/api/admin/agent/overview` 和 `/api/admin/agent/runs/:runId`。

## 指标含义

- 成功率、耗时、工具调用量属于运行指标。
- 回答质量来自用户点赞/点踩，不是模型的严格事实准确率。
- 推荐点击率来自推荐曝光和点击，详情、播放、收藏是后续行为信号。
- 如需真正的回答准确率，还应继续增加带标准答案的离线评测集和人工抽检。
