# LinkLab OPC UA 工作台设计（2026-10-21）

用户已批准在 LinkLab 实施独立 OPC UA 工作台：连接/端点、安全策略和认证、证书信任、节点浏览、读写、订阅、恢复和导出。此文落实已批准范围，不另起独立产品。

## 架构与边界

共享 Vue 界面与纯 JavaScript 模型；Electron 使用 node-opcua 2.187.10，Tauri 使用 async-opcua 0.19.0 的原生客户端。两端通过 `runtime.opcua.execute(request)` 和 `runtime.opcua.onEvent(listener)` 接入，返回值使用现有平台 envelope 解包规则。浏览器只有显式 fixture，不伪装原生通信。

OPC UA 作为侧栏独立入口，在主工作区展示；与字节流端点独立，不改已有 endpoint/database schema。切换入口保留原工作台及 OPC UA 会话；应用退出必须关闭两端订阅和会话。遵循现有主题、普通/大字和窄窗口变量。

## 唯一通信契约

`execute(request)` 成功返回 JSON 值，失败抛出有 message 的错误；native 命令名 `opcua_execute`（Tauri，参数 `{request}`），`opcua:execute`（Electron）。事件名 `opcua:event`。

- `discover {endpointUrl}` → `{endpoints:[{endpointUrl,securityPolicy,securityMode,authentication:["anonymous","username"],serverCertificate?:{fingerprint,subject,validFrom,validTo,derBase64}}]}`。
- `connect {connectionId,config}` → `{sessionId}`。config 为 `{endpointUrl,securityPolicy,securityMode,authentication,username,password}`；默认 None/None/anonymous，首版安全策略 None 与 Basic256Sha256，模式 None/Sign/SignAndEncrypt。密码仅内存，界面明确是否加密；不默认信任未知证书，不静默降级安全策略。
- `disconnect {connectionId}` → `{disconnected:true}`；也终止正在建立的连接，迟到的 connect 不得泄漏会话或覆盖下一会话。
- `browse {connectionId,sessionId,nodeId,continuationPoint?}` → `{nodes:[{nodeId,browseName,displayName,nodeClass}],continuationPoint?:string}`。默认 ObjectsFolder `i=85`，每页最多 100，使用 continuationPoint 分页，首版搜索仅过滤当前已加载节点。
- `read {connectionId,sessionId,nodeIds}` → `{values:[{nodeId,dataType,arrayType,value,statusCode,sourceTimestamp,serverTimestamp}]}`。时间为 ISO8601 或 null。Int64/UInt64 用十进制字符串；ByteString 用 base64；数组为 JSON 数组；复杂结构只读 JSON 展示，不默默写成字符串。
- `write {connectionId,sessionId,nodeId,dataType,arrayType,value}` → `{statusCode}`。arrayType 为 Scalar/Array。标量支持 Boolean/SByte/Byte/Int16/UInt16/Int32/UInt32/Int64/UInt64/Float/Double/String/DateTime/ByteString/NodeId；按类型严格校验，禁止 NaN/Infinity、越界、损失 64 位整数精度和无效日期。写入须用户明确点击确认，失败状态不得报成功。
- `subscribe {connectionId,sessionId,nodeIds,intervalMs}` → `{subscriptionId}`。nodeIds 最多 100；intervalMs 为 100..60000，默认1000；同一连接替换旧订阅，避免重复。
- `unsubscribe {connectionId,sessionId}` → `{unsubscribed:true}`。
- `certificates {}` → `{certificates:[{fingerprint,subject,validFrom,validTo,trusted,derBase64?}]}`；列出客户端本地信任与拒绝列表，客户端应用证书独立生成于应用数据目录。
- `trust {fingerprint}` → `{trusted:true}`；仅信任已发现/拒绝且与指纹相符的证书，不接受任意路径；有明确界面确认。
- `profiles {}` → `{profiles:[{id,name,config,favorites:[{nodeId,displayName}]}]}`。
- `saveProfiles {profiles}` → `{profiles}`。最多 50 个，favorites 每个最多100；仅保存 config 非密码字段，配置原子写入专属 OPC UA JSON 文件，不修改已有数据库。独立配置导入/导出使用相同格式并先完整验证。

- `export {fileName,content}` → `{saved:boolean}`。仅允许 `opcua-values.csv` / `opcua-profiles.json`，UTF-8 内容最多 1 MiB；使用原生保存对话框选择目标，取消返回 false，不接受 renderer 指定路径。

事件为 `{connectionId,sessionId,type,...}`。type `status` 包含 `status:"connected"|"reconnecting"|"disconnected"|"error"`、`message`；type `data` 包含 `values`（与 read 一致）。前端只接收当前 sessionId 的事件；晚到请求、旧会话事件、卸载后回调均不得改写新状态。原生 SDK 重连后恢复订阅；主动断开取消恢复。

## 资源、安全和用户体验

所有操作有限超时（连接最长15秒，普通请求10秒），浏览/订阅数量有上限；原生检查输入，不能只依赖 UI。会话事件不携带密码、私钥。连接关闭、取消、窗口退出清理对象。订阅展示保留最新值、最近最多1000条变化，CSV 导出包含节点、类型、值、状态和双时间戳，防止电子表格公式注入；清空记录不清除订阅和配置。搜索说明仅当前层已加载节点。错误显示在当前操作附近，未知证书展示可核对指纹后明确信任并重连。

## 验收

本地 node-opcua 模拟服务器提供可写多类型节点、只读/错误节点、变化值、匿名/用户名与 Basic256Sha256 安全端点。两端真实协议执行 discover/connect/browse/read/write/subscribe/disconnect；验证非法输入、旧会话、断连恢复、未知证书拒绝与显式信任。纯模型与组件测试覆盖 64位/数组/ByteString、保存去密、过期回调、错误状态、导出及界面交互。浏览器验证浅深/普通大字/侧栏展开折叠/窄窗口。最后运行已有 Node/组件、lint、双 renderer build 和 Rust 门禁。Windows/Linux/实体服务器验收需相应环境，不用浏览器 fixture 代替原生验收。

## 已有工作保护

本次开始已有 11 个改动，集中于 Vite 配置、Modbus 趋势图、Rust database/persistence/serial 和契约测试。基线在工具工作区 scratch/2026-10-21-linklab-opcua；保持这些文件内容。本次新协议文件与最小接入单独组织，不提交他人改动。
