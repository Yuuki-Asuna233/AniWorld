# 开发、配置与部署

[首次部署与 APK](getting-started.md) · [项目首页](../README.md) · [客户端](../apps/client/README.md) · [Agent](../baiyu_agent/README.md)

本文中的 Node 命令在仓库根目录执行。配置项和当前示例值以 [.env.example](../.env.example) 为准，本文解释其作用，避免维护另一份重复的完整参数清单。

## 环境与依赖

服务端要求 Node.js 20.9+、npm；客户端要求 Flutter 3.44.3 和相应平台工具链。

```powershell
npm ci
npm run setup:env
```

`setup:env` 在 Windows / Linux 均可用，会生成私有 `.env` 和独立随机密钥，已有文件时拒绝覆盖。手动配置可参考 `.env.example`。

`npm ci` 按锁文件安装；如果 `package.json` 与锁文件不一致会报错，并且会重建 `node_modules`。有意变更依赖时使用 `npm install 包名`、`npm uninstall 包名` 或 `npm update`，检查并提交对应清单与锁文件变化。安装行为参考 [npm ci 文档](https://docs.npmjs.com/cli/v11/commands/npm-ci/)。

Node 依赖中的 Sharp 用于服务端图像处理，例如头像解码和转换；它不是客户端视频缓冲库。Flutter 使用自身的 pubspec 和本地播放器依赖，不能用 `npm ci` 安装这些依赖。

## 必填配置与访问控制

| 配置 | 用途 |
|---|---|
| `PORT` | 默认 3000 |
| `JWT_SECRET` | 账户令牌签名，独立随机密钥，至少 32 字符 |
| `ACCESS_GATE_ENABLED` | 公开模板为 false；缺省仍开启门禁，兼容旧部署 |
| `ACCESS_GATE_PASSWORD` | 开启门禁时必填；恰好 18 字符，包含大小写、数字、符号 |
| `ACCESS_GATE_SECRET` | 开启门禁时必填，独立随机密钥，至少 32 字符 |
| `ACCESS_GATE_TOKEN_TTL` | 门禁令牌有效期，模板为 30d |
| `TRUST_PROXY` | 明确信任的反向代理 IP 或网段；直接访问时留空 |
| `ANIME_DB_PATH` | 业务数据库持久化路径；留空使用默认目录 |

外层门禁与账户登录分开管理。关闭外层门禁不会关闭账户认证；修改个人数据仍需账户授权。客户端更新、门禁入口及独立播放报告路由有各自挂载和校验方式，不应将“有门禁”理解为所有路由都使用同一认证机制。

`.env`、真实数据库、客户端签名文件和密钥不要提交到仓库。

## 可选服务

| 功能 | 配置 | 不配置时 |
|---|---|---|
| 白羽模型 | `LLM_BASE_URL`、`LLM_MODEL`、按服务要求填写 `LLM_API_KEY` | 基础网站可启动，白羽提示模型未配置 |
| 向量检索 | `EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、按需 API Key | RAG 仍可能使用可用的本地元数据证据，向量能力不可用 |
| 网页检索 | `WEB_SEARCH_PROVIDER`、`TAVILY_API_KEY` | 外部网页检索不可用 |
| 邮箱验证 | `SMTP_HOST/PORT/USER/PASS` | 当前服务端会将验证码写到控制台，不适合作为正式邮件投递方案 |
| 弹幕服务 | `DANDANAPI_APPID/KEY` | 依赖该服务的弹幕能力不可用 |
| 客户端更新 | `APP_RELEASE_DIR`、`APP_UPDATE_NOTES`、`APP_UPDATE_RELEASE_URL` | 没有有效发布包时不提供相应新版安装包 |

聊天模型接口需要支持原生 `tool_calls`。严格函数 Schema 和强制工具选择分别由 `LLM_TOOL_STRICT`、`LLM_FORCE_TOOL_CHOICE` 控制，仅在网关确实支持时启用。仅声明 OpenAI-compatible 不代表支持所有这些行为。

`LLM_MODEL` 填供应商实际接受的模型名，本文不固定生产模型。Embedding 和聊天模型是两条独立配置。

## 客户端播放源

公开版内置 AGE、DM84、enlie 三种规则，客户端直接查询对应站点并解析媒体。服务器不配置这些规则的播放账号；目录和详情使用 AniList / OIAPI 等元数据，与客户端源的收录和线路状态分别管理。已移除内置播放桥接，旧播放接口返回明确的移除提示。网页主要用于目录、账户和白羽，实际播放入口以 Android / Windows 客户端为准。

## 元数据同步与数据库

启动 API：

```powershell
npm start
```

启动时初始化数据库和标题 FTS，60 秒后启动后台同步，此后默认每 12 小时同步。首次部署不附带完整番剧库。

需要独立同步时，**先停止 API 和所有持有相同数据库的进程**：

```powershell
npm run sync
```

其他入口：

| 命令 | 用途 |
|---|---|
| `npm run sync-full` | 从 2010 年起全量同步，耗时与上游可达性相关 |
| `npm run sync-oi` | 补充缺失的 OIAPI 信息 |
| `npm run rag:status` | 离线查看当前索引状态，同样会初始化数据库 |

脚本通过统一环境加载器读取根 `.env`。完成脚本后再启动 API。服务使用内存中的 `sql.js` 数据快照，独立进程不能同时写同一个文件；文件锁是所有权保护，不应为了强行运行脚本而删除。

备份、独立 RAG 存储和恢复规则见 [运行数据说明](../data/runtime/README.md)。

## RAG 配置与索引

Embedding 服务需要兼容 `/embeddings`。常用模型是 BGE-M3，具体名称由服务商决定：`BAAI/bge-m3` 与 `bge-m3` 不能在本项目里随意互换，因为模型名同时用于查找已存索引。

先确认：

1. 请求使用的模型名能被供应商接受，并与目标索引标识一致。
2. 查询和文档向量来自兼容的模型、维度及前缀设置。
3. `EMBEDDING_DIMENSIONS=0` 表示使用模型原生维度；其他值还要求供应商支持对应参数。
4. 更换 Embedding 服务地址、模型实现、维度或前缀时显式核对索引兼容性；不能因为模型名称相同就自动沿用不兼容向量。

API 停止后建索引：

```powershell
npm run rag:index
npm run rag:status
```

首次默认补充可获得的详细资料后生成分块。需要显式重建时使用 `npm run rag:index -- --rebuild`，它会清除当前模型标识的索引，应先备份并确认重建范围。完整选项见 [建索引脚本](../scripts/data/build-rag-index.js)。

索引就绪后可配置 `RAG_AUTO_INDEX=true`，让服务端后台增量处理同步产生的资料。模板默认关闭。混合排序的权重为向量 0.65、关键词 0.25、来源可信度 0.10；明确实体知识查询有独立快捷路径，并非所有请求都执行全量向量扫描。

`ANIME_RAG_SEPARATE_STORE` 默认 false；它涉及显式存储迁移，不是任意切换的性能开关。已经拆分的业务库与配套 `.rag.db` 要一起保留、备份和恢复。

## Agent 预算与诊断

模板为 128,000 Token 的部署容量，并配置压缩高低水位、输出预算、工具预留和安全预留。实际模型与网关可能有更小限制；`LLM_CONTEXT_WINDOW` 应填写实际可用容量，不能只按宣传值提高。调整完整参数前先阅读 [Agent README](../baiyu_agent/README.md)。

| 配置组 | 作用 |
|---|---|
| `AGENT_TIMEOUT_MS`、`AGENT_RUN_TIMEOUT_MS`、`AGENT_TOOL_TIMEOUT_MS` | 单次模型、整轮运行及工具时间边界 |
| `AGENT_MAX_TOOL_ROUNDS/CALLS`、`AGENT_READ_CONCURRENCY` | 循环、调用次数和并发上限 |
| `AGENT_HISTORY_*`、`AGENT_CONTEXT_*` | 近期原文、完整上下文及压缩水位 |
| `AGENT_SUMMARY_*`、`AGENT_MEMORY_*`、`AGENT_RELATED_MEMORY_*` | 摘要、记忆控制和相关证据预算 |
| `AGENT_TOOL_RESULT_TOKEN_BUDGET` | 工具回填长度，大结果通过附件按需读取 |
| `AGENT_BACKGROUND_COMPACTION` | 后台摘要维护 |

管理员页面为 `/admin/agent.html`，账户需列入 `AGENT_ADMIN_USER_IDS` 或 `AGENT_ADMIN_EMAILS`。普通登录不提供跨用户遥测查看权限。

诊断接口 `/api/agent/diagnostics` 需要账户认证及配置的 `AGENT_DIAGNOSTICS_KEY`，请求头为 `x-agent-diagnostics-key`。两种管理入口不要混淆。详见 [可观测性文档](agent-observability.md)。

## 客户端构建与发布

完整步骤见 [客户端 README](../apps/client/README.md)。在仓库根目录执行：

```powershell
npm run app:install
npm run pc:run
```

正式发布示例，版本按实际发布计划替换并递增：

```powershell
npm run app:release -- -Version 2.2.9
npm run pc:release -- -Version 2.2.9
```

发布脚本会同步设置构建版本与 `APP_VERSION`，默认在线准备依赖并发现标准缓存；Android 还校验自己的签名。完整首次签名和构建步骤见 [入门指南](getting-started.md)。Windows 发布包包含完整运行资源。常规 `app:build:android` / `pc:build:windows` 仅调用 Flutter 构建，不等价于完整发布流程。

将 APK / ZIP 上传到服务端 `APP_RELEASE_DIR`，默认 `data/releases`；保留 `AniWorld_android_版本.apk`、`AniWorld_windows_版本.zip` 命名，再检查对应平台的更新接口。

**服务端部署与客户端发布分开进行。** API、Agent 和网页更新部署服务端；播放器、原生插件和客户端 UI 更新需要重新构建并安装客户端。

## 生产环境部署

使用可写、持久化的数据库和上传目录，保留已有私有配置与数据。部署依赖：

```sh
npm ci --omit=dev
```

进程管理器启动一个 fork 实例。例如已安装 PM2 时：

```sh
pm2 start apps/server/server.js --name aniworld --instances 1 --exec-mode fork
pm2 save
```

后续更新同一个进程，不重复创建实例；如已有进程名称则使用实际名称。源码更新后以原工作目录重启并查看日志，环境变量变更还要确认进程管理器的环境已更新。不要使用 cluster 模式共享当前数据库。

若 Nginx 代理 Node 服务，除常规 `location /` 外，为白羽流式接口设置独立路由。以下片段放在已有 server 块中：

```nginx
location = /api/agent/chat {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 180s;
}
```

前端接收的是 **NDJSON**，不是原样转发模型供应商的 SSE。上游模型、Nginx、CDN 或网关聚合响应，都可能造成一次性展示；代理链每层都应支持及时转发。应用自身也受配置的运行超时限制。

`TRUST_PROXY` 只填写实际受信任的代理地址，例如本机 Nginx 的 loopback 地址；不要为了让客户端 IP 显示正常而无条件信任所有来源。HTTPS、证书和公网入口由部署环境配置。

## 验证与问题反馈

先静态核对配置、路径、npm scripts 和修改范围，再按发布目标完成必要验证。现有回归入口在 [package.json](../package.json) 与 [tests](../tests) 中；运行前阅读相应脚本，确认数据隔离与外部服务需求。回归脚本用于开发验证，不作为生产服务的一部分。

上线后查看启动日志、页面与 API、管理员工具结果状态以及客户端实际播放。基础请求成功不意味着全部源站、所有设备和 Agent 的全部能力都已验证。

提交问题时提供构建版本、平台、步骤与现象；避免上传未经脱敏的配置、账户数据、对话原文和带签名的播放地址。
