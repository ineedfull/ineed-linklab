# LinkLab WebSocket 设计（2026-10-21）

用户已批准将上轮建议的客户端/本地服务端、文本/JSON/二进制收发、请求头与子协议、Ping/Pong、自动重连及关闭原因加入 LinkLab。共用现有端点和消息/历史工作台；Electron 和 Tauri 都通过原生实现。

## 接入与配置

传输名 `websocket-client` / `websocket-server`。客户端 config：`url`（ws/wss，禁止userinfo与fragment）、`subprotocols`（唯一HTTP token数组，最多16项、每项128字节）、`messageType`（text/binary，默认text）、`autoReconnect`（默认false）、`heartbeat`（enabled默认false，intervalMs默认30000范围1000..60000，timeoutMs默认10000范围1000..60000）。服务端 config：`listenHost`默认127.0.0.1、`listenPort`范围1..65535、`path`默认/、subprotocols/messageType/heartbeat同上。首版服务端为本地ws监听，不配置TLS终止；客户端wss严格校验系统信任链与主机名，无忽略验证开关。原生测试可内部使用0端口，UI不可保存0。

自定义Headers（含Authorization/Cookie）只在内存中：连接选项`{operationId,websocketHeaders:[{name,value}]}`；界面明确不保存/导出，端点编辑后同进程保留。名称为HTTP token，值仅支持HTAB及Latin-1可打印字符；禁止CR/LF、重复头以及Host/Connection/Upgrade/Sec-WebSocket-*等握手保留头，最多32项、单项值4096字节、合计16KiB。不接受配置JSON内headers或websocketHeaders以免落盘。URL可能有查询凭据，因此日志只输出不带query的地址、无请求头。协议错误不得回显凭据。

复用现有transport.open/cancelOpen/close/send/disconnectPeer与status/frames/peers。open参数增加可选websocketHeaders。send请求增加可选`messageType:'text'|'binary'`，缺省用端点config默认；text需要严格UTF-8，JSON编辑校验保持现有机制。一次发送等于一条完整WS消息，不使用字节流收发分帧/CRLF追加；HEX默认binary，text/JSON默认text，允许界面明确选择。接收保持WS消息边界，不合并或再次分帧；text/binary在事件帧上增加可选messageType，历史format记录text/hex，framing标识websocket。控制帧不进入业务消息历史。

## 生命周期与边界

客户端连接/握手15秒，取消需及时关闭底层资源且迟到回调不得污染新会话。连接状态遵循现有opening/open/listening/closing/closed/error，以及operationId/sessionId隔离。客户端自动重连复用现有指数退避控制器，主动关闭/删除/导入/退出取消重连。服务端最大64客户端，指定一个/多个客户端或广播，逐目标反馈；断开单个客户端不会关闭监听。子协议按配置匹配；服务端配置非空列表时拒绝无匹配请求，空列表不擅自回传协议。

单条消息/发送最大1MiB；待发送队列/缓冲有界（最多4MiB），服务端握手超时、超额连接和大报文要拒绝并回收；慢客户端不能阻塞其它端点。心跳发送RFC Ping并等Pong，超时关闭；默认关闭。显示关闭码和原因（有界、脱敏；客户端带自定义头或查询参数时，远端原因整体隐藏，防止回显凭据片段），意外关闭触发现有重连，主动关闭正常1000。应用退出清理所有连接/监听/心跳。

## 数据兼容与验证

追加006-websocket-endpoints迁移扩展原端点CHECK并保留端点/帧/日志/模板，Node与Rust同版迁移，不改已有ID/路径。新端点导入导出/克隆与校验工作，无headers泄露。

TDD覆盖配置、消息UTF-8/二进制/边界、认证头与子协议、WS/WSS严格校验、服务器多客户端/广播/断开、取消/旧回调、重连、心跳、超限与关闭原因、历史持久化/旧库迁移。回环真实协议及双端真实桌面分别记录；浏览器矩阵覆盖浅深/普通大字/展开折叠/窄窗。最终Node/组件/lint/build/Rust和独立审查。保留当前OPC UA及11项旧改动；不提交、不打包发布。

集成补充：事件帧可选`framing:"websocket"`与`messageType`均被共享normalizer校验并保留，旧传输不新增字段。
