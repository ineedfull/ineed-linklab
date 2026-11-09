# LinkLab 桌面与发布验收

构建、原生服务回环、桌面交互、安装包启动和公网下载分别验收。发行清单中的 `installation`、`runtime`、`signing` 状态不能因为文件摘要正确就改成通过。

## 2026-10-12 验收基线

产品代码提交 `2edf252ff99ac325f26292ca538e01775fdce940`，源码干净；版本仍为 `0.1.0`。本轮没有发布高于客户端版本的新版本。

- `npm test`：Node 1016、组件 216 全部通过；`npm run lint` 通过。
- `npm run package:desktop:mac`：Electron/Tauri 的 arm64/x64 四个 DMG 构建完成，清单目录为 `release/desktop/0.1.0-20261012T080253526Z-914d4113/`；`release:verify` 验证容器、大小、SHA-256 和完整矩阵通过。
- 四个 DMG 均通过 `hdiutil verify`、只读挂载、独立目录复制、应用身份/版本及 Mach-O 架构检查；两种架构的 Electron 安装包另通过现有 `verifyElectronMacPackage`，包括 renderer、原生串口模块和挂载内容一致性。
- Electron arm64：源码启动与实际安装包均完成本机 TCP 收发、连续三次重连、停止轮询保持生效、原生 Modbus 手动读取、真实 PTY 电表模拟器在后台响应、视图重挂载不重放、关闭重开不发送旧延迟响应，以及浅色/深色、普通/大字、侧栏展开/折叠的八种 1120×720 布局组合。实际取消打开检查覆盖 TCP、Modbus TCP 和 PTY 模拟器，取消后能重新打开。
- 实际安装包替换：用 2026-09-21 的 LinkLab Electron arm64 DMG 保存端点、深色/大字设置及真实 TCP 历史，再启动本轮 DMG，逐字段核对配置、设置、历史保留，并验证新包 GUI TCP 收发。两包均为 0.1.0，这是同版本安装包替换兼容检查。
- Tauri：独立测试标识的 debug `.app` 已原生启动，系统窗口信息确认 1120×720 主窗口，SQLite 完整性与迁移 1–5 正常。系统拒绝 osascript 辅助访问且屏幕采集权限为 false，完整 GUI 操作未验收。这不是当前生产 DMG 的完整启动/交互验收；生产应用标识另在四包检查中核对。

所有网络测试仅访问本机回环或 PTY。Electron 测试通过显式 `userData` 隔离配置；安装包测试还用外层 macOS sandbox 禁止访问真实 Application Support，为避免嵌套 sandbox 冲突，仅该测试启动关闭 Chromium sandbox。Tauri 测试用临时配置覆盖 identifier，未修改生产配置或真实用户数据库。

## 安装与签名边界

生产身份保持：Electron `com.ineedfull.dev-tool.electron`，Tauri `com.ineedfull.dev-tool`；数据库仍为 `ineed-dev-tool.db`。品牌改名不能改变既有存储身份。

四包均没有正式 Developer ID 签名与公证。arm64 的二进制含 ad-hoc 信息，但完整 `.app` 的 `codesign --verify --deep --strict` 报资源签名不完整；x64 未签名。不能把它们标记为可正式发行的签名包，正式签名后必须重新验证应用、重新封装 DMG、重新计算摘要。

Intel Mac、Windows、Linux 安装启动，实体串口、电表、长时间运行，以及 Tauri 实际安装包的完整 GUI 与旧数据替换，仍须在对应环境完成。构建目标存在不代表这些验收已通过。

## 发布顺序

1. 完成上述剩余原生与签名验收，确认发布版本、发行说明和回退方案；保留旧安装包与隔离升级前数据备份。
2. 在 146 打通下载域名 DNS、入站 80/443、有效 HTTPS 与 Nginx 代理，再验证单文件 GET/HEAD、Range、Content-Length 和下载 SHA-256。
3. `release:upload` 只上传到共享私有桶 `ineed-downloads` 的产品/版本/buildId 前缀，并回读校验。最终文件才可进入匿名只读的 `public/ineed-linklab/...`；不开放整个共享桶或写权限。
4. 网站只添加已通过公网 HTTPS 验证的文件，显示系统、架构、运行时、版本、SHA-256、签名状态与安装说明。Electron 的内存占用通常较高，用户可根据平台与验收范围选择运行时。
5. 发布高于客户端版本的清单后，才验收检查更新、下载和安装流程。0.1.0 的另一份构建不应提示存在更高版本。

2026-10-12 只读核对：MinIO 中 2026-09-21 的四个 LinkLab 测试包回读摘要与原发行清单一致；下载桶和图片桶均私有。下载域名仍解析到 47，HTTPS 证书域名不匹配；146 公网 80 请求超时，本机 Nginx 下载虚拟主机仍返回 503。产品下载页在线，但明确没有公开文件；`/updates/latest.json` 为 404。

## 自动更新实现前提

LinkLab 当前没有检查更新、自动下载或自动安装实现，也没有已发布的更新 JSON。后续任务应明确：

- Electron/Tauri 共用更新状态、版本选择及 UI；原生获取清单、打开下载入口或安装能力由各自 adapter 实现。
- 清单有产品、发布版本、运行时、系统、架构和文件完整性字段；错误产品、架构不匹配、旧版本、格式错误、超时与不可用链接不能提示可升级。
- 仅接受已验证 HTTPS 下载入口，下载完成后核对大小/摘要及运行时要求的签名；错误不能覆盖当前安装或用户数据。
- 如要全自动安装，应分别接入 Electron 和 Tauri 的更新机制、签名/公钥及相应产物格式。DMG 上传与打开下载页面本身不能作为自动安装验收。
- 用低版本隔离客户端完成一次完整升级，确认配置与历史保留；验证中断、失败恢复、当前最新版、不同架构及旧版本回退策略。
