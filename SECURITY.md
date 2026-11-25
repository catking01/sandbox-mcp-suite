# 安全与隐私

**English overview:** `readonly` exposes admitted project evidence; `coding` can read files and execute commands with the current OS user's permissions. This product is not an OS sandbox. Report vulnerabilities privately when possible; never post credentials or private files in an issue.

## 权限边界

| 入口 | 边界 | 适用场景 |
| --- | --- | --- |
| `serve readonly` | 仅登记项目及文件策略允许的读取；公开 CLI 固定为只读工具 | 源码审阅、证据核查、Git 状态与差异读取 |
| `serve coding` | 当前 OS 用户可访问的文件、命令和进程；没有项目目录 allowlist | 编辑、运行、调试和本地工作台 |
| Console | 本机配置管理；可修改项目登记与管理本产品的服务 | 用户主动配置 |
| Monitor | 本机活动状态读取；无文件编辑、终端执行或模型调用接口 | 查看工具状态和显式发布的进度 |

名称中的 Sandbox 不表示容器、虚拟机、系统权限隔离或防恶意代码执行环境。coding 的工作目录只是当前操作位置，不能阻止工具访问其它目录。需要更强隔离时，应由使用者在单独 OS 用户、容器或虚拟机中运行，并独立验证该运行方式。

readonly 检查项目登记、允许文件模式、拒绝模式及路径边界。它不能判断每一份已允许文件是否包含商业秘密；项目中的私钥、环境文件、导出数据和备份仍需要正确排除。读取到的本地 Git 或测试记录也不证明远端 GitHub、CI 或生产环境的状态。

MCP 工具的描述和 `readOnlyHint` 等注释不代替访问检查。客户端应把仓库内容、工具输出和网页视为数据，不能让其中的指令扩大用户授权。

## 数据保存与传输

个人配置和状态默认位于 `~/.sandbox-mcp`，可用 `SANDBOX_MCP_HOME` 指定另一目录。不要把这个目录放进公开仓库。

- 项目配置包含本机绝对路径；只读调用记录可能包含项目标识、路径、决策和错误信息。
- coding 的活动记录包含工具名称、状态和耗时。经 `workbench_sync_publish` 显式发布的文本也会写入活动记录。
- Monitor 的活动记录是有容量限制的本地视图，不是永久审计档案。它不读取完整 ChatGPT 历史、内部推理或真实模型 Token 用量。
- 终端会话和输出主要保存在 MCP 进程内存中。服务重启会丢失这些会话索引；外部任务是否仍在运行需单独核对。
- 将工具接入模型客户端后，返回的文件内容和命令输出会交给该客户端；远程连接还经过对应传输服务。数据规则由用户选择的客户端与服务提供方规定。

本适配层关闭 Desktop Commander telemetry，并直接加载所需本地 handlers。安装时跳过依赖生命周期脚本；这不表示所有依赖或用户启动的命令都无法联网。安装 npm 依赖、下载 Tunnel、使用远程客户端及运行联网命令均可能产生网络通信。

## 依赖安全状态（2026-11-25）

对 coding 锁定依赖树执行 `npm audit --json` 后，仍有 **6 条告警：0 critical、2 high、4 moderate**，包含沿依赖链传播的条目，不是 6 个互不相关的底层漏洞。SDK 已升级至 1.32.2，Commander 0.2.48 的 sharp 已定向覆盖为 0.35.5，并更新兼容的传递依赖；不能将这些修复或功能测试通过表述为零已知漏洞。

同日，对 readonly 所需的根目录依赖执行 `npm audit --omit=dev --json` 返回 0 vulnerabilities；这一结果不包含独立 coding 依赖树，也不是整体产品无漏洞的证明。

| 剩余条目 | 当前范围与处理 |
| --- | --- |
| Zod 3.25.76 与继承其告警的 Commander：2 high | [超大集合校验导致资源耗尽](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)。公开工具中的 `read_multiple_files.paths` 在 Zod 解析前限制最多 100 项，并在发现 schema 中声明 `maxItems: 100`。回归覆盖 100000 项非法输入被拒绝后，100 项有效输入及普通文件读取仍可成功。Zod 3 包本身尚未修复。 |
| glob 10.5.0、minimatch 9.0.9：2 moderate | [glob 取消后仍继续遍历](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) 与 [minimatch 模式放大](https://github.com/advisories/GHSA-g3hv-75wg-m249)。当前 Commander dist 未导入这两个告警版本，公开搜索实现使用 ripgrep；这是对当前源码路径的审查，不是删除告警或对未来版本的保证。 |
| uuid 8.3.2 与继承其告警的 ExcelJS 4.4.0：2 moderate | [带输出 buffer 的 v3 / v5 / v6 边界问题](https://github.com/advisories/GHSA-w5hq-g745-h8pq)。当前 ExcelJS 调用仅使用无参数 `v4()`，不符合该公告的触发条件；相关依赖仍保留在安装树中。 |

上述 100 项限制只缓解一个集合解析入口，不是全协议请求大小限制，也不代表整体免于 DoS。上游文件 handlers 仍包含文档处理路径，例如 `write_file` 对 `.pdf` 可进入 Markdown / Puppeteer 处理；没有单独暴露 `write_pdf` 不表示不存在文档或浏览器依赖。告警与可达性判断以这次依赖和代码为范围，升级后应重新核对。

## 安装与凭据

使用 [安装说明](docs/INSTALL.md) 中的 `--ignore-scripts` 路径，再显式执行本仓库的准备步骤。上游 Desktop Commander 安装脚本包含 installation tracking；部分文档依赖也有浏览器下载或本机安装脚本。不要为绕过准备失败直接执行所有依赖脚本。

核心 stdio 服务不需要 API key。可选 Tunnel 使用每位用户自己的账户、Tunnel 和凭据。不要把 token、密钥或真实 Tunnel 配置写进源码、issue、截图或提交历史。后台服务保存 Keychain 引用；控制面凭据不应传入 coding 的清洁子进程环境。

Console 与 Monitor 仅绑定 loopback，并对相关操作检查本地 token、Host 或 Origin。不要将管理页面反向代理到公网。带 Monitor token 的本地 URL 也不应公开分享。

## 取消与重试

`start_process.timeout_ms` 控制首次等待输出时间，不是执行总时限。取消一次等待，不表示已撤回命令。stdin 写入超时时，已交给 pipe 的字节无法撤回，结果会明确为 delivery unknown；不要盲目重放付款、部署、删除或其它不可重复操作。

适配层清理自己创建的普通进程组。主动脱离进程组或另建 session 的 daemon 不属于完整清理保证。MCP、直接父进程及已知 Tunnel PID 受专用终止工具保护；这不是对通用 shell 的系统级隔离。

## 报告漏洞

优先使用 [GitHub 私密漏洞报告](https://github.com/catking01/sandbox-mcp-suite/security/advisories/new)。若仓库未启用该入口，先开一个不含利用细节、个人文件或凭据的 issue，请维护者提供私密报告方式。

报告包含版本、操作系统、profile、最小复现及预期/实际行为；路径和凭据换成虚构示例。若凭据已经暴露，应先在提供方撤销；删除 issue 文本或 Git 文件不能撤回已公开的值。

当前版本面向个人 macOS 工作流。测试和有限真实部署验证不代表多租户隔离、渗透测试完成、生产 SLA 或无限期稳定性保证。
