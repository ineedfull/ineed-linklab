# LinkLab 可读性 Review 与遗留代码清理 · 2026-11-02

## 范围与基线

源码仓库 `ineed-linklab`，分支 `codex/modbus-raw-matrix`，起始 HEAD `7178b2a`。
本轮以最近的端点/Modbus 表单、工具入口、设备模板和验收调用链为中心，检查纯转换、
视图状态、持久化顺序与失效样式。原有窗口表单和工具箱入口改动均保留。
此报告不代表对全部原生协议实现重新逐行审计；使用说明与当前入口见[阅读地图](../code-reading.md)。

## 已处理问题

| 编号 | 问题与影响 | 处理与行为保护 |
| --- | --- | --- |
| R1 | 端点弹窗同时承担协议字段转换、保存校验和焦点生命周期，新增字段时需要穿过大量无关逻辑 | 提取 `model/endpointDialogForm.js`，集中 `createEndpointForm` / `buildEndpointConfig`；共享串口字段、独立 Modbus 连接选择；组件保留原校验与保存代次 |
| R2 | “TCP 高级设置”样式实际被 TCP、DL/T 与 Modbus 共用；旧的 5/8 列规则被后加载样式覆盖 | 改为 `endpoint-parameter-section`，分组/勾选项/栅格归入 `dialog-forms.css`，删除旧声明，保留 DL/T 输入行对齐规则 |
| R3 | 模板面板成组声明短变量，预览统计嵌在模板表达式中，实例化部分成功后的重试边界不直观 | 拆分状态声明，明确 sourceEndpointId、selectedTemplateRevision、siteDraft、pendingAcceptancePlan 等命名；统计改为计算属性；解释端点先保存、方案失败只重试方案的不变量 |
| R4 | 工具箱使用笼统的 show/close/select 和层叠三元式，定位数字缺乏含义 | 使用 openMenu/closeMenu/selectTool/handleMenuKeydown，命名菜单宽度与视口留白；展开键盘选择步骤，保持触发按钮焦点恢复和 WebKit Tab 顺序 |
| B1 · P2 | Modbus 从站按输入数量填充数组后才校验；超大整数可造成过量分配，表单 Infinity 可让填充循环持续执行 | 表单和领域归一化都在分配前限制数量；保留非法数值用于校验，超限候选不填充数据数组；有效数量保持值前缀、补零/false行为 |
| B2 · P2 | 数据区非整数起址/数量先被归一化成默认值，校验可能误接受输入 | 同时检查源字段整数性；未提供的旧配置字段继续使用原默认值 |

B1 用 `MAX_MODBUS_AREA_COUNT + 1` 做有界复现：修复前仍扩展出 10001 个值，
新增回归失败；修复后不分配该数组并报告数量错误。随后才执行 1e9、Infinity、NaN、
负数、小数等表单边界；合法 10000 上限、值前缀和不修改原配置均有回归。

## 删除与保留

- 删除没有有效样式消费者的 `endpoint-dialog--device-model` 标记及其实现细节断言，保留从站数据保存测试。
- 删除被覆盖的旧分组边框/legend、Modbus 5 列/8 列及旧断点声明；移走 desktop.css 中重复的参数勾选项规则，统一到表单文件。
- 删除弹窗中已提取的重复初始化与保存转换，串口连接字段只维护一份。
- OPC UA 早期原生验收脚本仍覆盖 Int64、确认读写、CSV 等不同路径，尚不能确认完全被新脚本替代，因此本轮保留。兼容配置、数据迁移、历史验收材料不因年代久而删除。

## 验证

验证在源码根目录执行，使用隔离数据与本地回环；以下为本轮最终结果。

- `npm test`：Node 1346 / 1346，组件 36 文件、354 / 354 通过。
- `npm run lint`：通过。
- `npm run build`：Electron / Tauri 两套 renderer 通过，保留既有 chunk 大小提示。
- `npx playwright test -c packages/workbench/playwright.form-layout.config.js`：164 / 164 通过（12.6 分钟），两端入口 × Chromium/WebKit，包含主题/大字/侧栏/窄窗口和键盘检查。
- `npx playwright test -c packages/workbench/playwright.config.js device-templates.spec.js acceptance.spec.js toolbox.spec.js`：42 / 42 通过（1.4 分钟），三种视口 × 两端入口；覆盖导入导出、两现场实例、不可变版本/报告、工程量断言、九类转换与通信草稿。
- `git diff --check`：通过。
- 人工查看浅色请求表单、WebKit 深色大字端点窗、折叠侧栏工具箱截图；保留在工具工作区 `scratch/2026-11-02-linklab-readability/`。
- 本轮未修改原生协议或存储格式，未重新进行原生安装包、长压和其它系统实机验收。

## 交接

本轮源码与文档未提交、打包或发布。此前 UI 整理改动仍在同一工作目录。
