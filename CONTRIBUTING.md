# 参与开发

**English overview:** Include a concrete problem, a focused change and verification of the affected boundary. Keep personal state, credentials and machine-specific deployment files outside the repository.

## 开始

按 [安装说明](docs/INSTALL.md) 安装根目录依赖。修改 coding runtime 时再执行：

```sh
node bin/sandbox-mcp.mjs setup coding
```

新用户入口使用公开 CLI。调试底层模块可以直接调用源码，但不能依靠维护者电脑上的旧路径、Tunnel 身份、代理端口或研究工作区。

## 修改与验证

先确认失败发生在产品代码、测试、工具链、OS 权限还是网络边界，再修改对应实现。一个可复现失败和针对性回归通常比新增通用恢复器更有价值。

```sh
npm test
npm run test:commander
npm run test:workbench
```

按修改范围选择相关套件。真实 Tunnel 回归需显式指定自行安装的二进制：

```sh
TUNNEL_CLIENT_BINARY=/absolute/path/to/tunnel-client npm run test:tunnel
```

该测试使用临时目录、虚构凭据与 loopback 控制面，不应调用真实账户。不要为复现本地失败重启真实工作中的 MCP 或重放已有命令。

终端修改应检查取消等待与取消进程的区别、stdin 写入未知结果、Unicode 分片、多读者 cursor 和普通子进程清理。传输修改应检查并发响应归属、请求到期、晚响应及连接生命周期。

### 完整本地自检与 pre-push

提交或打包前，可以从源码工作树执行统一入口：

```sh
./ci/run selftest
```

[ci/run](ci/run) 每次重新执行根目录与 coding 目录的 `npm ci --ignore-scripts --no-audit --no-fund`，运行准备脚本，再运行 `npm run test:all`。macOS 上还会构建两个本地 App，因此需要 Xcode Command Line Tools。它会重建当前源码目录的依赖与 App，需访问配置的 npm registry；不要在正在承载工作任务的安装目录中无计划执行。

需要加入真实 Tunnel 二进制的隔离测试时，显式传入：

```sh
TUNNEL_CLIENT_BINARY=/absolute/path/to/tunnel-client ./ci/run selftest
```

未设置该变量会打印 Tunnel integration 未执行，而不是声称该部分通过。测试不调用模型、不启动或停止已有服务；Tunnel fixture 使用 loopback 控制面与虚构凭据，不使用真实 Tunnel 账户。功能自检不等同于依赖漏洞审计，`--no-audit` 仅控制安装期间的 npm audit 请求。

已有用户级或全局 `pre-push` hook 若按仓库的 `ci/run selftest` 约定分发，可直接使用这个入口。若手动接入，把下面的调用加入**已确认是本仓库**的 hook 分支，并保留原有检查：

```sh
"$repository_root/ci/run" selftest || exit 1
```

这里的 `repository_root` 应由自己的 hook 解析为仓库绝对路径。hook 应在自检失败时中止 push；它会执行当前工作树代码，只对自己信任的仓库启用。产品不会自动安装 hook、修改 `core.hooksPath` 或改变全局 Git 设置。

## 依赖与发布

`prepare.mjs` 对固定的 Desktop Commander 与 MCP SDK 源片段做幂等补丁。升级时检查实际上游 diff，再更新版本、锁文件、补丁与回归；不要删除严格版本检查以掩盖 patch mismatch。

安装继续使用 `--ignore-scripts`。新增 lifecycle script、下载器、后台服务或遥测，应在 PR 中解释行为和必要性。加入第三方代码片段时更新 [第三方声明](THIRD_PARTY_NOTICES.md)，保留许可。

PR 说明具体问题、改变后的行为和实际验证。将未验证平台、外部客户端限制和未复现现象分开写。不要把单元测试通过表述为长期稳定、系统隔离或全客户端兼容。

样例使用临时项目和虚构文件名。不得提交个人项目 allowlist、账户身份、真实 Tunnel ID、Keychain 值、token、日志、研究账本、下载缓存或 `node_modules`。`SANDBOX_MCP_HOME` 中的个人状态不应加入 release。

发布应从干净源码构建，检查 `npm pack --dry-run` 的文件清单，再安装实际 tarball，验证 README 的新用户路径。不要直接压缩维护者的运行目录。未发布 npm registry 时，使用明确的 GitHub source/release tarball，不给出隐式查询同名 npm 包的安装命令。

安全问题按 [SECURITY.md](SECURITY.md) 私密报告。
