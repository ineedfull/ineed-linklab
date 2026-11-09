# STOMP 工作台

通过 **添加端点 → STOMP 客户端 / STOMP 服务端** 创建 STOMP 1.2 over WebSocket 客户端和本地联调 broker。Electron 与 Tauri 共用协议、控制器和界面，分别使用原生 WebSocket 传输。每个端点拥有独立连接、认证、订阅、消息、待确认状态和草稿，与 TCP/UDP 一起显示在端点列表。切换端点保留连接，删除只关闭对应端点，关闭应用时释放全部连接。

## 客户端

1. 添加 **STOMP 客户端** 端点，填写名称和 WebSocket URL。右侧工作台只加载该端点配置，不自动联网，创建后角色固定。默认 URL 为 `ws://127.0.0.1:61614/stomp`，Virtual host 为 `localhost`；第三方 broker 的 URL、virtual host 和目的地按其配置填写。
2. 如服务端要求认证，在 **临时认证** 填写登录名、口令；WebSocket HTTP 握手所需的认证放在 **握手请求头**。STOMP 登录名/口令与 HTTP 请求头是两个不同阶段的认证参数。URL 不接受 userinfo、查询参数或片段。
3. 点击 **连接**。客户端协商 STOMP 1.2；`wss://` 使用原生 TLS 信任校验，不提供忽略证书错误的开关。配置或认证修改前先断开；连接过程中可以 **取消连接**。
4. 在 **消息与订阅** 填写目的地和确认模式，点击 **订阅**。可添加多个订阅；客户端目的地遵循远端 broker 的规则，本地 broker 的规则见下文。
5. 填写发送目的地、Content-Type 和文本正文，点击 **发送**。正文支持 UTF-8，编解码按 UTF-8 字节数计算 `content-length`，可处理正文中的 NULL。界面把消息作为文本显示，不执行 HTML。
6. 勾选 **请求 RECEIPT 回执** 后，发送行会显示回执确认或超时。回执表示 broker 已处理相应请求，消费者的处理结果由其 ACK/NACK 表达；发送成功本身也不保证目的地存在消费者。

发送和期望接收心跳默认均为 10,000ms，可设为 0 或 1,000–60,000ms。实际间隔由双方协商，STOMP 心跳使用 LF，与 WebSocket Ping/Pong 分开。协商后超过约两倍接收间隔未收到数据会结束连接。

启用 **断线后自动重连并恢复订阅** 时，网络中断后按 1、2、4、8、15 秒退避重试，后续最多间隔 15 秒。重连会恢复订阅，等待恢复订阅的 RECEIPT 后显示 **已连接**。主动断开会取消重连；服务端 ERROR 或无效协议响应会终止当前尝试并显示错误。旧会话的待确认标识不能用于新连接。

## ACK / NACK 与实时消息

| 订阅模式 | 操作范围 |
| --- | --- |
| `auto` | 无手动 ACK/NACK 操作 |
| `client` | 确认或拒绝所选消息，以及同一订阅中此前尚未确认的消息 |
| `client-individual` | 只确认或拒绝所选消息 |

手动确认消息显示 **ACK** 和 **NACK**。行内保留目的地、subscription、message-id、ack-id、方向、时间和状态；这些标识用于区分订阅和确认目标。NACK 的后续处理由远端 broker 决定。本地 broker 会重新投递：queue 重新进入分发，topic 返回原订阅。

**清空消息**只清除实时展示历史。历史超过条数或字节预算时也会淘汰最早行；仍待确认的消息会出现在独立 **待确认消息** 列表中，继续提供 ACK/NACK。该列表只保留确认所需的元数据，不保留正文。确认、退订或连接结束后相应操作消失。确认不是持久日志功能，应用重启后不会恢复待确认状态。

## 本地服务端

1. 添加 **STOMP 服务端** 端点，设置监听地址、端口、WebSocket 路径和 Virtual host。默认仅监听 `127.0.0.1:61614`，路径 `/stomp`、Virtual host `localhost`。
2. 如需 STOMP 认证，勾选 **要求账号密码** 并填写临时登录名和口令。客户端 CONNECT/STOMP 帧中的 host 必须与 Virtual host 一致。
3. 点击 **启动服务**，在 **消息与订阅** 查看客户端连接；其它标准 STOMP 1.2 over WebSocket 客户端可接入。页面上的 **发布测试消息**直接向所填目的地发布，不需要为服务端自身建立订阅。
4. 点击 **停止服务**释放 listener、客户端连接、未消费队列和待确认消息；下一次启动是新的服务运行。

本地 broker 使用精确目的地：

| 目的地 | 分发与留存 |
| --- | --- |
| `/topic/名称` | 广播给所有匹配的订阅；没有订阅者时不保留消息 |
| `/queue/名称` | 在匹配的订阅者之间轮转分发，每条只发给一个订阅；没有消费者时在本次服务运行内暂存 |

queue 的手动确认消息在 NACK、退订或客户端断开后可重新进入队列；topic 的未确认消息在退订或断开时释放。本地 broker 拒绝无效帧、未知确认标识、超限或不支持的命令时，会发送受控 ERROR 并关闭相应 peer，listener 继续工作。

本地服务端只提供 `ws://`，不提供 TLS listener。当前不支持 STOMP 原始 TCP、SockJS、事务、通配订阅、持久队列或集群；不能将本地联调 broker 的留存和分发行为当成生产消息服务保证。第三方 broker 自身的目的地、持久化及 NACK 策略由其定义。

## 保存与认证边界

添加端点时保存基础配置；断开后在对应工作台点击 **保存配置**，更新名称、白名单连接参数及订阅的 ID/目的地/确认模式。最多 50 份配置，每份最多 100 个订阅。配置保存在各运行时通用设置的 `stompProfiles` 中，使用各自原有应用数据目录；工作区导入/导出也经过配置校验。两端数据不会自动同步。

登录名、口令、握手请求头、服务端认证开关和认证值不进入保存配置。重新启动或导入替换配置后需要重新填写临时认证；仅切换端点保留各自的草稿。原生数据库对配置字段额外执行白名单和限制校验，拒绝凭据或未知字段。

STOMP 使用独立临时原生传输通道，不进入普通 WebSocket 端点的 wire/history 持久化。CONNECT/STOMP 认证帧、握手头和远端错误正文不会加入用户消息历史；当前实时消息及待确认信息均为内存数据，没有 STOMP 原始帧日志或专用消息导出入口。保存的配置不包含实时消息、队列或确认状态。

## 当前限制

以下预算独立生效；字节预算包含相应正文/元数据的计费开销，不是整个进程的内存上限。

| 范围 | 上限 |
| --- | --- |
| 单个 STOMP 帧 / 单个原生 WebSocket 消息 | 1 MiB；完整帧包含命令、头部、正文和 NULL 终止符 |
| STOMP 头部 | 64 KiB、最多 100 个头；一次解析最多 1,000 个命令帧 |
| 实时展示历史 | 500 条且总计费预算 8 MiB，先达到任一上限即淘汰最早行 |
| 客户端订阅 / broker 每个 peer 的订阅 | 各 100 个 |
| 客户端待确认 / 本地 broker 所有 peer 合计待确认 | 各 1,000 条 |
| 客户端待回执请求 | 1,000 个；回执等待约 10 秒 |
| 共享控制器待写入队列 | 1,000 项且 8 MiB，原生 WebSocket 还有自身背压限制 |
| 本地 broker 客户端 | 64 个，包括尚未完成 STOMP 握手的连接 |
| 本地 broker 单个 queue | 1,000 条，包括该 queue 的未消费与待确认消息 |
| 本地 broker 留存总预算 | 8 MiB，包括 queue 留存和 topic 手动确认消息；每次运行最多 1,000 个 queue 目的地 |
| 目的地 / 订阅 ID | 最多 1,024 / 128 个字符 |
| 临时 HTTP 请求头 | 32 项、总名称和值 16 KiB，单个值 4 KiB；拒绝保留的握手/HTTP 分帧头 |
| 原生 STOMP 传输会话 | 每个运行时 4 个；与普通 WebSocket 端点会话分开计算 |

握手等待约 10 秒。队列、待确认、帧大小或发送预算超过限制会产生可见错误或关闭相关连接，不保证任意负载下无损。需要持久化、生产重投策略或长期压力保证时应连接对应的外部 broker。

## 维护与验收入口

- 共享编解码 / 本地 broker / 控制器：`packages/workbench/src/model/stompCodec.js`、`stompBroker.js`、`stompWorkbench.js`。
- 共享界面与样式：`components/StompPanel.vue`、`styles/stomp.css`；统一端点列表位于 `layouts/LinkLabShell.vue`，目录及控制器所有权位于 `model/protocolEndpointCatalog.js`。
- Electron：`apps/electron/electron/stompTransport.cjs`，通过专用实例复用 `WebSocketService`，不挂接原端点持久化。
- Tauri：`apps/tauri/src-tauri/src/stomp.rs`；IPC 为 `stomp_execute`，事件为 `stomp:event`。两端对共享界面提供 `runtime.stomp.execute/onEvent`。

从仓库根目录运行对应检查：

```sh
node --test packages/workbench/tests/stomp*.test.js apps/electron/tests/stompTransport.test.js
npm run test:components -w @ineed-linklab/workbench -- StompPanel.test.js
npm run test:e2e -w @ineed-linklab/workbench -- stomp.spec.js
cargo test --locked --offline --manifest-path apps/tauri/src-tauri/Cargo.toml stomp --lib
cargo build --locked --offline --manifest-path apps/tauri/src-tauri/Cargo.toml --bin stomp-harness
node tooling/stomp-test/native-interoperability.mjs
```

真实桌面脚本需要当前 renderer 产物，并会启动应用窗口，和已有桌面压力任务串行执行：

```sh
npm run build
node tooling/stomp-test/desktop-duel.mjs
```

具体环境变量、证据和覆盖边界见 [STOMP 验证脚本说明](../tooling/stomp-test/README.md)。浏览器 fixture 验证界面和显示矩阵；原生 bridge/CLI 验证真实协议与 SDK 互通；桌面脚本验证实际宿主和共享界面。这三类不能相互替代。以上是可复现入口，不表示本轮全部检查或其它操作系统安装验收已经完成；本轮最终结果由任务验收记录另行登记。
