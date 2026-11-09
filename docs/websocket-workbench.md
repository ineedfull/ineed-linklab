# WebSocket 工作台

Electron 与 Tauri 都在现有 **添加端点** 中提供 WebSocket 客户端和服务端，复用侧栏、发送区、消息历史、模板及日志。两端共用界面，各自原生处理网络连接，不依赖浏览器 WebSocket 的请求头限制。

## 使用

1. 添加 **WebSocket 客户端**，填写 `ws://主机:端口/路径` 或 `wss://主机:端口/路径`，按服务器要求填写子协议及请求头，保存后打开。URL 不接受用户名密码或片段标识。子协议为逗号分隔的唯一 HTTP token，最多16项、每项128字节。
2. Authorization、Cookie 等自定义请求头只留在当前应用进程内存；编辑端点可以恢复，自动重连继续使用。退出后需重新填写；删除端点或成功导入工作区会清除。请求头不保存到端点、SQLite 或配置导出，也不写入诊断事件。最多32项、单值4096字节、合计16KiB，禁止重复、换行和 Host / Connection / Upgrade / Sec-WebSocket-* 等握手保留头。
3. 添加 **WebSocket 服务端**，配置监听地址、端口及路径。默认 `127.0.0.1:9000/`，只接受指定路径；配置子协议时必须有匹配项。展开端点查看客户端，选择一个或多个客户端发送，也可广播或单独断开；单个客户端离开不会关闭监听。此版最多64个已连接或正在握手的客户端。
4. 发送区 Text / JSON 默认发文本消息，HEX 默认发二进制消息，也可明确覆盖消息类型。文本必须是有效 UTF-8；一条发送就是一条完整 WebSocket 消息，不追加 CRLF，不使用 TCP 的流式分帧。单条消息最多1MiB。消息列表 TXT / BIN 表示实际类型，历史和模板按实际类型保留文本或字节。
5. 可按需启用 Ping/Pong 心跳，默认关闭，间隔30秒、等待10秒，可配置范围均为1–60秒。心跳控制帧不进入业务消息历史。客户端可启用自动重连，沿用现有指数退避；主动关闭、删除、导入或退出会停止重试。
6. 日志和会话状态显示关闭码及经过处理的关闭原因。为避免远端回显令牌片段，客户端只要带自定义请求头或非空 URL 查询参数，就隐藏整段远端关闭原因，仍显示关闭码。

## 安全与数据

`wss` 客户端校验系统信任链和主机名，没有跳过证书校验的开关。Electron 使用其 Node TLS 信任来源，Tauri 使用系统根证书；自建 CA 应按对应运行环境配置。首版服务端提供明文 `ws` 本地监听；如需对外提供 `wss`，由已有反向代理终止 TLS。修改监听地址会改变可访问范围。

会话内请求头适合携带认证信息。URL 本身会作为端点配置保存和导出，**不要将需保密的令牌放进 URL 查询参数**；界面地址摘要及原生日志会省略查询部分，但不会从已保存 URL 删除它。

原有应用 ID、数据目录和 SQLite 文件名保持兼容。新增 `006-websocket-endpoints.sql` 扩展端点类型，保留已有端点、帧、日志和模板。两端原生持久化入口拒绝 config 内的 `headers` / `websocketHeaders`；握手头仅通过 `transport.open` 的临时选项传递。

握手绝对期限15秒，单个目标的待发送数据最多4MiB；慢连接、超额连接和超大消息会被拒绝或关闭，其他客户端继续工作。发送结果逐目标报告，部分目标失效时仍尝试健康目标。以上边界用于限制资源，不代表任意负载下都能无损发送。

Electron 写入最长等待10秒；Tauri 从消息入队开始合计最多2秒，包含排队和实际写入，过期或调用者已取消的排队项直接丢弃。Tauri 另限制每目标最多32项排队消息，避免大量空消息绕过字节上限。

## 研发入口

- 共享配置与模型：`packages/workbench/src/model/websocketConfig.js`、`createWorkbenchModel.js`、`sendWireRequest.js`，沿用端点和发送组件。
- Electron：`apps/electron/electron/websocketConfig.cjs`、`websocketService.cjs`，依赖 `ws`；接入现有 transport coordinator 和持久化队列。
- Tauri：`apps/tauri/src-tauri/src/websocket.rs`、`websocket/`，依赖 tokio-tungstenite / rustls；接入现有 coordinator、原生事件和历史。
- 共享事件仍有 endpointId / operationId / sessionId。消息帧可选 `messageType: text|binary`、`framing: websocket`，旧协议事件兼容。

## 本地验收

协议与桌面测试都使用回环目标和隔离数据；桌面脚本会启动真实应用并自动关闭。具体结果和平台限制见 [本轮验证](websocket-verification-2026-10-21.md)。

```sh
node --test apps/electron/tests/websocket*.test.js packages/workbench/tests/websocketWorkbench.test.js
npm run test:e2e -w @ineed-linklab/workbench -- websocket.spec.js
cargo test --locked --offline --manifest-path apps/tauri/src-tauri/Cargo.toml websocket:: --lib
cargo build --locked --offline --manifest-path apps/tauri/src-tauri/Cargo.toml --bin websocket-harness
node apps/tauri/src-tauri/tests/websocket-native-local.mjs
node tooling/websocket-test/cross-runtime.mjs
npm run build
node tooling/websocket-test/desktop-electron.mjs
node tooling/websocket-test/desktop-tauri.mjs
```

`tooling/websocket-test/fixtures/localhost-*.pem` 是公开的回环测试证书与私钥，仅用于自动化 TLS 正反例。测试对额外 CA 的信任只放入隔离子进程，不修改生产证书校验或系统信任。
