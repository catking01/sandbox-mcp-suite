# coding runtime · Sandbox MCP for test

**English overview:** A local stdio integration of pinned Desktop Commander handlers for files, search, terminal and processes, with a small MCP Apps workbench and a local activity feed. It runs with the current OS user's permissions and is not an OS sandbox. The release validation scope is macOS.

这是 `sandbox-mcp serve coding` 使用的运行时。独立固定依赖位于本目录，个人状态默认位于 `~/.sandbox-mcp/state/`。只读 `readonly` profile 是另一个实现；它的项目 allowlist 不会约束这里的文件或命令权限。

## 安装与启动

从仓库根目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
node bin/sandbox-mcp.mjs init
node bin/sandbox-mcp.mjs setup coding
node bin/sandbox-mcp.mjs doctor coding
node bin/sandbox-mcp.mjs config coding
```

把生成的 server 配置加入自己的 MCP 客户端。需要 Node.js `>=22.19 <27` 与可在实际运行 PATH 中找到的 `rg`。macOS 终端默认 shell 为 `/bin/zsh`。Linux 代码路径使用 `/bin/bash`，但尚未完成同等平台验收；Windows 不支持。

`setup coding` 先执行本目录的 `npm ci --ignore-scripts --no-audit --no-fund`，再显式运行 `prepare.mjs`。也可为开发调试分别执行这两步；每次重装依赖后都要重新准备。正常用户应优先使用统一 CLI。

本集成使用 `@wonderwhy-er/desktop-commander@0.2.48`、`@modelcontextprotocol/sdk@1.32.2` 与锁文件中的依赖，并将 Commander 的 sharp 传递依赖定向覆盖为 0.35.5。它直接导入需要的本地 handlers，不启动上游 onboarding、remote pairing 或完整入口，关闭 Desktop Commander telemetry。跳过生命周期脚本意味着部分文档或原生依赖能力不属于已验证功能，不能将其视为完整上游产品替代。剩余已知依赖告警见 [安全说明](../../SECURITY.md#依赖安全状态2026-11-25)。

## 工具

| 类别 | 工具 |
| --- | --- |
| 文件 | `read_file`、`read_multiple_files`、`write_file`、`edit_block`、`create_directory`、`list_directory`、`move_file`、`get_file_info` |
| 搜索 | `start_search`、`get_more_search_results`、`stop_search`、`list_searches` |
| 终端 | `start_process`、`read_process_output`、`interact_with_process`、`force_terminate`、`list_sessions` |
| 进程 | `list_processes`、`kill_process` |
| Chat 工作台 | `open_workbench`、`workbench_list_directory`、`workbench_read_file`、`workbench_save_file`、`workbench_git_changes`、`workbench_terminal_snapshot` |
| 活动同步 | `workbench_sync_status`、`workbench_sync_publish` |

以客户端发现的当前 schema 为参数依据。文件路径使用绝对路径，命令可以显式 `cd` 到需要的目录。coding 没有项目目录 allowlist，不能把 `cwd` 当成权限限制。

`read_multiple_files` 每次最多接收 **100 个路径**。超过上限的数组在逐元素 schema 解析前拒绝，工具发现也声明 `maxItems: 100`；更多文件请拆成较小批次。这一边界不替代单文件大小限制或整体资源管理。

工具可用不表示用户已经授权任何命令。OS 文件权限、macOS 隐私控制和依赖中的命令限制仍然适用；专用 `kill_process` 会拒绝 PID 0、负数进程组目标、PID 1，以及已知的 MCP / 直接父进程 / Tunnel PID。这不构成对通用 shell 的系统隔离。

不暴露 URL 读取、独立 `write_pdf`、多设备、telemetry / feedback、上游配置修改及 onboarding 工具。上游通用文件 handlers 仍带有文档读写路径：例如 `write_file` 对 `.pdf` 可进入 Markdown / Puppeteer 处理。安装不会自动下载浏览器，完整文档格式与生成能力不在当前验收范围内；不能因工具名没有 PDF 就认定这些依赖不可达。`edit_block` 的某些无匹配条件可能只体现在结果文本中；应检查响应，并通过读回或 diff 确认修改。

## 终端执行与输出

### 进程生命周期

`start_process.timeout_ms` 控制首次等输出的时间，不是进程总执行期限。工具可以先返回 PID，进程随后继续运行。使用 `read_process_output` 获取新增输出与退出状态，或 `list_sessions` 检查登记中的会话。

会话索引与输出缓冲保存在 MCP 进程内存中。真正重启后无法承诺恢复旧终端会话。适配层给新建终端建立独立进程组，及时记录 PID，并在终止或关闭时清理普通子进程；主动 detach / 另建 session 的 daemon 不在完整清理保证内。需要长期保留输出时，让程序显式写入适当的文件。

本集成支持向进程 stdin 写入，不额外实现一个完整 PTY。依赖 TTY 特性、屏幕控制或独占交互的程序不应直接假定兼容。

### 三种输出读取方式

| 方式 | 行为 | 适合 |
| --- | --- | --- |
| 有 Chat session 身份，可附 `reader_id` | 按 session / reader 独立推进增量位置 | 一个或多个独立消费者持续跟进 |
| `cursor: "start"`，再使用返回的 `next_cursor` | 显式、可重读的分块位置 | 需要重放同一读取或控制分页 |
| 无身份、无 reader / cursor | 非消费的输出 tail | 临时查看最新情况 |

`reader_id` 是 cursor 命名空间，不是访问授权。没有 session 身份时，显式同名 reader 是调用者共享的名字；两个读者需要独立位置就使用不同名字。同一 reader 不能同时存在两个未完成读取。

`offset` 非零的按行读取与 `workbench_terminal_snapshot` 不消费增量 cursor。`cursor` 不能和 `reader_id` 或非零 `offset` 混用。单次等待 `timeout_ms` 在 0–60000 范围，返回量还有独立上限。

响应会指出前缀遗漏、截断与 `has_more`。`next_cursor` 只能继续尚保留的流；它不是永久日志定位符，不能跨服务实例或进程重启继续。匿名 tail 的前缀如果未包含在本次结果中，需要以 `cursor: "start"` 读取仍在缓冲区内的早期内容，不能用已经位于尾部的 cursor 回溯。

取消一次输出等待会释放它的读取占用，不消费后续才出现的输出。取消等待不等于终止进程。stdout / stderr 的 UTF-8 分片及强制长行分段会保留字符边界，但有限缓冲区仍可能淘汰旧输出。

### 输入错误与未知交付

stdin 写入等待实际完成回调。目标进程关闭输入时，工具返回错误，MCP 继续处理其它请求。写入若长时间没有完成，工具报告 delivery unknown；已经交给 pipe 的字节无法撤回。后续输入会被拒绝，直到同一次写入真正完成或流关闭 / 报错。

不要在未知交付后自动重复输入。尤其是部署、删除、提交或外部请求，应检查进程与实际结果后再决定动作。客户端或 Tunnel 到期也不能证明底层工具没有执行。

## Chat 中的工作台

在支持 MCP Apps 的客户端调用 `open_workbench`，提供绝对 `cwd`。工作台包含文件浏览、文本编辑、终端输出、搜索与 Git 差异查看。资源采用标准 `ui/*` bridge，随产品提供静态内容，不加载远程脚本或调用模型 API。

普通数据工具不会重新挂载 UI。保存检查已读文件的内容版本；选择文件或终端后，正在提交的操作继续绑定原对象，不会被后续 UI 切换重新指向。终端快照是非消费读取，并对保留尾部、Unicode 边界及省略前缀做明确处理。

MCP Apps 是否渲染、客户端账户是否开放相关能力及其用量规则由客户端决定。基础文件与终端工具可以独立使用。不能将本地 UI 测试通过解读为所有客户端或账户已经兼容。

## Monitor、状态与诊断

仓库根目录运行：

```sh
node bin/sandbox-mcp.mjs monitor --open
```

Monitor 只读展示工具名称、状态、耗时以及 `workbench_sync_publish` 显式发布的文本。它不执行命令，不访问模型 API，不读取完整 ChatGPT 对话或内部推理，也没有真实 Token 统计。

默认存储位置：

| 内容 | 路径 |
| --- | --- |
| 隔离的 Desktop Commander 配置与生命周期记录 | `SANDBOX_MCP_HOME/state/commander/` |
| Monitor 活动记录 | `SANDBOX_MCP_HOME/state/chat-sync/events.jsonl` |

其中 `SANDBOX_MCP_HOME` 默认是 `~/.sandbox-mcp`。开发调试可用 `SANDBOX_COMMANDER_STATE_DIR` 或 `SANDBOX_WORKBENCH_SYNC_FILE` 分别覆盖，正常用户通常不需要。多个入口必须使用一致的路径才能看到同一份活动。

生命周期记录不包含命令全文和终端输出，用于区分启动、关闭、取消及协议事件。活动文件会限制容量并轮换，不能作为永久审计记录；用户显式发布的文本会被保存，因此不要发布凭据或私人对话。Monitor 当前 URL 包含本地访问 token，不应公开分享。

## 准备脚本修改了什么

`prepare.mjs` 对固定依赖做可重复的局部改动：

- 将配置隔离到本产品的状态目录，不复用上游应用的个人配置。
- 将终端放进独立进程组，保证登记、终止和普通子进程清理。
- 等待 stdin 写入结果，处理关闭与未知交付，避免继续叠加未确定输入。
- 修复 UTF-8 跨分片解码及长行分隔的 Unicode 边界。
- 保留 MCP SDK 中有效的 `0` 和空字符串 request ID，避免取消判断把它们当作缺失；1.32.2 仍需要该单点补丁。
- 避免部分终端诊断把完整命令写到协议 stdout。

准备会检查版本与预期源码；升级后的片段不匹配时停止。不要删掉检查以让安装“通过”。源码依据为 [Desktop Commander commit 20a3ecc](https://github.com/wonderwhy-er/DesktopCommanderMCP/tree/20a3ecc163d74bfc49cba0ca94a89ccb7ed58506)，实际执行依赖来自锁定的 npm 包；不声称 npm tarball 与 Git checkout 逐字节相同。保留 [UPSTREAM-LICENSE](UPSTREAM-LICENSE) 与 [第三方声明](../../THIRD_PARTY_NOTICES.md)。

## 可选 Tunnel

核心运行时是 stdio，不需要 Tunnel。远程部署通过各用户自己的官方 Tunnel profile 和凭据接入，见 [安装指南](../../docs/INSTALL.md#可选远程连接与后台服务)。

传输回归基线为官方 v0.0.21。共享 stdio 的响应归属、请求到期和 legacy 初始化需要在 Tunnel 边界处理，不应依赖 MCP 外再叠加恢复包装器掩盖故障。legacy 调用需要 `initialize` 与 `notifications/initialized`；遇到初始化状态 409 时应与 pipe 关闭分别诊断。

产品服务显式使用官方 `--mcp.stdio-send-initialized-notification=true`。隔离回归已验证：默认行为在第二次 legacy initialize 后会出现等待 initialized 通知的 409 窗口；启用该选项后，同样交错下调用成功，且后续通知不会重复转发给 child。`--mcp.stdio-failure-policy exit` 将 child 失败交给 Tunnel 退出与 LaunchAgent 恢复，MCP child 直接运行，不另加第二个恢复 owner。

该 Tunnel 版本的 `--mcp.connection-max-ttl` 默认 `10m0s`，控制传输连接生命周期；用户 profile 可以覆盖，本产品不强制另设 TTL。它不是单次调用超时，也不保证远程客户端会等待完整的 60 秒终端读取预算。

一次响应期限到期不会撤回已经发送的命令。在 v0.0.21 中，过期请求不保证再向控制面 POST 结果，不应据此要求必定返回 504。长时间等待还会占用同一转发连接，优先使用短初始等待与后续读取。

真正进程重启仍会丢失内存会话；可恢复连接不等于恢复旧任务状态。健康端点也不替代实际 MCP 工具探针。此仓库不附带任何维护者的运行身份、Keychain 值、Tunnel 二进制或回滚目录。

## 验证

从仓库根目录执行：

```sh
npm run test:commander
npm run test:workbench
```

针对传输问题，可显式提供自己的真实 Tunnel 二进制：

```sh
TUNNEL_CLIENT_BINARY=/absolute/path/to/tunnel-client npm run test:tunnel
```

传输 fixture 使用临时 HOME、独立状态、虚构凭据和 loopback 控制面，不连接真实账户。当前 macOS 验证中，官方 v0.0.21 的六项 [Tunnel 回归](tunnel-stdio.test.mjs) 通过：交错响应归属与重复 ID、期限后的晚响应、原生 child 失败退出、期限后的真实终端可用性、legacy 初始化 409 窗口，以及官方通知适配。更换依赖或二进制后的结果应重新执行确认。

这些回归验证具体边界，不构成无限期稳定、所有部署环境兼容或跨重启进程恢复的证明。一般安装问题见 [排障指南](../../docs/TROUBLESHOOTING.md)。
