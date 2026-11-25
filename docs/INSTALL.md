# 安装与使用

**English overview:** Install from this GitHub repository or an explicitly downloaded release tarball. Initialize a private data directory, choose `readonly` or `coding`, then generate a local stdio client configuration. Tunnel and macOS background services are optional and require your own credentials.

## 先选择权限

只需要读源码、测试结果、Git 状态或研究材料时，使用 `readonly`。需要编辑或运行程序时，再启用 `coding`。两者可以分别接入同一个客户端，但客户端应清楚当前使用哪一组工具。

| 项目 | readonly | coding |
| --- | --- | --- |
| 允许读取的目录 | 已登记项目及文件策略允许的内容 | 当前 OS 用户可访问的目录 |
| 文件修改、终端执行 | 不提供 | 提供 |
| 项目登记 | 必需 | 不用于限制权限 |
| 根目录 npm 依赖 | 必需 | 必需 |
| 独立 coding 依赖 | 不需要 | `setup coding` 安装 |
| Tunnel / API key | 本地 stdio 不需要 | 本地 stdio 不需要 |

首版验收范围是 macOS。Linux stdio 尚未完成平台验收；macOS LaunchAgent 与原生窗口不适用于 Linux。Windows 不支持。coding 不是系统沙箱，详见 [权限边界](../SECURITY.md#权限边界)。

## 从源码安装

需要 Git、Node.js `>=22.19 <27` 和 npm。coding 搜索使用系统上的 ripgrep；请先确保 `rg --version` 成功。依赖安装需要访问你配置的 npm registry。

```sh
node --version
npm --version
git clone https://github.com/catking01/sandbox-mcp-suite.git
cd sandbox-mcp-suite
npm ci --ignore-scripts --no-audit --no-fund
node bin/sandbox-mcp.mjs init
```

推荐把源码放在自己可写的目录中。CLI 的 coding 准备步骤会在包目录下创建独立 `node_modules`；不要把包安装到必须使用管理员权限才能修改的位置。

`--ignore-scripts` 是安装步骤的一部分。上游依赖包含 installation tracking、浏览器下载和本机组件安装脚本；本项目通过显式准备步骤只启用已选择的本地路径。不要因某个补丁检查失败而改为运行全部上游脚本。

### 个人配置目录

默认路径：

| 位置 | 内容 |
| --- | --- |
| `~/.sandbox-mcp/config/` | 项目登记、文件策略、工具权限、coding 配置 |
| `~/.sandbox-mcp/state/` | 本地运行状态、coding 配置和活动记录 |
| `~/.sandbox-mcp/logs/` | 本产品后台服务等日志 |
| `~/.sandbox-mcp/state/services/` | 显式服务安装生成的启动文件与健康端点记录 |

`init` 创建缺失配置，保留已有文件。源代码中的 `config/` 是不含个人项目的模板。

如需另一位置，必须使用绝对路径，并在初始化、服务启动和客户端配置生成时保持一致：

```sh
export SANDBOX_MCP_HOME="$HOME/.sandbox-mcp-personal"
node bin/sandbox-mcp.mjs init
node bin/sandbox-mcp.mjs config readonly
```

也可给 CLI 使用 `--home /absolute/path/to/state`。生成的客户端配置会显式写入所选择的 `SANDBOX_MCP_HOME`。不要只在终端改环境变量，却继续使用客户端里旧的配置。不要将个人数据目录提交到 Git。

## 配置 readonly

添加一个已有项目目录：

```sh
node bin/sandbox-mcp.mjs add-project demo /absolute/path/to/your-project
node bin/sandbox-mcp.mjs doctor readonly
node bin/sandbox-mcp.mjs config readonly
```

把 `demo` 换成你希望客户端使用的项目 ID，把路径换成实际绝对目录。选择具体项目，不要登记整个用户目录。登记操作不修改项目里的文件。

生成的 `mcpServers` JSON 使用当前 Node 和 CLI 的绝对路径。将其合并到支持本地 stdio 的客户端设置，按客户端说明重新加载 MCP。不要把这一 JSON 当作所有客户端都通用的顶层配置文件；有的客户端需要复制其中的单个 server 条目。

连接后先调用 `project.list_projects` 取得实际 ID，再调用 summary、目录或精确文件读取。空项目列表表示尚未登记或当前项目都已停用，不表示协议握手失败。

readonly 默认排除 `.env`、常见私钥、凭据目录、`.git`、依赖目录等，并检查越界路径与逃出项目根的符号链接。策略不能识别所有敏感业务内容；开放项目之前仍应检查其中的导出文件和自定义凭据路径。只读工具权限在 Console 中管理。公开 `serve readonly` 入口不会因为旧配置中的 `restricted_write` 字段而开启写入工具。

移除登记：

```sh
node bin/sandbox-mcp.mjs remove-project demo
```

这会移除配置中的可见入口，不会删除项目文件。

## 配置 coding

```sh
rg --version
node bin/sandbox-mcp.mjs setup coding
node bin/sandbox-mcp.mjs doctor coding
node bin/sandbox-mcp.mjs config coding
```

`setup coding` 在 `runtime/desktop-commander/` 执行固定依赖安装：`npm ci --ignore-scripts --no-audit --no-fund`，随后运行 `prepare.mjs`。每次重装或升级该目录依赖后都应重新准备。版本或预期源码不符会停止，不能跳过检查直接视为可用。

coding 不需要 `add-project`；它使用当前用户权限。将客户端配置接入后，可以先读取一个自建的无敏感测试文件，再执行你明确需要的工作。文件参数使用绝对路径。进程在 MCP 内存中登记，重启后不能假定旧 PID 会话仍可通过工具继续读取。

同时输出两个 profile 的配置：

```sh
node bin/sandbox-mcp.mjs config both
```

在 GUI 客户端里不要依赖交互式 shell 的别名或相对路径。更换 Node 版本、移动源码目录或迁移全局包后，重新生成配置。

## Console 与 Monitor

```sh
node bin/sandbox-mcp.mjs console --open
node bin/sandbox-mcp.mjs monitor --open
```

Console 默认使用 `127.0.0.1:43127`。Monitor 默认选择可用本机端口并打印带 token 的 URL。两个入口都默认不开浏览器；这里显式使用 `--open`。需要固定端口时可加 `--port 43128` 等未占用端口。

Console 用于管理只读项目、工具权限与本产品服务；Monitor 是只读的工具活动视图。关闭前台服务器用 `Ctrl+C`。Console 与 Monitor 不是 MCP 协议 endpoint，也不是 ChatGPT 对话导出器。不要把它们反向代理到公网，也不要公开 Monitor token URL。

### 可选 macOS 窗口

在 macOS 13 或以上、已安装 Xcode Command Line Tools 的源码环境中，可以构建两个本地 launcher：

```sh
npm run build:mac
open "Sandbox MCP.app"
open "Sandbox Workbench.app"
```

`Sandbox MCP.app` 打开管理控制台；`Sandbox Workbench.app` 的显示名称是 Sandbox Monitor，提供只读监测窗口。只构建 Monitor 可用 `npm run build:workbench:mac`。

这些 App 使用本地 ad-hoc 签名，未 notarize，也不包含完整 Node 运行时。它们必须保留在安装源码目录中，依赖相邻脚本和已安装 Node；不能单独移动到 `/Applications` 后当作独立分发包。先按本页完成依赖安装和 `init`。需要自定义数据目录时，使用能显式传入 `SANDBOX_MCP_HOME` 的 CLI 入口最直观。

## 可选：安装全局命令

本项目不要求或声称已向 npm registry 发布同名包。不要通过不带来源的 `npm install -g sandbox-mcp-suite` 推断包的归属。

如果 [GitHub Releases](https://github.com/catking01/sandbox-mcp-suite/releases) 提供 npm 格式 `.tgz` 附件，先下载对应版本，再使用其明确的本机路径安装。例如：

```sh
mkdir -p "$HOME/.local"
npm install --global --prefix "$HOME/.local" --ignore-scripts \
  "$HOME/Downloads/sandbox-mcp-suite-0.1.0.tgz"
export PATH="$HOME/.local/bin:$PATH"
sandbox-mcp --version
sandbox-mcp init
```

把文件路径和版本改为实际下载的附件。GitHub 自动生成的 Source code 压缩包与 npm `.tgz` 是不同格式；源码压缩包应解压后按“从源码安装”操作。需要以后也能找到全局命令时，将上述 PATH 设置加入自己的 shell 配置。

安装后可直接使用 `sandbox-mcp setup coding`、`sandbox-mcp config both` 等命令。若已通过源码初始化相同的数据目录，已有个人配置会保留。

遇到 `EACCES` 或全局目录不可写时，使用上述用户可写 prefix，或保留源码方式。不要用 `sudo npm install`、修改系统 npm 目录权限或将凭据写入安装参数来解决。

## 可选远程连接与后台服务

本节只适用于需要远程客户端和 macOS 自动启动的用户。先完成本地 stdio 验证，再配置远程传输。

### 准备自己的 Tunnel

按 [OpenAI Tunnel Client 官方仓库](https://github.com/openai/tunnel-client) 的说明安装官方二进制、完成自己账户需要的授权，并创建或选择自己的 Tunnel profile。服务与账户是否可用由上游决定。本项目不提供现成身份、控制面 key 或共享 Tunnel。

当前传输回归基线为官方 [v0.0.21](https://github.com/openai/tunnel-client/releases/tag/v0.0.21)。这是已选择的测试版本，不是自动追踪最新版。其它版本应先做本地兼容验证。服务安装要求二进制绝对路径及已经存在的 profile 名称；不会代替上游账户开通流程。

不要把同一个 Tunnel 身份同时交给两个客户端进程。readonly 与 coding 应使用各自的适当配置，避免在不知道现有绑定的情况下重建身份。

### 凭据与 Keychain

可选择将控制面 API key 和 Tunnel ID 放在当前用户的 macOS Keychain 中。以下命令会交互式询问值；不要把值追加到命令中，也不要粘贴进终端录屏或 issue：

```sh
security add-generic-password -U -a "$USER" -s sandbox-mcp-coding-api-key -w
security add-generic-password -U -a "$USER" -s sandbox-mcp-coding-tunnel-id -w
```

也可通过 Keychain Access 创建 generic password 条目，service 使用上面的名称，account 使用当前登录用户的短名称（`id -un`）。服务安装只保存 service 名称引用，不读取或复制密钥。运行服务时才从该用户 Keychain 读取并放入 Tunnel 进程环境；MCP child 使用清洁环境，控制面凭据不向它传递。

如果不提供 Keychain 引用，你的 Tunnel profile 必须能够在 launchd 环境中无交互解析自己的凭据。当前终端的临时 `export` 不会自动传给 LaunchAgent。Keychain 尚未解锁或访问被拒绝时，应先解决用户会话与 Keychain 权限，不能据此认定远端 token 无效。

### 安装、检查、启动

以下示例生成 coding 服务；先将二进制路径、profile 名称和 Keychain service 名称替换成自己的值：

```sh
node bin/sandbox-mcp.mjs service install coding \
  --tunnel-binary /absolute/path/to/tunnel-client \
  --tunnel-profile your-coding-profile \
  --api-key-keychain-service sandbox-mcp-coding-api-key \
  --tunnel-id-keychain-service sandbox-mcp-coding-tunnel-id
node bin/sandbox-mcp.mjs service status coding
```

安装生成当前用户的本产品 LaunchAgent 和启动文件，**默认不启动**。检查安装输出与配置后再执行：

```sh
node bin/sandbox-mcp.mjs service start coding
node bin/sandbox-mcp.mjs service status coding
```

已经准备好并希望立即运行时，安装命令可显式追加 `--start`。停止、重新启动或移除服务：

```sh
node bin/sandbox-mcp.mjs service stop coding
node bin/sandbox-mcp.mjs service restart coding
node bin/sandbox-mcp.mjs service uninstall coding
```

readonly 用相同形式替换 profile 参数，并提供其自己的 Tunnel 配置。产品 label 按 profile 区分；不要把选择不同 `SANDBOX_MCP_HOME` 当成创建同名 LaunchAgent 多实例的方式。

生成的文件位于个人数据目录的 `state/services/readonly/` 或 `state/services/coding/`，日志位于 `logs/readonly/` 或 `logs/coding/`；LaunchAgent plist 位于当前用户的 `~/Library/LaunchAgents/`。安装记录保存于 `config/services.json`。遇到同 label 的未登记文件时，安装会拒绝覆盖；先确认文件归属，不要直接删除未知服务。

服务不自动继承维护者的代理或你当前 shell 的全部环境。如果你的连接需要代理，请按该 Tunnel 版本官方配置为自己的 profile 设置。不要照抄别人的本机代理端口。

生成的服务为本产品的标准 stdio server 显式启用官方 `--mcp.stdio-failure-policy exit` 和 `--mcp.stdio-send-initialized-notification=true`：child 失败由 Tunnel 非零退出后交给 LaunchAgent 恢复；初始化通知适配处理 legacy 重复握手期间的调用窗口，并避免重复通知 child。本地 stdio 客户端不需要这些 Tunnel 参数。相关行为已通过官方 v0.0.21 二进制与 loopback 控制面的隔离回归；不代表真实账户和所有远程并发都已验证。

v0.0.21 的 `--mcp.connection-max-ttl` 默认值是 `10m0s`，对应传输连接生命周期，环境变量名为 `MCP_CONNECTION_MAX_TTL`。用户 profile 可以覆盖该值；本产品服务不强制覆盖你的 TTL 策略。它与单次请求或客户端超时是不同预算。

真实业务等待受客户端和 Tunnel 的超时设置限制；coding 的 `read_process_output` 参数最多等待 60 秒，不等于每个远程客户端都会等待这么久。长任务使用短时间 `start_process` 加后续输出读取。超时不保证工具未执行，重试前先检查任务状态。

服务回归在 macOS 上使用临时 HOME、隔离 LaunchAgent 和测试 Tunnel，覆盖安装不启动、启动、重复启动保持同一 PID、停止、卸载与保留用户配置；这不验证你的账户授权、Keychain、代理或托管连接。启动后仍需在实际客户端执行一次只读探针，例如 `project.list_projects` 或读取自建测试文件。

## 升级与卸载

升级源码或替换 release 包前，先停止正在使用它的客户端 MCP 与本产品服务，确认没有需要保留的运行中任务。保留个人数据目录。更新依赖时继续使用 `npm ci --ignore-scripts --no-audit --no-fund`；启用 coding 的用户重新运行 `setup coding`，再运行对应 `doctor`。

如果 Node、包目录或启动路径改变，重新生成客户端配置，并重新安装自己的服务配置。不要把新版文件覆盖到旧进程下面后假定已生效；内存中的旧进程需要按计划重新启动。依赖升级可能改变工具 schema，客户端可能还需要刷新工具列表或新建对话。

卸载前逐个停止并移除自己安装的服务，然后从客户端删除对应 MCP 配置。全局包可执行：

```sh
npm uninstall --global --prefix "$HOME/.local" --ignore-scripts sandbox-mcp-suite
```

源码方式可在停止使用后移除自己下载的源码目录。服务卸载和包卸载不删除个人配置、日志、项目文件或 Keychain 条目；按需要单独清理。不要为了卸载产品删除已登记的项目目录。
