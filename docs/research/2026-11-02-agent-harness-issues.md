# Agent 链路优化：基于 DSH 与 Pi 源码的 Issue 草稿

调研基线：2026-11-02。本文保留 6 个 issue 的原始问题、固定源码证据和验收范围；用户随后要求依次实现，A–F 已完成代码接入与本地验证，未创建 GitHub issue。

## 实施记录（2026-11-02）

| Issue | 已落地范围 | 验证 |
| --- | --- | --- |
| A | finish reason/usage/attempt 元数据、截断工具拦截、完整/部分/未知用量，失败重试仍保留计数 | 真 socket 解析、合法工具调用遇 length 零执行、重试用量回归 |
| B | 生产 streamEvents 统一文本/工具循环；无工具一轮完成；工具轮文本延迟提交 | 无工具请求次数为 1，跨帧参数/工具轮文本/截断润色端到端回归 |
| C | 完整请求预算、整轮裁旧历史、配对保护、人物/大纲/近期章节/RAG 来源版本范围去重 | 40 项预算测试、来源范围测试与预装记忆集成；无法容纳当前任务时中文拒绝 |
| D | 默认 2、最多 3 个并发安全读取，串行屏障，原序回灌 | 12 项调度测试，包含取消排队与在途收敛 |
| E | 取消传到 StoryMemory/工具/RAG/embedding HTTP；runId/seq/callId 与终态；前端停止生成 | 真 HTTP 断连、检索取消、调用事件配对、切章陈旧响应回归 |
| F | 20 分钟提案、参数绑定摘要、归属重检、事务锁与确认幂等；编辑器 Agent/确认/取消/重试 UI | 41 项提案专项、17 项 Agent 集成；真实页面确认前 0 人物，确认后 1 人物，另一提案取消 |

后端完整回归：24 个文件 / 354 个测试；前端 5 个文件 / 30 个测试，构建与类型检查通过。实际应用冒烟使用本地确定性假上游，不消耗模型额度；不据此宣称真实模型质量、费用或延迟改善。

实现边界：预算采用保守 UTF-8 字节估算，默认窗口 32768，当前阶段不自动摘要；工具轮文本要等完整终态才提交，减少一次请求不等于首字展示一定加快。数据库读取在查询边界检查取消，embedding HTTP 主动取消；取消不撤销已提交事务。旧第三方模型适配器可保留原兼容路径。下文「当前问题」均指调研基线版本，不能作为新实现仍有该问题的证据。

## 研究范围与证据边界

- 本项目版本：[2e7697be7215b7a9ac50ec677386360847be5ba1](https://github.com/tbyang28/ai-writing-assistant/tree/2e7697be7215b7a9ac50ec677386360847be5ba1)。核对了执行器、工具箱、模型适配器、作品记忆、SSE 控制器及执行器测试。
- DSH：[deepseek-ai/deepseek-harness，ce7073d51254c26cd63b22a60835b8f948deb447](https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447)，提交时间 2026-10-29。核对具体实现，不以 README 或第三方介绍推断能力。
- Pi：[badlogic/pi-mono，2c8d1feb147f6b3d97e855da803bfe7b19f3c403](https://github.com/badlogic/pi-mono/tree/2c8d1feb147f6b3d97e855da803bfe7b19f3c403)。读取 `packages/agent/src/agent-loop.ts` 与 `types.ts`。
- 调研时本仓库 open issue 列表为空。未运行外部 harness，也未做真实模型延迟、成本或小说质量基准。下文的性能收益是待验证目标。
- 一次追加的 DSH 源码下载因 GitHub 网络超时中断；预算文件复核成功，其余 DSH 依据来自此前完成的源码阅读。引用全部固定到 commit。

## 建议顺序

| 草稿 | 优先级 | 目标 | 依赖 |
| --- | --- | --- | --- |
| A | P1 | 保留模型终态、拦截截断工具调用并统计用量 | 无 |
| B | P1 | 统一流式工具循环，消除无工具任务的固定额外请求 | A |
| C | P1 | 为完整请求实施上下文预算和资料去重 | A 提供用量观测；可先做估算版 |
| D | P2 | 为独立读取工具引入有限并行和写操作屏障 | E 的取消契约优先；可联合实施 |
| E | P1 | 将取消信号传到检索依赖，补齐运行和调用终态 | 无；B/D 复用此契约 |
| F | P1 | 将写入授权从入口布尔开关改为操作级权限与确认 | 无 |

P1 表示建议优先实施，不代表已发生线上故障。以上工作可以继续使用现有 NestJS 执行器与 SiliconFlow 适配器，不需要引入 DSH/Pi 作为运行时依赖。

---

## Issue A — fix(agent): 保留模型终态和 usage，禁止执行被截断响应中的工具调用

### 当前问题与证据

`LlmResult` 只有 `answer/toolCalls`；`SiliconFlowClient.chat()` 解析消息后丢弃 `finish_reason` 与 usage，流式解析也只输出文本。执行器因此无法区分正常结束与输出达到上限。

当上游返回 `finish_reason=length`，当前执行器仍可能执行其中已经能够通过 JSON 和参数校验的工具调用。无效 JSON 已会被拒绝；问题是缺少对整条模型响应终态的判断，不能把所有截断参数都描述为会执行。

- [本项目响应接口 L43–47](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/llm/llm-client.interface.ts#L43-L47)
- [非流式响应解析 L110–124](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/llm/silicon-flow.client.ts#L110-L124)
- [执行器调用工具 L107–132](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/agent/agent-runtime.service.ts#L107-L132)

### 参考机制

- [Pi：length 终态使整批工具返回失败，不执行 handler，L267–285](https://github.com/badlogic/pi-mono/blob/2c8d1feb147f6b3d97e855da803bfe7b19f3c403/packages/agent/src/agent-loop.ts#L267-L285)。
- [DSH：max-tokens 在提取、执行工具之前结束 step，L574–597](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent-loop/src/agent.ts#L574-L597)。
- [DSH：按 attempt 聚合用量并检查信息完整性，L126–178](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/token-meter/src/turn-usage.ts#L126-L178)。

### 建议改动

1. 内部模型结果保留规范化的结束原因与原始结束原因，以及可选输入、输出、缓存 token 用量。上游缺失字段记为未知。
2. 流式适配器增加内部完成事件，保留最终元数据。兼容当前外部 token/done/[DONE] 协议。
3. length、error、aborted 响应不执行工具。若后续继续发送会话消息，为已有 tool_call 补齐对应错误结果。
4. 每次运行记录请求次数、决策/工具/生成耗时和已知 usage；区分精确报告、部分报告和估算。不要把未知 usage 填成 0，也不直接把 token 数当成账单金额。
5. 截断正文不得无提示地标成完整结果；是否允许用户保留部分正文交由产品层显示明确状态。

### 验收标准

- 模拟 length 响应包含合法写工具 JSON，handler 执行次数为 0。
- 普通完成响应仍可正确调用工具；原有坏参数、未授权、超限配对测试继续通过。
- 非流式与流式均保留结束原因；缺失 usage 时汇总标为不完整。
- 多轮与重试的用量不会重复累计；缺失的 attempt 用量不被伪造。
- 现有普通写作 SSE 契约保持兼容；日志不默认保存作品正文、完整工具结果或密钥。

---

## Issue B — perf(agent): 统一流式文本与工具调用循环，移除无工具任务的固定额外生成请求

### 当前问题与证据

只要允许工具，流式执行都会先调用 `llm.chat()` 做非流式决策。即使第一轮没有工具，也会丢弃其回答，再调用 `chatStream()`。因此无工具的流式任务至少有两次模型请求。

- [执行器决策 L81–100](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/agent/agent-runtime.service.ts#L81-L100)
- [最终生成 L143–159](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/agent/agent-runtime.service.ts#L143-L159)

### 参考机制

[Pi 的每轮流式请求](https://github.com/badlogic/pi-mono/blob/2c8d1feb147f6b3d97e855da803bfe7b19f3c403/packages/agent/src/agent-loop.ts#L390-L465) 同时处理 text 与 toolcall 的增量，完成后由[循环检查工具并决定下一轮](https://github.com/badlogic/pi-mono/blob/2c8d1feb147f6b3d97e855da803bfe7b19f3c403/packages/agent/src/agent-loop.ts#L250-L285)。这提供了统一循环的实现依据。

### 建议改动

1. 扩展内部模型流为 text、tool_call 增量、完成与错误事件；按调用索引/ID 组装多个工具参数。
2. 每轮通过同一流获取模型响应，完整校验参数并检查结束原因后才执行工具；保留 4 轮和每轮 3 次的现有约束。
3. 不调用工具时直接结束本轮并使用其答案，不再额外请求一遍生成。
4. 明确写作正文与过程信息的边界：工具阶段文本不得混入待应用正文。对于可能先输出文本再调用工具的模型，可按轮暂存文本，确认无工具后提交；这会牺牲该轮实时首 token 展示，但仍减少一次请求。
5. 若提供明确的无工具执行策略，可直接透传流；不根据未经验证的关键词规则擅自关闭必要检索。

### 验收标准

- 无工具的流式任务只发起 1 次模型请求，答案只提交一次。
- 多个工具参数跨 SSE 帧、帧中途断开、混合 text/toolcall、length 结束均不会提前执行工具。
- 工具轮文字不会进入润色结果或续写正文。
- 现有 SSE 背压、取消与 tool_call/result 配对约束继续成立。
- 用 A 的指标比较请求数、首个可用正文时间和总耗时；以实测结果报告收益，不预设下降百分比。

---

## Issue C — feat(agent): 统一完整请求的上下文预算，去重预装记忆与工具检索资料

### 当前问题与证据

StoryMemory 按各段字符限制拼装人物、大纲、前文、RAG；运行时继续追加工具结果。显式 Agent 只截取历史条数，未限制每条历史内容长度。当前没有对最终完整请求统一计量，也没有让执行器识别初始记忆已携带哪些资料。

因此“已预装人物后再次 get_characters”是允许发生的重复读取；目前没有基准证明其发生频率或成本。

- [StoryMemory 默认限额](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/story-memory.service.ts#L20-L27)
- [记忆组装与 RAG](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/story-memory.service.ts#L60-L141)
- [Agent 历史消息处理](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/agent/agent.service.ts#L26-L39)

### 参考机制

- [DSH：按模型窗口预留输出预算与 headroom](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/compaction/compaction-basic/src/config.ts#L153-L216)。
- [DSH：先裁剪再重算，仍超限才摘要](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/compaction/compaction-basic/src/index.ts#L315-L370)。
- [DSH：压缩范围保护工具配对](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/compaction/compaction-basic/src/region.ts#L117-L155)，[摘要必须确实缩小](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/compaction/compaction-basic/src/region.ts#L410-L421)。

### 建议改动

1. 每次调用前统一预算 system、用户任务、待处理正文、历史、工具 schema 与工具结果，并预留输出空间。
2. 将作品资料表达为带来源、范围和版本的上下文条目，能够识别相同资料重复注入；保留原始资料与给模型的投影之间的边界。
3. 第一阶段做去重、裁剪旧工具结果和受控拒绝；保护当前修改正文、用户要求、人物关键约束及完整工具交互单元。
4. 当前任务最小必要输入仍超预算时，明确返回超限或要求缩小范围，不静默删改待处理正文。
5. 后续有长对话需求时再增加摘要，校验体积下降，并评估人物关系与时间线遗漏。中文预算需要针对所用模型校准，不照搬 DSH 的 length/4 启发式。

### 验收标准

- 使用小窗口假模型覆盖长历史、较多人物和多轮检索；每次请求都通过统一预算器。
- 工具调用与结果不被拆开；当前待处理正文不会被静默替换为摘要。
- 同版本、相同范围的资料不重复加入；更精确或更新的查询结果不被错误去重。
- 无法满足最小输入预算时可预测地终止，不反复请求已知必然超限的模型。
- 有摘要时覆盖“摘要反而更大”和“摘要失败”的处理；估算与实际 usage 的差异可观测。

---

## Issue D — perf(agent): 独立读取工具有限并行，写工具使用串行屏障

### 当前问题与证据

[当前执行器 L107–133](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/agent/agent-runtime.service.ts#L107-L133) 对每个工具逐个 await。同轮人物、大纲和近期章节的独立读取无法重叠执行。

### 参考机制

- [DSH 工具批处理 L108–218](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/batch.ts#L108-L218)：有上限的调度、exclusive 屏障及有序提交。
- [Pi 调度选择与串行模式](https://github.com/badlogic/pi-mono/blob/2c8d1feb147f6b3d97e855da803bfe7b19f3c403/packages/agent/src/agent-loop.ts#L518-L594)，[并发完成后按原顺序组装结果](https://github.com/badlogic/pi-mono/blob/2c8d1feb147f6b3d97e855da803bfe7b19f3c403/packages/agent/src/agent-loop.ts#L596-L669)。Pi 此处使用 Promise.all；本项目建议额外限制并发数。

### 建议改动

1. 工具元数据显式声明并发安全性，默认串行；授权与调度规则分别维护。
2. 首批只开放已确认独立的人物、大纲、章节目录等读取，并发上限从 2 开始。
3. 写工具以及依赖前序结果的调用形成串行屏障；不把同轮全部调用直接 Promise.all。
4. 校验与授权在执行前完成；结果按原调用顺序回灌，每个 callId 恰好对应一条结果。
5. 保留每轮最多执行 3 次的约束，并考虑 Neon 连接池与向量服务的资源上限。

### 验收标准

- 用可控 Promise 验证两个独立读取确实重叠，最大并发不超配置值。
- 读取→写入→读取不会跨写入屏障；未声明安全性的工具保持串行。
- 乱序完成、单个失败、取消和超过每轮配额时，结果配对和原顺序仍正确。
- 取消后不再启动排队调用，已开始调用按 E 的契约收尾。
- 性能测试使用固定延迟假工具验证调度收益；真实数据库收益另行测量。

---

## Issue E — fix(agent): 将取消信号传入工具与检索依赖，并记录调用终态

### 当前问题与证据

已有 SSE 断开取消和执行器边界检查，但 `tools.execute(name,args,book)` 不接受 signal；`searchSimilar()` 的 embedding 调用也无法接收本次任务的取消信号。因此取消后可阻止后续阶段，已经开始的检索请求仍可能继续。

- [SSE 断开取消](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/ai.controller.ts#L493-L502)
- [工具执行入口](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/agent/story-tools.ts#L167-L195)
- [RAG 向量检索](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/rag/rag.service.ts#L100-L115)
- [embed 接口](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/llm/llm-client.interface.ts#L65-L69)

### 参考机制

- [DSH：执行工具主体时传 signal 并等待 settle](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/pipeline.ts#L243-L285)。
- [DSH：取消后停止派发并等待已开始调用](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/batch.ts#L203-L233)，[未启动调用生成取消结果](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/batch.ts#L271-L279)。
- [DSH 流事件的 attemptId、序号与 committed/abandoned 终态](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent-loop/src/assistant-stream.ts#L37-L109)。这是事件关联的参考，并不表示本项目需要原样复制其协议。

### 建议改动

1. 将执行上下文中的 signal 下传到工具、RAG 查询向量化和上游 HTTP；仅在实际支持的依赖中实施中断。
2. 检查预装 StoryMemory 阶段同样能接收取消，避免只取消 AgentRuntime 之后的工作。
3. 为运行/模型请求/工具调用增加 runId、attemptId、callId 和明确结束原因。同名工具多次调用能够分别关联。
4. 不把工具取消误记为普通业务失败或最终成功。客户端已断开时服务端仍记录结束状态。
5. 写入已提交而后取消的情况返回真实提交状态。Abort 不等于回滚，不对不支持取消的数据库操作承诺立即停止。

### 验收标准

- 在 embedding HTTP 进行中取消，上游收到 signal，不启动后续模型请求，也不继续网络重试。
- 排队工具取消后不执行；已开始的可取消工具退出并产生明确终态。
- 已提交写入不会显示“未保存”；未开始写入不落库。
- 同轮重复调用同一工具时，事件可按 callId 一一配对。
- 现有 SSE 取消与背压测试继续通过；断开的连接不再尝试无限写入。

---

## Issue F — feat(agent): 增加操作级写入授权、确认提案与幂等保护

### 当前问题与证据

普通任务默认只读已有代码保护。但显式 Agent 入口固定传 `allowWrites:true`，用户是否表达保存意图仅由工具描述约束；执行器没有检查具体保存操作是否已获用户确认。

`save_inspiration` 每次直接插入；`save_character` 先查同名再插入，当前实现本身不构成并发幂等保证。重试和并发可能制造重复写入，需要结合数据库约束进一步设计。

- [显式 Agent 固定开放写工具](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/agent/agent.service.ts#L35-L40)
- [保存意图仅在工具说明中](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/agent/story-tools.ts#L104-L115)
- [灵感直接插入](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/agent/story-tools.ts#L301-L316)
- [人物先查后插](https://github.com/tbyang28/ai-writing-assistant/blob/2e7697be7215b7a9ac50ec677386360847be5ba1/backend-ts/src/ai/agent/story-tools.ts#L409-L437)

### 参考机制与项目设计的区别

[Pi 在参数校验后、执行 handler 前调用 beforeToolCall，允许返回 block/reason](https://github.com/badlogic/pi-mono/blob/2c8d1feb147f6b3d97e855da803bfe7b19f3c403/packages/agent/src/agent-loop.ts#L735-L765)。可借鉴这一执行前策略检查位置。

下述“写入提案、确认绑定与幂等键”是针对本项目的设计建议，不宣称 DSH/Pi 已提供相同业务实现或 exactly-once 保证。

### 建议改动

1. 将布尔开关细化为只读、审阅、保存灵感、保存人物等 capability；`diff_edit` 不落库，应与保存能力分开。
2. 未授权保存时模型只能产出结构化提案。用户确认具体内容后，后端重新检查作品归属与提案状态，再执行该操作。
3. 确认绑定用户、作品、工具、参数摘要/版本和有效期；模型生成的 `confirmed:true` 或转述不能充当用户授权。
4. 为可重试写操作提供幂等键及数据库层原子性。人物重名是否允许先明确业务规则，不盲目添加名称唯一约束。
5. 保持章节正文无写工具的现有边界，继续由作者审阅应用。

### 验收标准

- “帮我设计人物”即使模型请求保存也不落库；返回可审阅提案。
- 确认一项提案只执行该项操作；更换参数、作品或用户后确认无效。
- 模型伪造确认字段、重复提交、网络重试和并发确认不造成重复保存。
- 只读任务仍拒绝所有写工具；差异审阅可独立授权。
- 已取消但实际写入完成的结果与 E 的提交状态保持一致。

## 暂不建议的工作

- 暂不为“Everything is a Plugin”重写项目或引入大量插件层：当前工具数量有限，先解决上述可复现缺口。
- 暂不以多 Agent、自动反思轮或更高轮数替代基础链路改良；目前缺少收益证据。
- 不承诺无损压缩、精确中文 token 计量、取消自动回滚或写操作 exactly-once。
- 不以真实用户作品默认建立公开评测集。后续质量评估先使用有授权的固定样本，区分协议正确性、工具选择与小说一致性。
