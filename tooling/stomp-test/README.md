# STOMP 本地验证脚本

这些入口使用回环网络和独立测试配置，不发布或生成安装包。全部命令从 LinkLab 仓库根目录执行。脚本结果以本次退出码、`summary.json` 和对应原始日志为准；命令存在不等于本轮已经通过。产品操作与限制见 [STOMP 工作台](../../docs/stomp-workbench.md)。

## 组件、协议与原生入口

```sh
node --test packages/workbench/tests/stomp*.test.js apps/electron/tests/stompTransport.test.js
npm run test:components -w @ineed-linklab/workbench -- StompPanel.test.js
npm run test:e2e -w @ineed-linklab/workbench -- stomp.spec.js
cargo test --locked --offline --manifest-path apps/tauri/src-tauri/Cargo.toml stomp --lib
cargo build --locked --offline --manifest-path apps/tauri/src-tauri/Cargo.toml --bin stomp-harness
```

JavaScript 协议/控制器测试覆盖字节编解码、本地 broker 与真实回环 WebSocket；组件测试覆盖操作控件以及历史清空/淘汰后保留 ACK/NACK。浏览器 e2e 用显式 bridge fixture 检查配置、页面保留、主题/字号/侧栏和窗口尺寸，不代表原生连接或平台安装验证。

`stomp-harness` 是已有 Rust 二进制的无 GUI 验证入口，通过 stdin/stdout NDJSON 接收 `{"id":1,"request":{...}}` 并返回 result/error，原生事件通过 event 行返回。直接运行没有共享 STOMP broker 逻辑；该逻辑由 JavaScript 控制器负责。

## 独立 SDK 与双运行时原生互通

```sh
LINKLAB_STOMP_OUT=/absolute/path/to/fresh-native-output \
LINKLAB_STOMP_MS=300000 \
node tooling/stomp-test/native-interoperability.mjs
```

- `native-bridge.mjs` 只供验证使用：Electron 直接调用当前 `StompTransport`，Tauri 启动 `apps/tauri/src-tauri/target/debug/stomp-harness`。运行前需完成上面的 Rust 构建，脚本不会自动构建。
- `native-interoperability.mjs` 默认持续负载 300,000ms，可用 `LINKLAB_STOMP_MS` 修改；设为 0 仍会做一轮发送，仅适合连通性快检，不能当成持续负载。
- 两个运行时分别担任 server，另一端共享控制器担任 client，同时接入独立 `@stomp/stompjs` 客户端。脚本校验本地 ws 协议互通、UTF-8/NULL、topic 广播、queue 轮转、手动确认、回执、顺序完整性、重启重连及订阅恢复，并校验保存配置排除认证值。
- Electron 设置证据使用隔离的真实 SQLite；该脚本的 Rust 设置部分是内存 fixture，真实 Rust SQLite 配置边界由 Rust 测试另行覆盖。报告的 `settingsEvidence` 标明两者差别。
- 输出 `summary.json`，含 checks、pressure 时长/发送与 SDK 收到次数、设置边界证据及清理结果。测试子进程和网络会话在脚本结束时关闭，证据目录保留。

此入口没有启动桌面 GUI，也没有验证 wss、生产 broker、安装包或其它操作系统。结果中 shared workbench 指共享控制器，不表示用户实际看到了工作台页面。

## Electron ↔ Tauri 真实桌面

统一端点目录也有不依赖桌面的真实原生检查：

```sh
LINKLAB_STOMP_CATALOG_OUT=/absolute/path/to/fresh-catalog-output \
node tooling/stomp-test/catalog-native.mjs
```

此入口在每个运行时同时建立一个 broker 和三个客户端，核对第五个原生会话受控拒绝、topic 完整投递、删除一个客户端后另外两个的会话 ID 不变并继续接收、释放名额可复用及保存不含凭据。Electron 使用真实 SQLite，Rust 设置使用内存 fixture；OPC UA 仅提供空配置源，不测试其网络。它不启动 GUI，不能代替下面的桌面验收。

先构建最新共享界面，再单独运行桌面脚本。不要同时运行其它会切换或覆盖应用窗口的 GUI 验证。

```sh
npm run build
LINKLAB_STOMP_DESKTOP_OUT=/absolute/path/to/fresh-desktop-output \
LINKLAB_STOMP_DESKTOP_MS=120000 \
LINKLAB_STOMP_DESKTOP_IDLE_MS=180000 \
node tooling/stomp-test/desktop-duel.mjs
```

`desktop-duel.mjs` 面向当前 macOS 本机环境：启动品牌 Electron 宿主和真实 Tauri WKWebView，以隔离 Electron profile 和 Tauri application identifier 加载已构建界面；脚本通过页面操作配置、连接、订阅和发布。两端交换 client/server 角色，独立 SDK 观察 topic 全量消息；持续负载直接调用已连接桌面宿主的原生发送入口，不能描述成每条消息都由人工点击发送。

| 环境变量 | 当前默认值与含义 |
| --- | --- |
| `LINKLAB_STOMP_DESKTOP_OUT` | 系统临时目录下新的 `linklab-stomp-desktop-*`；保存脚本证据 |
| `LINKLAB_STOMP_DESKTOP_MS` | 120,000ms，**每个角色方向**各跑这段负载，两个方向约 4 分钟加准备时间 |
| `LINKLAB_STOMP_DESKTOP_IDLE_MS` | 180,000ms，在两个方向结束、断开连接后观察；前三分之一保留视图，清空视图后再观察余下时间 |
| `LINKLAB_STOMP_DESKTOP_BATCH` | 16，每批发送数，允许整数 1–256 |
| `LINKLAB_STOMP_DESKTOP_PAUSE_MS` | 200，每批后的暂停毫秒数，允许 0–10,000 |
| `LINKLAB_STOMP_VERIFY_FORM` | 设为 `1` 时，在两端实际订阅界面核对浅/深色及普通/大字的输入框与选择框高度、顶部对齐；保存原生尺寸 JSON |
| `LINKLAB_DUEL_RESOURCE_HELPER` | 可选可执行文件，输出资源 JSON；记录原生进程及关联进程资源 |
| `LINKLAB_DUEL_WINDOW_HELPER` | 可选可执行文件，输出原生窗口 JSON；开始时接收两个宿主 PID，脚本检查窗口在屏幕上、未隐藏且未最小化 |

例如需要每个方向 10 分钟、合计至少 20 分钟负载与 3 分钟静置时，设置 `LINKLAB_STOMP_DESKTOP_MS=600000` 和 `LINKLAB_STOMP_DESKTOP_IDLE_MS=180000`。以 `summary.json` 中两个 `stages[].loadMs` 的实际总和为准。

脚本通过统一的添加端点对话框创建连接，每个负载方向始终保持两个原生客户端及一个独立 SDK 客户端。分别核对服务端、两个原生客户端和 SDK 的完整消息顺序；原生流按连接 ID 检查无遗漏/重复，并在 `stages[].nativeStreams` 保存数量与 SHA-256。删除额外客户端后，主客户端继续执行清空历史后的 ACK/NACK 与重投。另检查页面无异常、消息行数上限、设置保存保留配置及临时凭据不落盘。两个真实本地 OPC UA 测试服务器用于验证每个应用同时保持两份独立会话及订阅，两份订阅的值都实际推进，删除一份后另一份仍能读取。

测试观察器会保留每条原生负载消息的字符串和计数，以便结束时核对完整序列，因此负载期间的内存包含这部分测试开销。普通采样只返回计数，避免反复传输全量序列；静置期间清空所有已访问的 STOMP 消息面板及观察器，再在同一进程中采样。没有强制 GC、页面重载或重启；不能将这轮带观察器的内存直接当作日常产品基线，也不能用一次有限长跑证明不存在泄漏。

`summary.json` 记录两个角色方向、多端点、OPC UA 与 SQLite 检查及静置参数，`samples.jsonl` 记录各阶段数据、页面 timeOrigin/visibility、可选资源和窗口证据；另外保留 Electron 截图、Tauri 日志及隔离配置。先确认桌面已解锁；锁屏会使 WebView 的可见性检查失败。

采样核对实际前台端点名称与脚本选中端点一致；手动切换端点会使后续运行停止，避免将后台收发误报成前台渲染压力通过。

失败时另保存 `failure-desktops.json`；页面操作异常包含最近最多 100 条原生状态及当前端点/连接标识，帮助区分会话已关闭与消息校验错误。退出阶段在关闭 Playwright 应用前保留子进程句柄，避免关闭后访问已释放的 dispatcher 而丢失清理结果。

未提供原生窗口 helper 时，页面的 `visibilityState` 不能单独证明窗口没有被其它应用遮挡；也不能据此声称完成了完整原生窗口可见性验收。资源 helper 缺省时不产生完整资源证据。窗口 helper 依赖资源 helper 识别真实 Tauri 宿主 PID，两者需要一起配置；缺失时在启动桌面前明确报错。长跑前应确认本次所需 helper 已准备、窗口布局及人工观察条件已满足，并保持其它 GUI 验证串行。

这个桌面负载入口的持续发送使用 auto 订阅与 topic；手动 ACK/NACK 为单独的有限操作检查，不能替代恶意输入矩阵、队列压力或真实 TLS 的专项验收。脚本会关闭自己启动的窗口/进程并保留证据，但不会删除既有用户配置。

## 验证记录边界

### 单独的内存诊断

`LINKLAB_STOMP_MEMORY_CYCLES=3` 会选择独立的固定消息数分支：每轮交换双端角色，每方向 1 服务端、2 原生客户端、1 SDK，断开、清空、自然静置后删除全部测试端点。同一桌面宿主继续下一轮；此分支不执行原正式长跑的 OPC UA、SQLite 和 ACK/NACK 矩阵，不代替 20 分钟功能压力验收。

```sh
LINKLAB_STOMP_MEMORY_CYCLES=3 \
LINKLAB_STOMP_MEMORY_MESSAGES=32768 \
LINKLAB_STOMP_MEMORY_IDLE_MS=60000 \
LINKLAB_STOMP_MEMORY_OBSERVER=bounded \
LINKLAB_STOMP_DESKTOP_BATCH=32 \
LINKLAB_STOMP_DESKTOP_PAUSE_MS=50 \
LINKLAB_STOMP_DESKTOP_OUT=/absolute/path/to/fresh-memory-output \
node tooling/stomp-test/desktop-duel.mjs
```

观察器可选 `full`（完整正文）、`bounded`（默认；每连接仅计数/最后序号/前缀/错误，逐条全序校验）、`off`（不观察原生完整流，仅 SDK 全序及界面尾项到达）。`memory-observer.test.mjs` 单独通过 `node --test tooling/stomp-test/memory-observer.test.mjs` 执行。资源/窗口 helper 与前述正式入口相同。每轮创建新端点，只复用宿主，不能称为同一 controller 的反复连接验证。

macOS 活跃堆诊断另行显式配置 `LINKLAB_MEMORY_PROBE_LIBRARY` 为编译后的 `tooling/soak-test/macos/heap-probe.m` 诊断库绝对路径、`LINKLAB_MEMORY_PROBE_DIR` 为新的私有请求目录。专用 `memory-runner.mjs` 仅在隔离宿主的最后一次原生 exec 设置 `DYLD_INSERT_LIBRARIES`，避免 macOS 系统启动器移除该变量；库不注入 Electron。脚本还采集 Electron CDP 堆、WebContent 的 `vmmap -summary` / `heap -s`，可用 `python3 tooling/stomp-test/analyze-heaps.py <证据目录>` 汇总。不要把诊断库链接进产品或安装包。

**堆快照会触发 GC、打开 Inspector 并改变资源。** 该运行必须与自然回收对照分开记录，`after-diagnostic-gc` 样本不作为自然回收证据；JS 活跃堆估算不能直接代表 RSS 或全部原生分配。原生工具权限失败会保留错误文件，不能视为已完成分配归因。

本说明只记录当前脚本行为与复现命令，没有登记本轮通过数量、最终压力时长或跨平台通过结论。最终交接应分别记录浏览器预览、无 GUI 原生协议、真实 Electron/Tauri 桌面、安装包启动和目标操作系统；保留未覆盖的生产 broker、TLS、现场网络与长期运行边界。不要把 WebSocket 的另一轮长跑记录当成 STOMP 长跑结果。

2026-10-22 的实际结果与高压故障见[多协议压力记录](../../docs/protocol-soak-verification-2026-10-22.md)。常规节奏和提高压力后的结果分别记录；降低发送节奏的对照通过不能代表高压问题已修复。
