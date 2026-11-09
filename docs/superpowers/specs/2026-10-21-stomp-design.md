# STOMP 1.2 over WebSocket Client / Server

用户已明确要求两种角色，沿用会话内自主完成授权。采用独立共享工作台，客户端支持第三方标准 STOMP 1.2 over ws/wss；本地服务端为联调 broker。另两种方案（只发原始文本、将 Node broker 单独嵌入 Electron）分别缺乏协议操作和双端一致性，因此不采用。

## 行为

- 客户端：ws/wss、virtual host、临时 login/passcode 和握手头、STOMP 1.2 协商，多个订阅，SEND、auto/client/client-individual ACK/NACK，receipt，协商心跳、自动重连后恢复订阅，取消及断开。
- 服务端：本地 ws 监听，配置 path/virtual host、可选临时账号密码，多客户端；`/topic/` 精确地址广播，`/queue/` 精确地址轮转分发；未消费队列和未确认消息有界，ACK/NACK 和退订，receipt，心跳及关闭清理。明确不支持事务、通配订阅、SockJS、持久队列或集群。无消费者的 topic 不留存；queue 在本次服务运行内留存。
- STOMP command/header/content-length/UTF-8/NULL 处理符合1.2。支持内容体中的 NULL（content-length），跨 WebSocket 消息拆帧及多帧，拒绝非法转义、超限和未知命令；ERROR 后关闭相关 peer，不影响 listener。
- 认证帧及握手头不进入数据库、wire 日志或导出。服务端错误仅受控文案。消息显示 body、destination、subscription、message-id、ack-id、方向和时间，最多500条；待确认最多1000、订阅最多100、peer最多64、单帧最多1MiB、每队列最多1000条/总8MiB，失败有可见错误。
- 保存命名连接配置和订阅目的地；持久化严格使用白名单，不保存密码、login、请求头和服务端认证值；URL 不允许userinfo/query/hash。两端共享模型/UI，复用原生WebSocket服务，严格TLS信任，不新增原生不安全开关。

## 内部接口与文件边界

`runtime.stomp.execute(request)`：`open {connectionId,mode:'client'|'server',config,headers?:[{name,value}]}` 返回 `sessionId` 等原生ack；config为现有对应WebSocket config。`send {connectionId,bytes,messageType:'text'|'binary',peerId?}` 单目标发；`close {connectionId}`；`disconnectPeer {connectionId,peerId}`。connectionId为当前工作台每次连接生成的UUID，最大4个原生会话。close/cancel迟到open需关闭，不能影响同id新会话。原生只做WebSocket传输，无STOMP凭据或帧持久化。

`runtime.stomp.onEvent(fn)` 返回取消订阅函数。事件 `{type:'status'|'frames'|'peers', payload}`，payload沿用WebSocket状态、帧和peer结构（endpointId=connectionId、operationId、sessionId）；只转发inbound frames，outbound不转发不保存。事件通道 `stomp:event`，IPC `stomp:execute` / Tauri `stomp_execute`。限制主窗口调用，退出释放所有会话。

共享 `createStompWorkbench(runtime,{reactive})` 暴露 `state`、`initialize/saveProfile/deleteProfile/selectProfile/connect/disconnect/subscribe/unsubscribe/send/ack/nack/clearMessages/dispose`；state 包含 config、credentials、profiles、status、error、feedback、subscriptions、messages、peers、mode。UI通过此API，不直接操作SDK。协议和模型尽量独立文件，小模块各自测试。

## 验收

协议真实编解码及客户端/服务端互通、第三方SDK互通、错误输入、认证不落盘、心跳/重连/退订/ACK/NACK/receipt/队列上限；组件与主题/大字/侧栏/窄窗口矩阵；真实Electron+Tauri桌面及跨端Client/Server。既有对攻≥20分钟加3分钟静置继续独立记录，不能以fixture代替原生。
