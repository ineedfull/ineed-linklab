# LinkLab 现有功能维护与验收

日期：2026-10-12。范围为现有功能的正常操作、异常处理、连接生命周期和数据保存；没有增加协议、自动更新或新的产品入口。起始源码为 `9e224c3`，此前 R1–R5 修复与安装包验收见 [发布准备记录](release-acceptance.md)。

2026-10-14 的完整审查 L1–L12 修复、后续复核边界和当前验收记录见
[完整审查修复](full-review-fixes-2026-10-14.md)。下文测试数字保留为 2026-10-12
的历史结果，不作为后续工作树的当前门禁。

## 功能矩阵

下表的“本轮验证”来自修改后的源码。浏览器预览、原生服务和实际桌面窗口分别记录；配置了打包目标不代表相应系统已经验收。

| 已有功能 | 本轮验证 | 维护重点与边界 |
| --- | --- | --- |
| 端点新建、编辑、删除、分类筛选与选择 | EndpointDialog/Row/Tree 组件、workbenchModel、configPersistence 和 SQLite 测试；双端浏览器工作台回归 | 端点 ID、打开意图、连接会话各自独立；原有配置保留，编辑/删除不能被旧加载恢复 |
| 串口、接收分帧与发送编码 | 两端真实 PTY：raw、delimiter 跨片段、fixed、idle、设备移除、历史落盘、资源释放；发送 text/hex/json 编码与编辑器用例 | PTY 为本机虚拟串口；实体串口驱动、串口参数和设备仍需现场验收 |
| TCP 客户端/服务端与多连接 | 两端原生回环、双向跨运行时互通、peer 身份；Electron 桌面实际收发 | 回环测试限定 `127.0.0.1`，没有扫描现场网络 |
| UDP 客户端/服务端与对端选择 | 两端原生回环和双向互通；共享目标/报文测试 | 保持报文边界；广播、设备网络环境不在本次现场验收范围 |
| TCP 自动重连、定时发送 | 原生 TCP 三次重连/取消/清理；scheduledSender 代次、串行发送与停止测试；Electron 桌面有限次数发送恰好 3 次 | 旧连接完成不能恢复任务；配置与当前会话共同决定发送资格 |
| 发送模板和发送历史 | 组件经 structured clone 边界测试；Electron 桌面保存、重命名、载入、删除与 SQLite 校验；双端浏览器回归 | 修复重命名时嵌套 Vue proxy 不能通过 Electron IPC；载入模板或历史不会自动发送 |
| Modbus 主站、从站、读写、诊断和趋势 | 调度/写入确认/主从服务/趋势与历史契约；Electron↔Rust TCP/RTU 实际互通；双端浏览器工作流 | 延续已修复的会话绑定和用户停止轮询约定；补齐趋势视图立即卸载时的资源释放 |
| DL/T 645 主站与模拟器 | 编码、配置、事务、模拟器生命周期；主站 20 项组件测试；Electron 桌面 PTY 抄读、BCD 解码、带未完成请求的重连及新请求 | 主站按会话清除请求、超时和残留字节；只接收当前会话的读数据响应，异常回复须匹配电表与功能码。轮询仍由主站视图拥有，卸载即停止；模拟器继续由模型拥有 |
| 消息/日志历史、过滤、分页与清理 | 两端 SQLite 契约；真实队列尚未落盘时立即查询测试；错误/分页/重试组件用例；Electron 原生历史窗口搜索与空结果 | 查询前刷入原生待写历史；控制器发布新快照以刷新界面；失败保留选中记录并提供重试 |
| 工作区导入导出、设置、存储与退出 | 两端无效导入/事务回滚测试；Electron 桌面 JSON 往返、导入后重新连接、设置同步和清理；原有 shutdown/迁移测试 | 先完整校验输入及模板引用，再关闭连接、刷盘和导入；保留 merge/upsert 语义。历史清理保留端点、模板和设置 |

## 本轮修复

| 编号 | 可复现问题 | 修复与回归 |
| --- | --- | --- |
| E1 | DL/T 主站断开/替换会话后，旧发送完成或超时继续占用抄读状态；卸载后还能创建计时器 | 请求捕获独立身份、会话和超时；断开/替换/卸载立即失效。原生请求携带 `expectedSessionId`，旧帧及半帧不进入新会话 |
| E2 | 其他电表或其他功能的回复结束当前读请求；编辑中的非法小数位可能令解码抛错 | 匹配功能码、地址、DI；校验原始数字草稿后才发送/解码，拒绝空值、非整数及非法类型，保留旧配置缺省值。无效草稿不会阻塞后续恢复后的抄读 |
| E3 | 保存 DL/T 配置期间继续编辑，旧保存完成将新修改误标为已保存 | 保存捕获草稿 revision，只清除对应 revision 的 dirty 状态 |
| E4 | 历史查询失败时界面未刷新，并向 Vue 事件处理传播异常 | 每次控制器通知产生新展示快照；UI 接住失败，保留选中记录并可重试 |
| E5 | 刚发送完打开历史，批量持久化还未完成，首屏可能为空 | Electron/Tauri 消息和日志查询均先经过原生持久化 flush 屏障；真实 SQLite 队列回归覆盖 |
| E6 | 文件 schema 正确但内容无效的导入，先关闭全部连接再报错 | 两端预校验字段、设置、时间戳、模板载荷及端点引用；无效输入保留连接和数据库，有效导入仍执行 close→flush→事务 |
| E7 | Electron 模板重命名报“对象无法克隆” | 发送资料库提交模板前复制 JSON 快照，包括嵌套 target；测试模拟真实 structured clone 边界并验证桌面操作 |
| E8 | 趋势视图挂载后立即卸载，nextTick 后才登记观察器和执行查询 | nextTick 后检查卸载状态，避免留下观察器或启动无效查询 |

以上修复均先复现失败再验证通过。独立复核发现数字草稿被归一化掩盖的 E2 边界，补齐校验和回归后复核通过，未发现其他具体回归。旧的 Tauri 源码字符串检查不能表达新的导入流程，已由真实 Rust/SQLite 的输入校验与连接屏障测试接替该项检查。

## 验证结果与重跑入口

在仓库根目录运行：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 最终全量 Node 1018/1018；组件 245/245 |
| `npm run lint` / `npm run build` | 通过；两端 renderer 构建通过，原有 ECharts 大块体积提示仍存在 |
| `cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check` | 通过 |
| `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml` | 167 通过，4 项原生集成入口默认 ignored，下面分别实际执行 |
| `npm run test:e2e` | 双端浏览器、三个窗口尺寸，126/126；模板、历史和 DL/T 按范围复跑 33/33；最终数字校验修复后 DL/T 再跑 12/12 |
| `INEED_VERIFY_BUILD=1 node --test apps/electron/tests/electronBoundary.test.js apps/tauri/tests/tauriBoundary.test.js` | 构建产物边界 57/57 |
| `INEED_ALLOW_PTY_SKIP=0 node tooling/serial-test/pty-loopback.mjs` | Electron/Tauri 实际 PTY 通过，子进程清理完成 |
| `node tooling/tcp-test/localhost-loopback.mjs` / `node tooling/udp-test/localhost-loopback.mjs` | 两端及双向互通通过，managedChildren=0 |
| `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml electron_and_rust_cross_runtime_tcp_and_rtu -- --ignored` | Modbus TCP/RTU 双向互通通过 |

补跑浏览器指定范围：`npm run test:e2e -w @ineed-linklab/workbench -- --grep 'saves templates|history|DL/T'`。

Electron 另外使用当前生产 renderer、真实 preload/native IPC 与独立 userData，完成表中的 11 项桌面流程；截图检查 1120×720 的浅色/深色、普通/大字、侧栏展开/折叠共 8 种 DL/T 主站状态，无页面溢出，无 pageerror。导入导出的文件选择返回由测试提供隔离路径，实际文件读取、原子写入、校验、SQLite 事务及界面刷新均使用产品实现；没有测试操作系统文件选择器的手动交互。

本机脚本、日志与截图放在工具工作区 `scratch/2026-10-12-linklab-existing-features/`，属于可重建证据，不随源码发布。此轮没有重打安装包、上传、发布或调整网站/MinIO。

## 保留的验收边界

- Tauri 原生服务与数据库、共享浏览器界面已验证；完整 Tauri 桌面 GUI 仍受此前辅助访问/屏幕权限限制，不能据此宣称已验收。
- Windows/Linux 安装运行、macOS x64 实机、实体串口/电表、现场网络与设备均需对应环境验收。
- 本轮结论是现有功能的本机维护与回归完成。正式分发所需的签名、下载入口与安装包验收仍沿用发布准备记录，不包含在本轮范围内。
