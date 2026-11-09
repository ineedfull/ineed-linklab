# OPC UA 模拟服务端

在“添加端点 → OPC UA 模拟服务端”创建，与 OPC UA 客户端放在同一分类。Electron 与 Tauri 使用同一个工作台；每个端点独立启动、停止和保存，切换页面保留监听。首版只提供 **None / 匿名** 的测试服务；默认 `127.0.0.1:4840/LinkLab`，选择 `0.0.0.0` 后允许网络中的客户端连接，远程客户端需使用本机实际 IP。

## 一条完整流程

1. 新建服务端，确认监听端口、路径和命名空间 URI。多个服务端使用不同端口。
2. 编辑示例节点或添加自己的节点：ID、名称、类型、标量/数组、初始值、是否允许远程写入，以及自动变化方式。
3. 点击“启动”。工作台显示实际 Endpoint URL、NodeId 和当前值；运行中监听参数与节点结构锁定。
4. 用 LinkLab 的独立 OPC UA 客户端或其他标准客户端连接，浏览 Objects 下的 LinkLab 文件夹，读取、写入或订阅节点。使用返回/浏览到的 NodeId，不猜测 namespaceIndex 或拼接 NodeId；两端 SDK 的字符串节点表示可不同。
5. 在模拟器选择节点并“更新当前值”可模拟传感器变化，包括远程只读节点。远程客户端对只读节点的写入会被拒绝。
6. “停止”释放监听，再编辑或“保存初始配置”。重新启动使用明确保存/编辑的初始值；远程写入、自动变化和本地更新不会覆盖初始配置。

“载入示例”恢复温度、运行状态、计数器和设备名称。初始值草稿在控制器统一校验，因此侧栏启动与面板启动使用相同数据；非法初值不会悄悄退回旧值启动。停止报错时保留可重试身份，删除也不会继续丢弃该端点。

## 值与自动变化

支持 Boolean、Int16、UInt16、Int32、UInt32、Int64、UInt64、Float、Double、String、ByteString、DateTime 的标量和一维数组。

- 64 位整数输入十进制字符串；JSON 数组中仍用字符串，避免精度丢失。
- ByteString 使用 base64；DateTime 输入带 `Z` 或显式偏移的 ISO 时间。界面显示时间统一转换为本地 `YYYY-MM-DD HH:mm:ss.SSS`，原始协议值保持类型语义。
- Boolean 标量可定时翻转；Int16/UInt16/Int32/UInt32/Float/Double 标量可递增。其余类型及数组手动更新。
- 自动变化间隔为 100～60000 毫秒。递增参数需在类型范围内，`min ≤ max` 且 `step > 0`；每拍计算当前值加步长，结果超出 `[min,max]` 回到 min。手动/远程写入按类型校验，允许临时超出模拟区间。
- 变化由原生服务驱动，隐藏页面继续运行；共享控制器每秒串行获取快照，不重叠轮询，隐藏页面不渲染值表。

## 限额、兼容与维护

最多同时运行 4 个服务端，启动中的实例也占名额；客户端原有 8 会话限额独立。每实例 1～100 节点、数组最多 100 项、单字符串最多 4096 字符，节点配置最多 256 KiB。命名空间不能复用 OPC UA 标准 URI `http://opcfoundation.org/UA/` 或双端服务应用保留的 `urn:ineedfull:linklab:simulator:server` / `urn:ineedfull:linklab:opcua:simulator`，避免节点与内置地址空间冲突。最多保存 50 个配置，整个配置文件不超过 1 MiB。共享模型与两端原生均校验外部输入。

服务端配置单独存储在应用数据目录 `opcua/server-profiles.json`，原子保存、导入先校验；旧客户端 `profiles.json`、客户端 PKI、SQLite 和应用 ID 不迁移。服务端 PKI 与客户端独立，Electron 最多使用 4 个稳定 slot 目录，Tauri 使用固定 server-pki。它们不开放安全端点，也不自动信任客户端证书。

源码阅读路径：

- `model/opcuaSimulatorConfig.js`：纯值/节点/配置约束及场景示例。
- `model/opcuaSimulator.js`：端点控制器、初值草稿、会话代数、串行快照及取消。
- `model/protocolEndpointCatalog.js`：`protocol:opcua-server:<id>` 独立配置源和端点生命周期。
- `components/OpcuaServerPanel.vue`：节点编辑、当前值、统一时间及操作反馈。
- Electron `electron/opcuaSimulator*.cjs`；Tauri `src/opcua/simulator.rs` 及 `simulator/{manager,validation}.rs`：原生监听、地址空间、受限写入、订阅与清理。

以上共享路径相对 `packages/workbench/src/`。原生入口仍通过既有 `runtime.opcua.execute`，新增 serverProfiles/saveServerProfiles/startServer/stopServer/serverSnapshot/setServerValue；协议及生命周期契约见[设计](superpowers/specs/2026-10-22-opcua-simulator-design.md)。

## 可复现验证

从仓库根目录运行：

```sh
node --test packages/workbench/tests/opcuaSimulator.test.js packages/workbench/tests/protocolEndpointCatalog.test.js apps/electron/tests/opcuaSimulator.test.js
npm run test:components -w @ineed-linklab/workbench -- OpcuaServerPanel ProtocolEndpoints EndpointDialog
npm run test:e2e -- opcua-server.spec.js
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --lib -- --test-threads=1
cargo build --manifest-path apps/tauri/src-tauri/Cargo.toml --bin opcua-harness
node apps/tauri/src-tauri/tests/opcua-server-native-local.mjs
npm run build
node tooling/opcua-test/desktop-simulator.mjs electron
node tooling/opcua-test/desktop-simulator.mjs tauri
```

Native SDK 与桌面脚本只用回环、独立临时配置和品牌宿主；桌面脚本需解锁桌面。浏览器矩阵是显式 fixture，不能替代原生服务。新功能尚未重新打包发布；Windows/Linux、真实远程设备与长期现场压力需要对应环境验证。
