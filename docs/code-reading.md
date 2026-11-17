# LinkLab 代码阅读路径

Electron 与 Tauri 共享 `packages/workbench` 的界面、模型、协议配置和调度逻辑。平台差异集中在 renderer runtime adapter 与各自原生 transport。修改共享行为时，从一次操作沿以下路径阅读，再找对应测试。

下文的 `model/`、`components/` 相对于 `packages/workbench/src/`，工作台 `tests/` 相对于 `packages/workbench/`。Electron 原生路径相对于 `apps/electron/`，Tauri 的 `src-tauri/` 相对于 `apps/tauri/`。

## 端点表单与工作区工具

`components/EndpointDialog.vue` 拥有弹窗焦点、串口扫描选择、表单校验和保存代次；
`components/endpoint-fields/` 按协议呈现字段，接收父层稳定的单一草稿与错误映射。
串口字段由 `SerialEndpointFields.vue` 共用；WebSocket、网络地址、Modbus、TCP 恢复
及 OPC UA/STOMP 各有明确子表单。子表单不保存数据库或自行持有 runtime。
`model/endpointDialogForm.js` 负责端点快照与可编辑字段的双向转换。串口连接字段集中
复用，Modbus 主站保留请求组与写入指令，从站调整数据区时保留已有值的前缀。
WebSocket 临时请求头单独传入表单，保存配置不包含它们。转换可以因非法 HEX
分隔符抛错；完整端点校验仍由 `endpointDraft.js` 负责。数据区分配先检查数量上限，
原始非法起址/数量继续交给校验器报告，不用归一化默认值掩盖错误。

`components/WorkspaceToolsMenu.vue` 只管理工具入口、位置和焦点。
`LinkLabShell.vue` 持有工具开关及共享验收工作区，通信视图不会因为打开工具而替换。
`DeviceTemplatesPanel.vue` 按提取/编辑/保存版本/实例化读取：新端点成功后才保存可选
验收方案；方案保存失败保留 `pendingAcceptancePlan`，重试不重复创建端点。
表单分组及栅格统一维护在 `styles/dialog-forms.css`，主题与面板展示仍在原样式文件。

验证入口：`tests/endpointDialogForm.test.js`、`endpointDraft.test.js`、
`tests/components/EndpointDialog.test.js`、`DeviceTemplatesPanel.test.js`、
`e2e/dialog-sections.spec.js`、`workspace-tools.spec.js` 和模板/验收业务 E2E。
本轮整理与清理依据见[可读性审查](reviews/2026-11-02-readability.md)。

## 原生数据与协议模块（2026-11-17）

Electron 的 `electron/database.cjs` 保留数据库工厂、连接和公开 API，
`electron/database/` 的 `migrations.cjs` 负责结构迁移，`configuration.cjs` 处理端点、模板
和工作区交换，`history.cjs` 处理帧/日志，`pointHistory.cjs` 处理点位查询、聚合与导出。
`contracts.cjs`、`validation.cjs`、`settings.cjs` 为下层契约；它们不反向加载数据库入口。

Tauri 的 `src-tauri/src/database.rs` 保留数据库连接、类型及命令边界；`database/` 下
`schema.rs`、`settings.rs`、`configuration.rs`、`history.rs`、`point_history.rs`、`file_io.rs`
分别处理结构、设置、配置交换、历史、点位和文件安全。子模块的方法继续使用同一个
`ConfigurationDatabase`，不新开连接或跨越已有事务/flush 屏障。

串口服务的 `serial.rs` 拥有打开、读取、关闭与会话；`serial/config.rs` 校验配置，
`serial/framing.rs` 负责有界分帧与批次。`modbus/wire.rs` 提供 RTU/TCP 帧提取和 PDU
转换；Modbus 的连接、事务与从站生命周期仍在 `modbus.rs`。数据库与串口的 `tests.rs`
保留原测试模块身份，验证路径和函数可见性只开放到需要的父层。

`styles/workbench.css` 保留有序入口，`styles/workbench/` 分为外壳、端点、收发、端点弹窗、
协议面板、响应式覆盖与历史/设置。分组保留完整规则及 cascade 顺序；局部表单规范仍在
原来的 `dialog-forms.css` 等文件。

## 打开端点与接收事件

`model/workbenchSubscriptions.js` 负责原子订阅和回滚，`workbenchNotifier.js` 处理可重入通知
及监听器异常隔离。`historyRetentionController.js` 拥有历史保留计时器、清理代次和状态；
`createWorkbenchModel.js` 负责组装并在 dispose 时统一取消。子模块不创建第二套端点集合。

1. `apps/{electron,tauri}/renderer/main.js` 创建 adapter 和工作台；`packages/workbench/src/layouts/LinkLabShell.vue` 提供打开、关闭等界面入口。
2. `model/createWorkbenchModel.js` 的命令捕获当前端点与打开意图，再通过 `endpointLifecycleCoordinator.js` 排队、取消与检查结果是否仍有效。
3. `model/workbenchSnapshots.js` 复制、校验并冻结 adapter 返回的端点和事件。非法命令输入抛出异常；模型事件入口丢弃非法事件。一般数据快照与严格的状态日志 JSON 校验保留各自规则，不能互相替换。字节缓冲区复制后仍为 `Uint8Array`。
4. `apps/{electron,tauri}/renderer/runtimeAdapter.js` 转换共享接口与平台消息。Electron 经 `electron/preload.cjs`、`main.cjs` 到 `serialService.cjs`、`tcpService.cjs` 等实现；Tauri 经 `src-tauri/src/lib.rs` 到 `serial.rs`、`tcp.rs` 等实现。
5. 模型的事件处理按“接收快照 → 身份检查 → 修改状态 → 通知”执行。通知器隔离单个订阅者异常，工作台读取模型状态渲染。

三种身份不能互换：

| 字段 | 创建与归属 | 失效与用途 |
| --- | --- | --- |
| `endpointId` | 保存的端点配置 ID，工作台集合拥有配置 | 删除端点移除相关状态；刷新集合有 revision/generation 保护 |
| `operationId` | 调用方或重连控制器创建的一次打开意图 ID | coordinator 在替换、取消、关闭、重置和 dispose 时使意图失效，拒绝旧操作事件 |
| `sessionId` | runtime 创建的实际连接 ID | 首个有效事件或打开结果绑定当前意图；后续事件必须匹配该会话。新连接不能接受旧会话结果 |

模型拥有状态、监听 disposer 与调度器，`dispose()` 取消调度、使 coordinator 失效并移除监听。打开取消失败时，原有端点状态回滚顺序仍由命令流程控制。TCP 重连见 `tcpReconnectController.js`，重复发送见 `scheduledSender.js`。

非串口打开取消也按 `operationId` 路由到对应原生服务，迟到打开不能重新登记会话。RTU 打开无法由库直接中断时，保留资源归属直到打开收尾并关闭；清理失败允许重试。

验证入口：`tests/workbenchModel.test.js`、`tests/endpointLifecycleCoordinator.test.js`，以及 Electron/Tauri 的 runtime adapter 与 transport 契约测试。

## Modbus 主站读取、写入与诊断

从 `components/ModbusMasterPanel.vue` 开始：组件保留请求组编辑、保存、弹窗、页签与渲染；配置校验分别在 `model/modbusMasterConfig.js`、`modbusWriteCommands.js`。

`components/modbus-master/` 中 `MasterConnectionSummary.vue`、`MasterLiveReadings.vue`、
`MasterTransactionDiagnostics.vue` 分别展示连接摘要、实时读数和事务诊断；当前页签、
配置编辑与异步操作由父组件负责，子视图只发出配置请求或更新所选事务。

读取和轮询进入 `model/modbusMasterScheduler.js`，再调用 adapter 的 `modbus.execute`。scheduler 负责端点/会话的执行队列与结果有效性，自动和手动请求都参与连接失效协调。发给原生的请求携带 `expectedSessionId`，原生发送前拒绝旧会话；自动启动每个会话只执行一次，用户停止后普通通知不会恢复轮询；`modbusPointHistoryCollector.js` 接收点位结果、批量写入历史。模型在导入、清除、导出历史前刷新 renderer 与 native 队列。

写入确认进入 `model/modbusMasterWriteController.js`。控制器集中确认快照、单次写入门禁、确认时重新查找并校验当前指令，以及完成后的端点/会话匹配。组件在端点配置或会话变化时清除确认，保留原有对话框行为。scheduler 返回后，迟到结果仅在捕获的端点和会话仍匹配时更新写入结果与诊断；错误携带的事务仍用于诊断。最终清理按原有指令 ID 条件释放写入门禁。

`model/modbusMasterPresentation.js` 是纯展示转换：显式接收 endpoint、session、config 与 records，处理事务身份、历史记录转换、地址/时间/数值、捕获帧及生成帧的展示。`model/modbusCommands.js` 保留协议报文编码和事务分段说明。展示模块没有调度或设备副作用。

验证入口：`tests/components/ModbusMasterPanel.test.js`、`tests/modbusMasterScheduler.test.js`、写入命令与报文编码测试。根目录 `npm test` 包含 Node 与组件回归；`npm run lint` 和 `npm run build` 分别检查共享源码与两端 renderer。`npm run test:e2e` 在三个窗口尺寸上运行 Electron/Tauri 的浏览器预览；这不代表原生串口、实体设备或 Windows/Linux 安装已验收。

## DL/T 645 主站

`components/Dlt645Panel.vue` 拥有当前视图的轮询、单次抄读、实时值和事务诊断。请求在发送前捕获地址、DI、会话、超时与独立对象身份；每次异步返回都检查仍是当前请求。断开、替换会话（即使 running 没有经历 false）和卸载均释放请求与计时器，清除半帧；发送目标携带 `expectedSessionId`，由原生串口再次检查。

接收帧须匹配当前 endpoint/session。解码只处理读数据功能，正常回复按地址和 DI 配对；异常回复按当前请求地址和功能码配对。编辑中的无效配置禁用抄读，并阻止非法小数位进入解码器。配置保存记录草稿 revision，不把保存期间的新编辑标为已保存。主站视图卸载停止轮询；模拟器后台应答的生命周期另由下述模型控制器拥有。

验证入口：`tests/components/Dlt645Panel.test.js`，含旧发送成功/失败、会话替换、半帧、无关响应、非法草稿、保存竞态和轮询间隔回归。

## DL/T 645 从端模拟器

`model/dlt645SimulatorController.js` 的 manager 由工作台模型拥有，为每个模拟器创建控制器。模型只向它转交通过身份校验的新帧，不会从实时历史帧重放请求。控制器保存解析残留、响应队列、延迟计时器、事务和统计；切换端点不会中断连接的协议应答。

`components/Dlt645SimulatorPanel.vue` 负责配置编辑、保存与诊断订阅。正式工作台传入共享控制器，卸载视图只取消订阅；独立组件使用同一控制器实现，并在卸载时释放它。连接使用已保存配置，界面修改保存后生效。重新挂载恢复已有诊断，不发送历史请求。

请求入队捕获会话和代次，关闭、错误、替换会话、删除、重置和模型释放会清除计时器与解析残留。在出队、延迟后、发送前及完成后检查会话有效性；原生串口通过 `target.expectedSessionId` 再次确认发送目标。旧响应不能发送到新端口，也不能修改新会话的诊断。

验证入口：`tests/dlt645SimulatorLifecycle.test.js`、`tests/components/Dlt645SimulatorPanel.test.js`，以及浏览器模拟器切换视图用例。两端原生串口预期会话拒绝用例在 serial service 测试和 `tooling/serial-test/pty-loopback.mjs` 的真实 PTY 契约中。

## 模板、历史与工作区

普通发送在 `model/createWorkbenchModel.js` 捕获逻辑快照，再由
`model/sendWireRequest.js` 编码一次 wire bytes，并只向原生传递支持的四个字段。
模板和发送历史保留逻辑内容、格式与分帧选择；已组帧的 `dlt645` 标记原样透传。
按行/长度前缀规则及本轮验收见 [完整审查修复](full-review-fixes-2026-10-14.md)。

`model/messageFilters.js` 分块扫描原生 bytes 的正文/HEX，并接收当前端点 peers
来匹配界面地址。NFC 残留保留原始大小写；正文匹配只保存关键词前缀状态，Σ 的
上下文未确定时保留两个候选状态，避免在块末提前判成词尾。`SendLibraryPanel.vue`
用当前视图代次隔离旧结果，同时把成功删除
按 endpoint/id 合并进尚未返回的列表快照；该删除记录在加载完成或卸载时释放。
同一 endpoint/id 的重命名与删除使用串行任务，任务内完成存储及 UI 发布，避免
迟到重命名恢复已删行。不同 ID 各自排队；失败不阻塞后续任务，完成后释放队列项。

`components/SendLibraryPanel.vue` 在调用 runtime 保存模板前复制 JSON 快照，避免 Vue 嵌套响应式 target 进入 Electron IPC。`layouts/HistoryWindow.vue` 从 `model/secondaryViews.js` 的普通控制器状态建立展示快照；每次 revision 都产生新对象，即使页数未变也能显示 loading、错误和新记录。查询错误由控制器发布，UI 接住异常并保留选择。

Electron `electron/main.cjs` 和 Tauri `src-tauri/src/database.rs` 在消息/日志历史查询前 flush 原生队列。工作区文件导入在关闭连接前完整校验字段和模板端点引用；输入有效后按关闭连接、刷盘、事务导入执行。Electron 的 `database.prepareWorkspaceImport` 和 Tauri 的 `prepare_workspace_import` 复用持久化校验并捕获导入快照；原有 merge/upsert、数据库身份、设置格式和历史结构保留。

验证入口：Electron `tests/managementNative.test.js`、`tests/managementDatabase.test.js`、`tests/electronBoundary.test.js`，Tauri `database.rs` 的 SQLite/连接屏障测试，以及共享 `tests/components/SecondaryViews.test.js`、`SendLibraryPanel.test.js`。现有功能的完整验收矩阵见 [维护与验收](existing-features-acceptance.md)。

## 原生错误与解析边界

Electron Modbus 关闭见 `electron/modbusService.cjs`：opening、sessions、closing
分别持有正在打开、活动和正在清理的会话；关闭完成前不能丢失资源所有权。
closePromise 合并重复关闭，失败保留端点供重试，故障请求退休不能等待自身队列。
`electron/main.cjs` 的 activate 在原生清理超时后恢复窗口，IPC 屏障继续保护
旧连接；已保存配置与历史仍可读取。修复证据与尚未解决的原生/内存边界见
[长跑修复验证](soak-fixes-verification-2026-11-09.md)。

macOS Modbus 的 `serialOptions` 通过逐端口 binding 接入
`electron/darwinModbusBinding.cjs`。它保留兼容的串口参数和原生写入/关闭，
只把空读取递归改为等待后重试；不修改全局 fs 或依赖文件。适配依赖当前
DarwinPortBinding 的 fd/isOpen 字段，升级依赖需运行
`tests/darwinModbusBinding.test.js` 与 `tests/modbusService.test.js` 的真实
空闲/收发/重开回归。测试探针在独立 child 中观察 syscall，避免污染其它用例。

Electron `electron/modbusCoilHandler.cjs` 对登记的 LinkLab vector 修正依赖库 FC15
应答顺序；批量地址全部有效并完成变更后才应答，TCP/RTU 共用保护。升级依赖时
保留真实 TCP/RTU 越界原子写入门禁。

共享 `packages/persistence-contract/src/batchedPersistence.js` 保留有界丢失摘要，
后台 drain 处理 rejection，显式 flush/dispose 报 `HISTORY_INCOMPLETE` 并消费摘要。
Electron transport 持久化屏障等待全部队列完成；`persistence:warning` 绕过失败的
日志队列，在工作台保持可见。新批次仍可保存，已丢记录不会自动恢复。

DL/T extractor 的可选 `resynchronizing` 状态随 remainder 保留，由模拟器控制器和
主站组件在断连/换会话/释放时清零。只有完整候选校验失败后启用重扫，普通半帧仍
保留；坏帧内部伪长头不能挡住后续完整或分片合法帧。

## OPC UA 模拟服务端

入口 `components/OpcuaServerPanel.vue` → `model/opcuaSimulator.js` → `runtime.opcua.execute` → 两端原生 simulator。校验与示例在 `opcuaSimulatorConfig.js`；统一端点目录使用独立 `opcua-server` 配置源。初值草稿、当前值和存储值互相独立，错误停止保留重试身份；详见[模拟器维护文档](opcua-simulator.md)。

## 可重复只读验收检查

入口 `components/AcceptancePanel.vue` → `model/acceptanceWorkspace.js` →
`acceptanceRunner.js`；方案、严格 JSON 断言、大小与导入规则集中在
`acceptancePlan.js`。Shell 持有工作区与执行器，面板隐藏不会释放运行状态。
`acceptanceTargets.js` 只列出已连接主站/客户端，捕获会话后通过既有 Modbus
调度器或 OPC UA 原生 read 读取，并在请求前后验证身份。停止和迟到结果隔离
由执行器负责；App 退出、工作区导入会先停止、保存，再进入已有生命周期。

持久化沿用 `settings.acceptanceWorkspace` 与既有 SQLite；原生层校验边界，
不增加迁移。报告及方案导出走已有受限 OPC UA export 通道，固定文件名与
原生保存目的地分别由两端 exporter 负责。验证入口是共享 `acceptance*.test.js`、
`AcceptancePanel.test.js`、`AcceptanceLifecycle.test.js`、`e2e/acceptance.spec.js`
与 `tooling/acceptance-test/desktop-acceptance.mjs`。原生脚本使用独立 Modbus/
OPC UA localhost fixture 与隔离数据；实际范围和限制见[验收检查维护文档](acceptance-checks.md)。
