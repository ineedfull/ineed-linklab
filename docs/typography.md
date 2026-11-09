# LinkLab 字体规范

## 时间显示

Electron / Tauri 共用 `packages/workbench/src/model/dateTime.js`。完整时间使用本地时区 `YYYY-MM-DD HH:mm:ss.SSS`（24 小时、补零、毫秒三位），缺失或无效值统一显示 `--`；避免操作系统默认的 `toLocaleString` 和直接显示协议 ISO 时间。

实时帧列表、趋势横轴使用紧凑的 `HH:mm:ss.SSS`；帧悬停/详情、趋势十字线/提示/缩放范围保留完整日期。消息、事务、历史、日志、采集状态与证书有效期使用完整格式。原始报文、数据库、导出与协议时间沿用数据契约；原生 `datetime-local` 控件遵循浏览器本地输入规则。

函数接收非负整数毫秒或带明确时区的 ISO/RFC3339 时间；不猜测纯数字字符串或无时区日期。Unix epoch `0` 是有效时间。作为协议数据出现的日期字符串不按界面时间擅自改写。

## 字体变量

Electron 和 Tauri 共用 `packages/workbench/src/styles/typography.css`。新增界面使用同一组语义变量，避免在组件里独立写死字号。

| 用途 | CSS 变量 | 普通模式 | 大字体 |
| --- | --- | --- | --- |
| 辅助说明、状态、时间 | `--font-size-small` | 11px | 12px |
| 页签、表头、表单、按钮 | `--font-size-control` | 12px | 13px |
| 正文、表格数据、协议读数 | `--font-size` | 13px | 14px |
| 品牌栏、当前连接标题 | `--font-size-heading` | 14px | 15px |
| 弹窗标题 | `--font-size-title` | 15px | 16px |
| 关于页产品名称 | `--font-size-display` | 20px | 21px |
| 消息原文、发送编辑器 | `--font-size-code` | 13px | 16px |

- 大字体通过文档根元素的 `large-font` 类切换变量，不再逐个组件覆盖字号。
- 同类信息使用相同变量。电表、Modbus 主站和模拟器的读数用正文大小，以字重表达强调。
- HEX、地址及报文可以保留等宽字体，但不依赖浏览器对 `code`、`pre`、`small` 的默认字号。
- 共用的关于页布局保持独立，LinkLab 的字体映射集中在 `typography.css`。
- CodeMirror 的独立挂载字号与代码字号保持一致（13/16px）；ECharts 从当前界面的变量读取字号，并在字体模式切换时重绘。
- 调整字号后，检查 1440×900、1120×720 和 820×1180 下的普通/大字体，确保弹窗操作区、表格滚动和按钮文字可用。

回归入口：`packages/workbench/e2e/typography.spec.js`。它比较同类协议信息的实际计算字号，验证其它工作台界面随大字体增长，并检查消息/日志历史窗口。

跨工具及后续 Tool 的统一时间基线见工具工作区 `docs/TOOL-DATETIME.md`；本产品继续由 `packages/workbench/src/model/dateTime.js` 统一格式化，新增模拟服务端的源/服务器时间同样复用此入口，不改变协议 DateTime 或导出格式。
