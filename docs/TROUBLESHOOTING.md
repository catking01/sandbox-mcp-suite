# 故障定位

**English overview:** Separate local setup, MCP protocol, tool policy, process execution, Tunnel and client failures. A timeout or pipe error identifies a boundary, not a complete root cause. Reproduce with a harmless, focused operation before changing configuration.

## 先检查本地入口

在安装目录执行对应 profile 的检查：

```sh
node bin/sandbox-mcp.mjs --version
node --version
node bin/sandbox-mcp.mjs doctor readonly
```

coding 用户改为 `doctor coding`。不带 profile 会检查两者；只安装 readonly 时，coding 未准备的结果不影响 readonly 的独立使用。

`doctor` 检查临时子进程的 `initialize`、`notifications/initialized` 与 `tools/list`。成功说明这个本地协议路径可用，不证明具体文件可读、命令可执行或远程连接正常。下一步在实际客户端读取自建测试文件，或对 readonly 调用 `project.list_projects`。

## 常见问题

| 症状 | 首先检查 | 处理 |
| --- | --- | --- |
| `Run sandbox-mcp init first` | 当前数据目录是否一致 | 对同一个 `SANDBOX_MCP_HOME` 执行 `init`，重新生成客户端配置 |
| 项目列表为空 | 是否登记、停用或连接了另一配置 | 用 Console 查看登记；不要猜 `project_id` |
| `Coding runtime is not prepared`、缺依赖或 patch marker | 是否执行完整准备步骤 | 运行 `setup coding`；不要删除版本检查 |
| `rg` 不存在或搜索启动失败 | GUI / 后台 PATH 与 shell PATH 是否不同 | 确认实际运行环境能找到 ripgrep，再重启相应客户端 |
| `EACCES`、全局包不可写 | npm prefix 或安装目录所有者 | 使用自己可写的源码目录或 [用户 prefix](INSTALL.md#可选安装全局命令)，无需 sudo |
| `serve` 启动后没有界面 | 是否把协议服务器当命令行页面 | 让 MCP 客户端启动它；使用 `console` / `monitor` 打开页面 |
| `Non-JSON output on MCP stdout` | launcher 或依赖是否向 stdout 打诊断 | stdout 只保留 MCP；诊断输出到 stderr |
| 文件被 policy 拒绝 | profile、项目 ID、路径、allowlist / denylist | 缩小到已允许的明确路径；不要自动关闭拒绝规则 |
| 工作台 UI 不出现但普通工具可用 | 客户端是否支持 MCP Apps | 使用基础工具；刷新工具/schema 或使用支持 UI 的客户端 |
| Console 端口占用 | 已存在的本机页面进程 | 使用原页面或显式选择其它端口 |
| Monitor 没有活动 | 连接的是否是同一 coding 状态目录 | 检查 `SANDBOX_MCP_HOME`；没有工具调用时为空是正常情况 |
| 服务状态运行中但远程失败 | Tunnel、stdio 与远程客户端三层是否一致 | 按下文分别验证，不只看 PID 或 `/healthz` |

## readonly：读取失败与连接失败不同

`isError=true` 的 MCP tool result 表示请求已经进入工具层。例如项目不存在、文件超出允许范围、越界路径、超出大小或策略拒绝，都应先按返回信息处理。它们不等于 HTTP 404 或 Tunnel 不可达。

文件参数使用项目内相对路径；coding 文件工具则通常使用绝对路径。不要混用两个 profile 的参数格式。需要 Git 状态时使用 `project.get_git_status` 等专用工具，不因 `.git` 直接读取被拒绝而放开整个 Git 目录。

大文本可按 `project.read_text_file` 的提示使用 `offset_bytes` 与 `max_bytes` 分块。配置中的文件大小上限、每次内联文本上限及最终 MCP 响应上限是不同限制；文件很大不意味着应一次返回整个内容。

工具列表中看不到被关闭的只读工具是预期行为。工具权限与项目可见范围分别控制“能调用什么”和“能看到哪些内容”。公开 readonly 入口固定为只读，旧配置的写入字段不会把它升级为 coding。

若导入旧配置后看到 `Read-only server rejects non-read_only project`，检查项目条目的 `mode`。此入口只接收 `read_only` 项目；需要写入时使用独立 coding profile，不要将旧 `restricted_write` 配置直接当作可兼容的只读配置。

## coding：超时、进程与输出

### 命令超时后是否还在执行？

`start_process.timeout_ms` 是首次等待输出的预算。调用返回后进程可能仍在运行；通过 `read_process_output` 或 `list_sessions` 查询。不要只因一次 MCP 调用超时就再次执行相同命令。

客户端或 Tunnel 超时也不撤回已经送入进程的动作。尤其是部署、提交、删除、外部请求等操作，应先核实副作用，再决定重试。若 stdin 写入报告 delivery unknown，字节可能已经部分或全部交付；不要把“没有收到响应”当作“没有执行”。

`read_process_output` 的单次等待最多 60 秒，但远程链路可能有更短预算。长任务应使用短初始等待、后续分次读取。长时间占用同一 stdio 转发会延迟其它调用；一次读取等待的取消与终止进程是不同动作。

### 输出重复、缺少前缀或 cursor 失效

没有 Chat session 身份且未指定 `reader_id` 的读取是非消费 tail；重复看到同一片段可能符合预期。需要可复查的分块读取时用 `cursor: "start"`，随后传回 `next_cursor`。多个独立消费者可使用不同 `reader_id`，不要同时推进同一个 reader。

输出缓冲区有容量限制。返回中的 omitted / truncated 信息表示一些前缀或片段没有出现在当前结果里。`next_cursor` 不能恢复已经从缓冲区淘汰的内容，也不能跨 MCP 重启继续。需要长期保存的程序输出应由该程序写到自己明确选择的文件。

### stdin 关闭或进程已退出

`EPIPE` 也可能只是被操作的子进程关闭了 stdin。若随后其它 MCP 工具仍能调用，不能把它直接归因于 Tunnel 的 stdio 断开。当前适配层将这种输入错误返回给该工具调用；等待写入结果不明确时会阻止继续叠加输入，直到实际写入完成或流关闭。

停止普通任务可使用相应终止工具。适配层清理自身创建的普通进程组，不能保证清理主动 detach 的 daemon。不要使用宽泛的 `killall node` 或 `pkill tunnel-client`，这可能影响其它软件或另一个 profile。

### 编辑未生效

`edit_block` 的某些 no-match 情况可能出现在结果文本中而非 `isError` 标志。检查返回内容，再读回目标区域或查看 diff。Chat 工作台保存若提示文件版本冲突，先读取最新文件并合并；不要绕过版本检查覆盖他人的修改。

## Tunnel 与远程客户端

### 本地通过、远程 HTTP 404 / 401 / 403 / 502

先判断错误实际来自哪一层：

| 观察 | 可以判断什么 | 不能据此判断什么 |
| --- | --- | --- |
| 本地 `doctor` 通过 | 本地 stdio 初始化与工具发现可用 | 远端账号或连接已授权 |
| Keychain 读取被拒绝 | 当前用户会话或凭据存储访问失败 | API key 本身已经失效 |
| 远程 401 / 403 | 认证或授权边界拒绝 | 本地文件权限有问题 |
| 远程 404 且无对应本地调用 | 请求可能未到本地工具层 | 项目文件不存在 |
| Tunnel 已转发但 child stdio 关闭 | 传输与子进程边界失败 | 一定是 Node 崩溃或工具实现错误 |
| 本地工具已完成，客户端仍超时 | 响应返回或客户端预算仍需检查 | 命令没有执行、可以安全重放 |
| `/healthz` / `/readyz` 正常 | 对应健康端点可响应 | MCP 工具发现和实际响应都成功 |

Console、Monitor 和 Tunnel 临时健康检查端口都不是远程 MCP URL。向它们尝试 `/mcp` 或 `/sse` 不能修复托管连接。应使用上游流程提供的真实连接入口。

远程客户端可能缓存旧工具 schema。升级后按客户端说明刷新连接，必要时新建对话。工具没有进入当前对话时，重启本机 MCP 不一定能改变客户端的工具注入。

### stdio 关闭与 legacy 初始化

“输入管道关闭”描述的是生命周期事件，根因仍可能在父进程转发、请求到期、子进程退出或显式停止。对照相同时间段中**先发生**的事件，而不是根据错误行里的组件名称归因。

项目传输回归选择官方 Tunnel v0.0.21；旧版共享 stdio 并发处理的问题不能仅靠重启包装器修复。升级后的故障仍需重新分层，不能把所有失败继续归为同一个历史原因。

legacy MCP 调用需要正确的 `initialize` 与 `notifications/initialized` 顺序。若工具调用得到 409，检查初始化窗口、重复握手与使用的 Tunnel 适配选项；409 与已经关闭的 stdio pipe 是不同症状。本地 stdio 客户端应正常执行 MCP 握手，不需要为使用本产品添加 Tunnel 选项。

隔离的 v0.0.21 回归复现了第二次 legacy initialize 到 initialized 通知之间的 409：这时请求没有进入 child，补齐通知后同一 child 恢复。开启官方 `--mcp.stdio-send-initialized-notification=true` 后，同样交错下的调用成功，后续重复通知也未重复交给 child。本产品 `service install` 生成的启动命令启用了这个选项；自己编写 launcher 的用户应核对实际参数，而不是只检查二进制版本。

v0.0.21 的请求响应期限到期会结束该请求的等待，过晚结果不保证继续发往控制面。这不是可靠的“工具未执行”或“必定返回 504”信号。不要把增加超时与增加重启层作为默认修复；先确定失效边界。

### 后台服务、Keychain 与代理

```sh
node bin/sandbox-mcp.mjs service status coding
```

如果服务未安装，先按 [安装指南](INSTALL.md#可选远程连接与后台服务) 显式安装；正常的源码安装不会自动创建服务。当前用户 LaunchAgent 不是系统级 daemon；退出登录、休眠、网络变化及 Keychain 锁定都可能影响远程可达性。

凭据引用必须是当前用户有权读取的 Keychain service。若 profile 依赖终端中临时 export 的环境变量，它在 launchd 中可能无法解析。代理也应按你选择的 Tunnel profile 显式配置，产品不会继承某台电脑的代理地址。

先读取服务输出里标明的日志和生成路径；不要用完整配置或环境 dump 上传诊断。只管理自己安装的 profile，不停止其它账户或旧私有部署的服务。同一个 Tunnel 身份不应同时启动两个转发客户端。

## Console、Monitor 与 Chat 工作台

Console 的本地 Host / Origin / token 检查失败时，重新打开服务当前打印的本机 URL。不要通过修改检查代码允许任意域名来处理代理或书签问题。Monitor 的 token 在每次启动后改变；旧书签不能代表新实例授权。

Monitor 只显示本产品写入的活动记录和显式 `workbench_sync_publish` 文本。它不自动同步用户全部聊天或模型内部推理，也没有精确 Token 用量。日志轮换后较旧事件可能不再可见。

Chat 工作台依赖客户端支持 MCP Apps UI。基础工具成功而 iframe / 工作台没有呈现，应单独检查客户端能力与资源加载；这不等于文件工具不可用。

## 提交可复现问题

在 [Issues](https://github.com/catking01/sandbox-mcp-suite/issues) 中提供：

- 产品版本、Node 版本、macOS 版本与使用的 profile。
- 安装来源、最小复现步骤、预期行为与实际结果。
- 带时区的失败时间，以及同一时间附近已删去个人信息的必要日志。
- 是否本地 `doctor` 通过、是否实际工具调用通过、是否仅远程失败。
- 若涉及 Tunnel，提供版本与选用的非敏感功能选项；不要提供真实 key、Tunnel ID 或完整 profile。

用自建临时文件替代私人项目，省去无关命令输出。相同失败在未改变输入或环境前反复重试通常不会增加信息。怀疑安全漏洞时使用 [安全报告路径](../SECURITY.md#报告漏洞)，不要公开利用细节或凭据。
