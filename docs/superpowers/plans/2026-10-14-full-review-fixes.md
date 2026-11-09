# LinkLab 完整功能审查修复 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task. 用户已授权实施，原目录串行开发、独立复核；不自动提交或发布。

**Goal:** 修复报告 L1–L12 并用失败/通过用例和双端回归验收。
**Architecture:** 保持共享 Vue 模型/编码与平台原生 transport 边界；原子协议应答、可见有界持久化失败、合法输入预检和共享发送分帧。
**Tech Stack:** Node 26、Vue、Electron、Rust/Tauri、SQLite、Node test/Vitest/Playwright。
**Spec:** `docs/superpowers/specs/2026-10-14-full-review-fixes-design.md`。

## Global Constraints

- 原源码目录修改，保留已有品牌/压力修复；源码、工作区均不自动提交、push、打包、上传或发布。
- Electron/Tauri 继续使用共享 workbench/domain/codecs；平台原生实现差异保留在 adapter/service。
- 保持应用身份、用户数据路径、SQLite schema 与已有配置兼容，不迁移或清空用户数据。
- 回归使用本机回环、隔离 SQLite/PTY；不扫描现场网络。
- 每个问题先运行应当正确的失败用例，最小修复后运行对应测试；独立复核及最后全量门禁。

## Task 1：L1–L4 原生正确性与持久化

Files: Electron `modbusService.cjs` 与必要局部 handler helper、`tcpService.cjs`、`database.cjs`、`transportPersistence.cjs`、`main.cjs`；共享 `packages/persistence-contract/src/batchedPersistence.js`；Tauri `database.rs`；对应 tests。必要 UI 持久化错误展示只修改实际承载该事件的组件/模型/adapter，范围在报告逐项记录。保留已有压力改动。

Produces: FC15 全范围原子校验应答；失败可检测且有界的 flush；transport 枚举预检；正常 EOF 尾部输出。

- [x] 将原始 TCP/SQLite 复现转成维护测试：FC15 写 3 位到 2 位区域须 exception02 且 map 不变，合法 2 位成功；真实 SQLite 锁导致 flush 失败且应用错误可见，后台失败无 unhandled rejection；unsupported transport 导入保留活动 listener；三 framing 的 client/peer EOF 保留 xy、overflow 丢弃。
- [x] 先运行受影响 Node 测试，保留每项预期失败日志；Tauri transport 枚举以 Rust SQLite 测试在 close barrier 前拒绝。
- [x] 最小实现上述约束，不编辑 node_modules，不将 FC15 改成可能部分成功的逐位写入；对写入失败分离后台报告和显式屏障。
- [x] 运行相关 Node/Rust 与必要真实 TCP/RTU 测试，自查旧会话/资源关闭/有界内存；交付 report 和 scope diff，独立复核规格与质量。

## Task 2：L5/L6/L7/L10 协议与草稿

Files: `packages/codecs/src/dlt645.js`、`model/dlt645SimulatorConfig.js`、`model/modbusMasterConfig.js`、`components/Dlt645SimulatorPanel.vue`、`ModbusRequestDialog.vue`、`ModbusRequestGroupDialog.vue`；对应 codec/config/lifecycle/component tests。

Consumes: 当前共享配置与保存模型，保持 Task1 的原生保护。Produces: 可表示 BCD、原始草稿验证、revision 保存保护、噪声后继帧恢复。L10 可选恢复状态由主站组件与模拟器控制器共同消费/重置，覆盖坏帧内伪长头及跨分片恢复。

- [x] RED：79.9999 正负正常，80/89.1234 正负拒绝；保存 231.6 中改232.7 后仍可保存新值；空值/1.5/2.5/NaN 不发 save；坏长帧后合法帧被解析且应答、分片保留。
- [x] 修复 encoder 范围、先校验原始草稿再 normalize、模拟器 revision、损坏候选字节搜索；旧配置缺省继续支持。
- [x] 运行 codec/config/scheduler/simulator/相关组件回归及 lint；交付失败/通过证据、独立复核。

## Task 3：L8/L9/L11/L12 共享工作台

Files: `model/createWorkbenchModel.js`、`messageFilters.js`、`sendPayloadCodec.js`（或新共享发送分帧模块）、`components/SendLibraryPanel.vue`；必要呈现/目标 context 引用和对应 Node/组件/e2e tests。`SendPanel.vue` 与 shared model 可按逻辑 bytes/wire bytes 契约最小调整，平台不复制实现。

Consumes: Task1 持久化错误展示可能接入 model 的既有变更；当前模板/历史 logical bytes。Produces: 四类分类、实际正文地址搜索、一致模板删除、共享 framing wire bytes。保留实际 DL/T 已组帧发送的 dlt645 标记透传；原生描述限 endpointId/bytes/target/framing。模板成功删除也合并到尚未完成的对应端点列表加载，避免旧快照复活已删除行。

- [x] RED：Modbus 分类包含四类端点；原生 Hello device/peer 地址匹配；连续删除 A/B 不残留 A；真实回环发送 ping 的 line 字节为 70 69 6E 67 0A、prefix 为 00 00 00 04 70 69 6E 67、none/datagram 70 69 6E 67。
- [x] 在共享 command 将逻辑 bytes 编成 wire bytes 恰好一次；line 保留已存在行尾，prefix 4 字节 BE。模板/历史继续 logical payload，load/re-send 与定时发送不重复 framing，HEX/JSON、CRLF 组合覆盖。
- [x] 修复分类谓词、真实 bytes/peer context 搜索、资料库并发处理；保留 endpoint/generation/session 保护。
- [x] 运行相关 Node/组件、真实 wire 回环与双端浏览器受影响用例；说明默认分帧与模板/历史兼容，交付独立复核。

## Task 4：全量回归、最终复核与交接

- [x] 当前源码 `npm test`、`npm run lint`、`npm run build`、Rust fmt/test、`npm run test:e2e`、构建边界；按影响范围执行双端 TCP/UDP/PTY、Modbus TCP/RTU 互通和 Electron 桌面验证。
- [x] 最后整个 L1–L12 改动独立复核，解决本次引入的具体问题；不重跑无必要的 20 分钟压力测试。
- [x] 更新产品修复验收说明、阅读地图必要边界与 framing 使用规则，工作区任务/STATUS 和原始报告的后续状态；明确未提交/平台边界。

## 执行说明

用户授权优先于技能默认 worktree、自动提交和重复设计审批。计划/规格持久存放产品 docs；工作区 scratch 保存 baseline/brief/report/review/日志与进度。任务串行处理，同一原目录不并发编辑。
