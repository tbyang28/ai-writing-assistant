# 本机模型发现：源码依据与实施范围

目标：用户主动运行连接器，在固定 loopback 服务中发现 Ollama / LM Studio 模型，经一次性配对和明确启用后用于写作与 Agent。账号之间隔离；断线、停用、撤销、取消不触发云端回退。

## 核对过的参考实现

所有链接固定到 2026-11-02 实际查询到的提交；未执行外部仓库代码，未复制其实现。

### Magpie

提交：`a8d6a861a44e007aff9f2d4283116381f67f44e9`。

- [`internal/cli/account_discovery_cli.go`](https://github.com/yetone/magpie/blob/a8d6a861a44e007aff9f2d4283116381f67f44e9/internal/cli/account_discovery_cli.go)：`accountsDiscoveryCmd` 控制是否读取 agent 自己的登录信息；注释明确提及 credential files、Keychain，以及把它们作为 subscription 提供。关闭后 API-key provider 仍工作。
- [`internal/agent/agents.go`](https://github.com/yetone/magpie/blob/a8d6a861a44e007aff9f2d4283116381f67f44e9/internal/agent/agents.go)：`readOwnAuth` 在 `AccountDiscoveryOff()` 时返回 `os.ErrNotExist`，否则调用 `os.ReadFile(path)`。这证明“发现安装”与“读取账号登录状态”是不同权限。
- [`LICENSE`](https://github.com/yetone/magpie/blob/a8d6a861a44e007aff9f2d4283116381f67f44e9/LICENSE)：该提交采用 MIT。

应用：把可用性发现、账号连接和实际调用分开。本项目不实现订阅登录信息导入，不读取 Keychain、OAuth 或 CLI 配置中的密钥。CLI 仅检查 PATH 中的已知可执行文件，不执行。

### Multica

提交：`0d2607010b1063d30fd52b56e97342ea7f1e854a`。

- [`install-agent-runtime.mdx`](https://github.com/multica-ai/multica/blob/0d2607010b1063d30fd52b56e97342ea7f1e854a/apps/docs/content/docs/install-agent-runtime.mdx)：本地 runtime 由 daemon 与可调用的 coding tool 组成；工具先在终端完成安装/登录，再启动 `multica daemon start`，在 Runtimes 页面选择目标电脑。文档明确说 CLI 登录凭证留在工具本地，Multica 不接收这些 CLI 的登录 token。
- [`server/internal/daemon/agents_refresh.go`](https://github.com/multica-ai/multica/blob/0d2607010b1063d30fd52b56e97342ea7f1e854a/server/internal/daemon/agents_refresh.go)：区分廉价的 CLI 可用性发现（注释说明 `exec.LookPath`）和较昂贵的版本探测/注册；`refreshAgentAvailability` 调用 `probeAgentCLIs`，`agentDiscoveryLoop` 周期刷新，并对注册失败退避。
- [`server/internal/daemon/client.go`](https://github.com/multica-ai/multica/blob/0d2607010b1063d30fd52b56e97342ea7f1e854a/server/internal/daemon/client.go)：客户端通过 `http.NewRequestWithContext` 向 `baseURL` 发送 daemon 控制请求。本项目独立采用出站 HTTP 轮询，不声称复刻其完整传输协议。
- [`server/pkg/agent/agent.go`](https://github.com/multica-ai/multica/blob/0d2607010b1063d30fd52b56e97342ea7f1e854a/server/pkg/agent/agent.go)：`DetectVersion` 会实际运行 CLI `--version`。本项目 v1 不执行这个步骤，检测结果只代表文件存在。
- [`LICENSE`](https://github.com/multica-ai/multica/blob/0d2607010b1063d30fd52b56e97342ea7f1e854a/LICENSE)：Part I 为 Apache 2.0 文本附加条件；其 1(a) 限制无商业许可向第三方提供 hosted service，免费公开实例也在条文内。不可仅因其包含 Apache 文本而当作无附加限制使用。本项目未采用其代码或 UI。

应用：云端只管理已注册设备及任务；本地组件负责服务发现。发现、能力确认、注册与在线状态分开表示，不把已安装 CLI 等同于可调用 API。

## 本项目边界

- 浏览器和云端不扫描用户磁盘/内网；用户运行 Node 20+ 连接器，仅访问 `127.0.0.1:11434` 与 `127.0.0.1:1234`。
- 不开本机监听端口，不接收云端指定的 URL、命令或文件路径，不跟随 HTTP 重定向。
- CLI 名称检测不读取凭证、不执行进程；可选本机 API key 由用户显式通过环境变量提供，只发给对应固定服务。
- 配对码有效 5 分钟且单次使用；连接令牌仅有拉取自己任务/提交结果权限，不能调用账号 API 或确认 Agent 提案。服务器只存令牌哈希。
- 新设备默认禁用。启用后仍需选择本机模型，才会发送该次请求的作品上下文。
- Ollama 只在 `/api/show` 声明 tools 时开放工具；LM Studio 的 `/v1/models` 不证明工具能力，默认不开工具。Agent 工具仍在服务器验证并执行。
- 上下文预算采用保守字节估计，发现的模型上下文信息不代表质量测试，也不能保证服务端加载配置与模型理论上限相同。上下文过大时明确报错。
- 生成失败、离线、停用和撤销不会自动改用云端模型。RAG/embedding 仍按原来的服务器供应商运行，所以并非离线产品。
- v1 为单后端实例、有限内存队列，重启丢弃待配对/在途任务，用户重新发起；多实例部署需先引入共享队列与配对存储。

接口、资源上限及验收依据见 [local-provider-contract.md](../local-provider-contract.md)。
