# 第三方来源与许可

本仓库的适配层、CLI 和文档按根目录 [MIT License](LICENSE) 发布。第三方作品保留各自的版权与许可。本文件不将所有运行时依赖重新许可为 MIT，也不授予上游商标或服务权益。

## 主要依赖与来源

| 组件 | 固定版本 | 上游声明许可 | 使用方式 |
| --- | --- | --- | --- |
| `@wonderwhy-er/desktop-commander` | 0.2.48 | MIT | coding 的本地文件、搜索与终端实现；npm 安装后做局部适配 |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | coding 协议层；仍保留有效 `0` / 空字符串 request ID 的取消判断补丁 |
| `zod-to-json-schema` | 3.25.1 | ISC | 从依赖工具 schema 生成 MCP schema |
| `proper-lockfile` | 4.1.2 | MIT | 本地文件协调 |
| `sharp` | 0.35.5 | Apache-2.0 | 仅覆盖 Commander 0.2.48 的此项传递依赖；平台包保留各自许可 |

执行依赖以根目录和 `runtime/desktop-commander/` 下的锁文件为准。npm tarball、锁文件和上游 Git checkout 是不同交付物；固定版本不意味着它们逐字节一致。

已核对的 Desktop Commander 源码参考为 [20a3ecc163d74bfc49cba0ca94a89ccb7ed58506](https://github.com/wonderwhy-er/DesktopCommanderMCP/tree/20a3ecc163d74bfc49cba0ca94a89ccb7ed58506)。完整许可也保存在 [UPSTREAM-LICENSE](runtime/desktop-commander/UPSTREAM-LICENSE)。SDK 1.32.2 的 npm 元数据指向 gitHead `3b73021a0a2272c0c04c3917bcdb03398b3ec63f`；已核对该固定源码的 [LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/3b73021a0a2272c0c04c3917bcdb03398b3ec63f/LICENSE) 与实际安装包中的许可。下面保留两份许可，覆盖准备脚本中来自相应实现的改写片段。

Commander 继续使用其兼容的 Zod 3.25.76，SDK 使用 Zod 4.6.7；两者均为 MIT。当前锁定依赖仍存在已知安全告警，见 [依赖安全状态](SECURITY.md#依赖安全状态2026-11-25)。许可核对不等于安全审计通过。

## 安装和再分发范围

源代码及 npm 格式发布包不应携带 `node_modules`、下载缓存、浏览器、Tunnel 二进制或其它供应商运行时。使用者按锁文件或上游说明单独获取；安装时保留各包原有 LICENSE/NOTICE。

传递依赖包含 MIT、ISC、Apache-2.0、BSD 及其它许可。`@img/sharp-libvips-*` 等平台包标注 LGPL-3.0-or-later；部分 sharp 平台包具有组合许可。`buffers@0.1.1` 锁文件条目未标注 license，不能据此断言它没有许可或可任意再分发。若制作包含依赖或本机二进制的独立应用、离线安装器或容器镜像，应重新核对实际打包集合、原包许可及对应来源要求；本文件不是该类完整二进制分发的许可清单。

安装采用 `npm ci --ignore-scripts`，随后显式运行本仓库 `prepare.mjs`。当前锁文件标记 `hasInstallScript` 的包为 Desktop Commander 0.2.48、Puppeteer 25.18.1 和 fsevents 2.3.3；Desktop Commander 上游安装脚本包含 tracking 与 ripgrep 检查。sharp 0.35.5 不再具有这一标记，但仍通过平台依赖获取原生图像组件。跳过脚本不改变许可或消除所有依赖行为，某些文档、浏览器及原生扩展能力不在本项目的已验证范围内。

可选 [OpenAI Tunnel Client](https://github.com/openai/tunnel-client) 是独立项目，用户自行安装；本仓库不包含其二进制或转授服务账户。使用或再分发时应查看该版本上游 LICENSE、NOTICE 和依赖说明。

## Desktop Commander — MIT License

Copyright (c) 2024-2025 Eduard Ruzga and Desktop Commander Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## MCP TypeScript SDK — MIT License

Copyright (c) 2024 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
