# Industrial Toolbox Implementation Plan

> 执行方式：用户明确要求本会话直接完成且不逐项确认；在原源码目录串行实施，保留现有未提交改动，不切换共享分支、不自动提交。

**Goal:** 提供离线的九类工业数据转换与校验工具，双运行时共用并保留通信工作台。

**Architecture:** `packages/codecs/src/industrial/` 中划分字节、整数/浮点、ASCII/BCD 和校验纯函数。workbench 的工具目录提供有标签的参数与统一结果，面板负责会话草稿、错误与复制；Shell 只增加工具入口。

**Tech Stack:** 既有 Vue 3、JS BigInt/DataView、Node test、Vitest、Playwright；无新依赖、原生命令或数据库迁移。

**Spec:** [工业工具箱范围与约束](../../industrial-toolbox.md)。首版范围为该文“首版”行；候选行不在本次实施承诺内。

## Global Constraints

- 65,536 字符 / 16,384 字节；BCD 128 位数字 / 小数位 0–12。
- 严格 ASCII、HEX、位宽和 BCD；溢出拒绝，不静默截断或舍入 BCD。
- 输入变化清除旧结果，保留每项工具会话草稿，离开不影响通信状态。
- CRC 预设显示完整参数，验证独立校验字节，不把计算当验证。

## Task 1：纯计算与已知向量

Files: create `packages/codecs/src/industrial/{bytes,numbers,text,checksums}.js`；create `packages/codecs/tests/industrialToolbox.test.js`；modify `packages/codecs/package.json` exports。

- [x] 写测试并观察 RED：严格 HEX、8/64 位补码、UInt64 最大值、Float32 1.0=`3F800000`、Float64 -0=`8000000000000000`、BCD `001234`、CRLF、CRC catalogue 的 `123456789` 向量、Modbus `01030000000A`=`C5 CD`、SUM/XOR/LRC 及错误/上限。
- [x] 实现 `parseToolHex(text) -> Uint8Array`、`hexBytes(bytes) -> string`、`reorderBytes(bytes, order) -> Uint8Array`；订单 `normal/swap-bytes/reverse-words/reverse`。
- [x] 实现 `convertRadix(input, base, width, signed)`、`encodeInteger(input,width,signed,order)` / `decodeInteger(hex,width,order)`、`encodeFloat(input,width,order)` / `decodeFloat(hex,width,order)`，返回明确信息而不丢精度。
- [x] 实现 `encodeAscii/decodeAscii`、`encodeBcd/decodeBcd`；BCD 字符串与显式小数位。
- [x] 实现 `calculateChecksum(bytes,id)` 和 `checksumDetails(id)`，预设标准参数，返回数值 HEX 与输出字节。
- [x] 运行 `node --test packages/codecs/tests/industrialToolbox.test.js`，GREEN 后检查既有 codecs 测试。

## Task 2：可操作的共享工具面板

Files: create `packages/workbench/src/model/industrialTools.js`、`packages/workbench/src/components/ToolboxPanel.vue`、`packages/workbench/src/styles/toolbox.css`；create Node model tests 与 `packages/workbench/tests/components/ToolboxPanel.test.js`；modify `LinkLabShell.vue`、`desktop.css`。

- [x] 写先失败的组件测试：计算后修改输入失效、无端点可用、工具草稿保留、示例/清空、错误可见、复制失败、Escape/focus restore。
- [x] 工具目录用 `TOOLS[{id,group,label,description,fields,example,run}]`；`runTool(id,input,options) -> {rows:[{label,value}], verification:null|boolean, note}`，统一中文错误和结果形状。
- [x] 面板采用显式计算，结果可选中复制，每项草稿独立；异步复制使用修订身份丢弃旧完成。
- [x] 入口放侧栏底部；展开能容纳三按钮，折叠底栏高度容纳三行图标。不卸载原通信面板。
- [x] 运行 `node --test packages/workbench/tests/industrialTools.test.js`、`npm run test:components -w @ineed-linklab/workbench -- ToolboxPanel.test.js`，观察 GREEN。

## Task 3：双端集成、显示与交接

Files: create `packages/workbench/e2e/toolbox.spec.js`；update README、`docs/industrial-toolbox.md`、工作区任务与 STATUS。

- [x] Electron/Tauri fixture 从工具箱做真实计算、复制、非法输入、工具切换及回到原发送草稿；检查无发送副作用。
- [x] 浏览器覆盖浅/深、普通/大字、展开/折叠与 1440/1120/920 窗口，键盘可到达并无溢出。
- [x] `npm test`、`npm run lint`、`npm run build`；按触及范围运行 About/桌面保留与工具箱 E2E；真实桌面验证计算入口，明确与浏览器 fixture 的区别。
- [x] 自审算法向量、边界、错序和异步状态；必要修复后仅重跑影响范围。
- [x] 写实际验收与剩余候选，不打包/上传新版本、不提交其他已有修改。

## 执行结果与限制

2026-10-16：三组九类工具已实施；全量 Node 1135、组件 288、工具箱 E2E 12、相邻界面 12、构建边界 59、lint 和双 renderer 构建通过。Electron/Tauri 原生工具箱、草稿保留及 TCP 回环通过；Electron 原生复制成功，Tauri 程序化复制的手动回退已验证。锁屏环境未人工观察桌面或验证 Tauri 真实用户手势复制，其他平台仍待对应环境验收。具体证据与不在本轮范围的候选见工业工具箱说明文末。
