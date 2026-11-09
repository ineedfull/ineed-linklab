# OPC UA 工作台

LinkLab 的 OPC UA 入口用于调试工业设备、网关和测试服务器的节点模型。Electron 与 Tauri 共用同一个界面。统一端点列表可创建多个 OPC UA 客户端，每个端点独立保存配置、连接、节点值、订阅和草稿，也可与串口、TCP、Modbus 同时工作。切换端点保留连接；删除只关闭对应端点。每个运行时最多同时打开 8 个 OPC UA 会话，正在建立的连接也计入。

应用还提供独立的 [OPC UA 模拟服务端](opcua-simulator.md)。`tooling/opcua-test/server.mjs` 仅用于回环研发测试，不随安装包提供。

## 操作

1. 点击 **添加端点**，选择 **OPC UA 客户端**，填写名称和 `opc.tcp://主机:端口/路径`。保存后在右侧工作台继续配置；新建或重启只读取本地配置，不自动发现或连接。
2. 点击 **发现端点**，选择服务器实际提供的安全端点。首版支持 None、Basic256Sha256，以及匿名、用户名密码认证。生产连接建议使用 Basic256Sha256 / SignAndEncrypt；None 与 Sign 的消息未加密。不会自动降级安全策略。
3. 安全连接拒绝未知证书时，进入 **证书**，刷新列表，通过可信渠道核对 SHA-256 指纹、服务器身份和有效期，勾选确认后信任，再重连。信任证书不跳过主机名、有效期和应用 URI 等校验。连接失败信息保留在页面。
4. **节点与监视** 默认浏览 Objects（`i=85`）。输入 NodeId、点击浏览或沿节点展开；面包屑返回已浏览层。每页最多100项，单层最多加载2000项；搜索只筛选当前层已加载节点。开始新浏览或达到显示上限时，共享工作台通过两端 `releaseBrowse` 操作调用 `BrowseNext(true)` 释放废弃分页游标；释放失败显示错误并保留游标供重试，不继续新浏览。断开或销毁工作台关闭会话，同时回收该会话的剩余分页资源。
5. 点击节点 **读取**。最新值显示数据类型、质量状态、源时间与服务器时间。64位整数保持十进制字符串精度，ByteString 使用 base64，一维数组使用 JSON；矩阵保留 Matrix 类别与维度，和复杂结构一样只读展示。
6. 点击 **准备写入**，核对 NodeId、类型、值结构和新值，勾选确认后写入。设备拒绝或类型错误会显示失败；成功后可再次读取核对。数组中的 Int64/UInt64 必须使用带引号的十进制字符串。
7. 勾选最多100个节点，设置100–60000毫秒采样间隔，点击 **监视所选**。重新监视会替换原订阅；停止监视保留最新值。临时网络中断时客户端尝试恢复会话和订阅，主动断开取消恢复。
8. 最新值最多500个节点，最近变化最多1000条。**清空记录**保留最新值和订阅；**导出 CSV**使用桌面原生保存对话框，包含类型、值、状态及双时间戳，并处理电子表格公式前缀。

## 配置与数据

**保存连接与收藏**保存当前地址、安全参数、用户名及收藏节点。每份最多100个收藏，最多50份连接；密码仅在当前进程内存中使用，保存、导入、导出均不保留密码。重新启动或导入替换配置后需要重新填写；仅切换端点保留各自的临时凭据。收藏编辑后需再次保存。

配置导入接受独立 JSON 数组，按 ID 合并，完整验证后原子替换，导入的连接直接出现在端点列表中；覆盖已有端点前需要断开并等待其操作结束。OPC UA 仍使用独立配置 JSON 导入/导出，不包含在通用工作区导出中。配置、导入和文本导出均有1 MiB上限。CSV 达到内容上限时会明确报错，可清空记录后分批导出。

数据位于各桌面运行时实际用户数据目录的 `opcua/` 子目录：`profiles.json`、独立客户端证书和 PKI 信任/拒绝列表。Electron 与 Tauri 使用各自的应用数据目录，不自动共享信任和密码；原有数据库结构、应用标识和历史路径保持兼容。

## 实现与维护

- 多端点目录与生命周期：`packages/workbench/src/model/protocolEndpointCatalog.js`；已有配置自动出现在统一端点列表，不迁移数据或证书。
- 共享模型：`packages/workbench/src/model/opcuaWorkbench.js`；界面：`components/OpcuaPanel.vue`。
- Electron：node-opcua 2.187.10，`apps/electron/electron/opcua*.cjs`。
- Tauri：async-opcua 0.19.0，`apps/tauri/src-tauri/src/opcua.rs` 和 `opcua/`。native 命令 `opcua_execute`；参数为 `{request}`。
- Tauri 首次创建客户端身份时显式生成应用 URI 与回环 SAN，不依赖本机主机名的 DNS 解析；已有证书和私钥继续使用。此设置只控制自身证书生成，服务器证书仍严格校验。
- 两端统一 `runtime.opcua.execute({action,...})` 与 `onEvent(listener)`，浏览器只有显式测试 fixture。
- Tauri 的 SDK crypto 局部补丁修正 URI SAN 顺序处理，保留其余证书检查。来源、MPL-2.0许可、改动及回归测试见 `apps/tauri/src-tauri/vendor/async-opcua-crypto/LINKLAB-PATCH.md`。升级 SDK 时先核对上游修复，避免长期保留重复补丁。

## 本地验收入口

全部协议目标限定为回环地址，使用隔离数据。具体本轮结果见 `opcua-verification-2026-10-21.md`。

```sh
node --test apps/electron/tests/opcua*.test.js packages/workbench/tests/opcuaWorkbench.test.js
npm run test:components -w @ineed-linklab/workbench -- OpcuaPanel.test.js
npm run test:e2e -w @ineed-linklab/workbench -- opcua.spec.js
cargo test --locked --offline --manifest-path apps/tauri/src-tauri/Cargo.toml opcua:: --lib
cargo build --locked --offline --manifest-path apps/tauri/src-tauri/Cargo.toml --bin opcua-harness
node apps/tauri/src-tauri/tests/opcua-native-local.mjs
npm run build
node tooling/stomp-test/desktop-duel.mjs
```

`opcua-native-local.mjs` 在服务端仅允许两个分页游标时连续八次浏览并显式释放，再验证正常续页、类型读写、安全认证、订阅与断线恢复；使用临时证书和数据目录。该入口直接调用 Tauri 的 Rust 协议服务，不代表完整桌面 GUI 或安装包验收。

统一端点的双端桌面脚本同时检查 STOMP 与两条真实 OPC UA 会话；旧 `tooling/opcua-test/desktop-*.mjs` 记录的是此前单独页面的验收流程，当前入口见上面的 `desktop-duel.mjs`。最新多端点结果及待验收项见 [2026-10-22 验收记录](protocol-endpoints-verification-2026-10-22.md)。

Windows/Linux/macOS x64 的原生桌面安装、实体厂商服务器及长期现场断网需要对应环境验收。配置了打包目标不代表已完成这些平台的原生验收。本次功能开发不自动生成或发布安装包。

## 模拟服务端

现已在统一添加端点提供独立 OPC UA 模拟服务端，支持多实例、类型节点、远程读写/订阅和自动变化。使用方式、限制及原生验证见[模拟服务端](opcua-simulator.md)。客户端安全与证书操作仍按本文规则。
