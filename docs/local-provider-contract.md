# 本机模型连接：实施目标与协议 v1

目标：在云端 NestJS/Vue 写作平台中，用户主动运行本地连接器，发现 Ollama 与 LM Studio，经一次性配对和界面启用后，可实际用于写作与 Agent。仅出站 HTTPS，不开放本机监听端口，不读取 Keychain、OAuth、CLI 登录文件、浏览器数据或自动导入 API 密钥，不执行发现的 CLI。CLI 存在与模型可调用明确区分。RAG/embedding 仍由服务端原配置提供，不宣称完全离线。

## 账号 API（JWT，响应直接对象）

- GET `/api/local-providers`: `{connections:[{id,name,enabled,online,lastSeenAt,providers:[{id,models:[{id,label,tools,contextWindow?,model}]}],detectedClis:[]}],runtimeVersion:1}`。model 是服务端生成的选择值 `local/<connectionUUID>/<ollama|lmstudio>/<encodeURIComponent(modelId)>`。
- POST `/api/local-providers/pairing`，body `{}`：`{code,expiresAt}`。256-bit 一次性随机码，5 分钟有效；创建新码废除本账号旧码。配对缓存内存化，服务重启后失效。
- PUT `/api/local-providers/connections/:id`，body `{enabled:boolean}`；默认禁用，启用表示允许此连接器接收当前账号的作品上下文。返回对应 connection view。
- DELETE `/api/local-providers/connections/:id`：204，撤销令牌、取消排队/在途任务。跨账号均 404。

## Runtime API（与用户 JWT 隔离）

- POST `/api/local-runtime/pair`：`{version:1,code,name,inventory}` → `{connectionId,token}`。token 格式 `<UUID>.<64 hex>`，仅在内存保存，服务端只存 SHA256；每次启动重新配对。
- POST `/api/local-runtime/poll`，Bearer runtime token，body `{inventory?}` → `{job:null|Job}`。连接器约每 2 秒轮询；即使禁用也可心跳，但不接收任务。inventory 至少每 20 秒更新，离线判定 30 秒。
- GET `/api/local-runtime/jobs/:id/status`，同令牌 → `{status:'running'|'cancelled'|'completed'}`。本地生成期间独立每秒检查，取消后 abort 本地 HTTP。
- POST `/api/local-runtime/jobs/:id/events`，同令牌，body `{seq,event}` → `{accepted:true}`。seq 从 1 连续递增；上一事件完全相同的重试幂等，乱序或改写 409。连接器逐事件等待确认，对单次丢失响应最多重试一次；不重试生成本身。

`Inventory = {providers:[{id:'ollama'|'lmstudio',models:[{id:string,label:string,tools:boolean,contextWindow?:number}]}],detectedClis:Array<'claude'|'codex'|'copilot'>}`。最多 2 供应商、每个 20 模型；没有 endpoint 或凭证字段。name 手动指定，默认“我的电脑”，不自动上传 hostname/路径。

`Job = {id,provider:'ollama'|'lmstudio',model:string,messages:ChatMessage[],tools?:LlmToolSpec[],maxTokens:number,temperature:number}`。服务器不提供 URL 或本机命令。模型必须来自连接器最近发现的清单。

`event` 使用项目 `LlmStreamEvent`：`{type:'text',text}`、`{type:'tool_call_delta',index,id?,name?,arguments?}`、`{type:'done',result:{answer,toolCalls?,finishReason,rawFinishReason?,usage?}}`；另允许 `{type:'failure',message}`（仅固定错误描述，不含模型正文、响应体或凭证）。未知/缺失终态不能成功；工具仍由服务端原 Agent 验证后执行，本地连接器不执行工具。

## 固定本机发现与调用边界

- Ollama：只访问 `http://127.0.0.1:11434/api/tags`、`/api/show` 与 `/v1/chat/completions`。show.capabilities 包含 tools 才声明工具支持；从 model_info 中读取可验证的 context_length。发现不发送生成请求。
- LM Studio：只访问 `http://127.0.0.1:1234/v1/models` 和 `/v1/chat/completions`。仅模型列表不能证明工具支持，默认 tools=false。
- 可显式使用 `AI_WRITING_OLLAMA_API_KEY`、`AI_WRITING_LMSTUDIO_API_KEY`；仅发送至对应固定 loopback 服务，绝不传给云端。
- HTTP 不跟重定向；发现和生成均限时、限响应体、限模型数。失败响应不回显原文。收到的 job 不得更改目标 URL，且 model 必须存在于本机发现的清单。
- 只检查已知 CLI 在 PATH 中是否有可执行普通文件，不运行 CLI，不读其配置。
- 云端 API root 必须 HTTPS（仅明确 loopback 开发地址可 HTTP）；拒绝 URL userinfo/query/hash，path 以 `/api` 结束。code 从交互输入或 `AI_WRITING_PAIR_CODE` 提供，不放命令行参数/日志。启动前显示元数据与作品上下文传输说明。

## 运行边界

服务端连接记录持久化，配对码和作品任务仅驻留当前实例内存；v1 明确单实例部署。重启使在途任务失败，客户端须重新请求，不自动重放生成。每连接最多 2 个任务、全实例最多 32 个；任务最多 120 秒；事件队列与输入/输出均有限额。终态后立即清除作品文本，仅短期保留无正文幂等墓碑。断开/禁用/撤销不自动切换云模型。

## 验收

固定端口安全发现、超时/重定向/超大响应、无凭证读取、配对过期/单次消费/跨用户、令牌与 JWT 权限隔离、禁用与撤销、模型伪造、工具能力降级、事件重试去重、队列背压、取消与断线、真实 HTTP 端到端生成、前端配对/启用/选择/删除及陈旧响应。用确定性假服务测试，不消费真实模型额度。
