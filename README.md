# Sandbox MCP Suite

**English overview:** Two independent local MCP profiles: a project-scoped read-only server and a coding server with file, terminal, search and process tools. Includes a local management console and an activity monitor. The first release is validated on macOS. Local stdio needs no Tunnel or API key; remote access is optional and uses your own account and transport configuration.

把本机项目接入支持 stdio 的 MCP 客户端，并明确区分读取证据与修改电脑两种权限。

| Profile | 客户端名称 | 可以做什么 | 权限边界 |
| --- | --- | --- | --- |
| `readonly` | Sandbox MCP | 浏览已登记项目，读取文件、Git 差异与本地 artifacts | 项目 allowlist、文件策略与严格只读工具 |
| `coding` | Sandbox MCP for test | 编辑文件、搜索、运行命令、交互式 stdin、管理进程与 Chat 工作台 | 当前 OS 用户权限；没有项目目录 allowlist |

**coding 不是 OS sandbox。** 项目名称不表示容器或虚拟机隔离。只有需要编辑或执行命令时才把这个 profile 接入客户端。两个 profile 是独立进程，readonly 的项目登记不会限制 coding。详见 [安全与隐私](SECURITY.md)。

## 快速开始：本地只读

首版验收平台为 macOS，需要 Git、Node.js **22.19 或以上且低于 27**、npm。coding 的搜索还需要 `rg`（ripgrep）在 PATH 中。Linux 尚未完成平台验收，Windows 不支持。

```sh
git clone https://github.com/catking01/sandbox-mcp-suite.git
cd sandbox-mcp-suite
npm ci --ignore-scripts --no-audit --no-fund
node bin/sandbox-mcp.mjs init
node bin/sandbox-mcp.mjs add-project demo /absolute/path/to/your-project
node bin/sandbox-mcp.mjs doctor readonly
node bin/sandbox-mcp.mjs config readonly
```

将最后一条命令生成的 `mcpServers` 配置合并到你的 MCP 客户端。它包含当前 Node 与本仓库入口的绝对路径；不同客户端的配置入口可能不同，按该客户端文档操作。不要覆盖已有其它 MCP 配置。

首次配置不包含任何项目；把示例绝对路径换成自己要开放的项目目录。`doctor readonly` 启动一个临时 stdio 子进程检查初始化、工具发现与只读工具集合；它不执行业务工具，也不验证远程连接。

客户端连接后可以这样开始：

> 调用 `project.list_projects`，选择我登记的项目；先读项目 summary，再按需要读取明确文件。不要把本地文件内容当作远端 CI 或部署状态的证明。

直接运行 `serve readonly` 会等待 MCP 协议输入，终端看起来没有界面是正常行为。

## 启用 coding

在相同仓库目录执行：

```sh
node bin/sandbox-mcp.mjs setup coding
node bin/sandbox-mcp.mjs doctor coding
node bin/sandbox-mcp.mjs config coding
```

`setup coding` 按锁文件安装独立依赖，跳过第三方 lifecycle scripts，再显式运行本仓库的准备脚本。它不启动服务、不创建 Tunnel，也不修改 readonly 的项目列表。

coding 复用固定版本 Desktop Commander 的本地实现，提供：

- 文件读取、写入、编辑、移动和目录浏览。
- 可分页的文件与内容搜索。
- 可跨工具调用持续运行的终端进程、输出读取与交互输入。
- 本机进程查看与终止。
- 支持 MCP Apps 的客户端中的文件编辑、终端、搜索和 Git 工作台。

安装后可在客户端要求“列出某个绝对目录”验证最小调用。终端执行使用当前用户权限，命令目录可在命令中显式 `cd`。`start_process.timeout_ms` 是首次等待输出的时间，进程可以在返回之后继续执行；后续通过 `read_process_output` 读取结果。更多行为见 [coding runtime](runtime/desktop-commander/README.md)。

## Console 与 Monitor

```sh
node bin/sandbox-mcp.mjs console --open
node bin/sandbox-mcp.mjs monitor --open
```

两个页面都只绑定本机 loopback。不带 `--open` 时只打印地址；用 `--port N` 选择端口。

**Console** 管理 readonly 项目、只读工具权限，以及本产品安装的后台服务。配置可以在此修改，但 coding 不提供项目范围限制。

**Monitor** 只读显示经过 coding 的工具状态、耗时和显式发布的进度文本。它不抓取完整 ChatGPT 对话，不显示模型内部推理或真实 Token 用量，也不调用模型 API。尚无活动时页面为空是正常情况。

Chat 中的 `open_workbench` 是另一个入口，需要客户端支持 MCP Apps UI；普通 MCP 工具不依赖该 UI。客户端是否呈现 UI、账户可用性及用量规则由客户端决定。

macOS 还可通过 `npm run build:mac` 构建本地 Console 与 Monitor launcher。它们依赖相邻源码及 Node，需要留在安装目录中；具体要求见 [macOS 窗口](docs/INSTALL.md#可选-macos-窗口)。

## 常用命令

源码安装时把下表的 `sandbox-mcp` 替换为 `node bin/sandbox-mcp.mjs`。可选的全局命令安装见 [安装指南](docs/INSTALL.md)。

| 命令 | 用途 |
| --- | --- |
| `sandbox-mcp init` | 初始化个人配置；保留已有配置 |
| `sandbox-mcp add-project ID ABSOLUTE_PATH` | 登记 readonly 项目 |
| `sandbox-mcp remove-project ID` | 移除 readonly 登记，不删除项目文件 |
| `sandbox-mcp setup coding` | 安装并准备固定 coding 依赖 |
| `sandbox-mcp config readonly\|coding\|both` | 打印本地 stdio 客户端配置 |
| `sandbox-mcp doctor [readonly\|coding]` | 检查本地协议初始化与工具发现 |
| `sandbox-mcp console [--open] [--port N]` | 启动本机管理页面 |
| `sandbox-mcp monitor [--open] [--port N]` | 启动本机只读活动页面 |
| `sandbox-mcp service …` | 显式安装和管理可选 macOS Tunnel LaunchAgent |

个人配置与状态默认保存在 `~/.sandbox-mcp`。如需分开多个配置，在所有相关命令中使用同一个绝对 `SANDBOX_MCP_HOME`，或同一个 `--home ABSOLUTE_PATH`；再重新生成客户端配置。源代码目录不保存你的项目列表和运行状态。

## 可选远程连接

本地 stdio 路径已经构成完整产品。需要从 ChatGPT 等远程客户端访问时，再按 [OpenAI Tunnel Client 官方说明](https://github.com/openai/tunnel-client) 为自己的账户配置 Tunnel。此仓库不提供账户、凭据、托管服务或 Tunnel 二进制。

CLI 提供 macOS LaunchAgent 生成与管理，安装默认不启动。配置、Keychain 引用、服务启动和卸载步骤见 [远程连接与后台服务](docs/INSTALL.md#可选远程连接与后台服务)。不要把 Console、Monitor 或 Tunnel 的健康检查端口当作远程 MCP endpoint。

## 验证与已知边界

```sh
npm test
npm run test:commander
npm run test:workbench
```

coding 测试需要先执行 `setup coding`。可选真实 Tunnel 二进制回归使用 loopback 控制面与虚构凭据：

```sh
TUNNEL_CLIENT_BINARY=/absolute/path/to/tunnel-client npm run test:tunnel
```

这些测试覆盖具体文件、终端、UI 和协议行为。它们不证明长期无故障、所有外部客户端兼容、跨平台支持，或服务重启后保留内存中的终端会话。项目当前面向个人 macOS 工作流，没有生产 SLA。故障请先按 [排障指南](docs/TROUBLESHOOTING.md) 区分本地工具、stdio、Tunnel 与远程客户端边界。

当前 coding 依赖仍有已知安全告警，扫描范围、已有缓解措施与剩余边界见 [依赖安全状态](SECURITY.md#依赖安全状态2026-11-25)。

## 文档与许可

- [完整安装、升级与卸载](docs/INSTALL.md)
- [故障定位](docs/TROUBLESHOOTING.md)
- [coding 工具与终端语义](runtime/desktop-commander/README.md)
- [安全与隐私](SECURITY.md)
- [参与开发](CONTRIBUTING.md)
- [第三方来源与许可](THIRD_PARTY_NOTICES.md)

适配层、CLI 与文档采用 [MIT License](LICENSE)。第三方组件保留各自许可。
