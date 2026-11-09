# LinkLab 长跑问题修复与验证（2026-11-09）

本轮针对 11 月 8 日长跑暴露的连接关闭、窗口恢复与内存问题。使用 macOS 本机回环、隔离 SQLite 与伪终端；不访问现场设备或线上存储，不提交或发布。

## 已实现

### Modbus 关闭期间保留所有权

`ModbusService` 分别登记 opening、sessions、closing。关闭时移入 closing，原生资源确认关闭后才释放端点。重复关闭、取消和退出加入同一个 closePromise；失败保留身份，允许重试，禁止旧回调影响新连接。请求错误触发的退休不等待该请求自己的队列，避免自等待。

强制清理可以跳过未完成请求的排空，但仍加入同一次原生关闭。它不会伪造关闭成功，也没有加入周期重启、强杀或丢弃资源所有权的产品兜底。

### macOS 恢复窗口

activate 会恢复、显示并聚焦已有窗口。窗口已关闭且主事件循环仍能处理激活时，正常等待旧连接收尾，最多等待 2 秒即恢复桌面窗口。旧资源仍由原服务拥有；清理期间新的连接、发送、删除端点等操作返回 PORT_BUSY。配置与历史可读，OPC UA 客户端/服务端配置直接从原有本地文件读取，不调用已退出的 SDK。迟到清理完成不会多建窗口。应用退出期间不恢复窗口，并释放恢复计时器。已进入 Node CleanupHandles、无法执行 JS 的原生退出死锁不能由这个定时器恢复，不把两类问题混为一谈。

实际 BrowserWindow/IPC 测试人为延迟 TCP close 确认，验证恢复时限、读配置、连接屏障、迟到完成与实际进程退出；这是故障注入，不能替代真实串口根因复现。

### macOS Modbus 空读取空转

增加逐端口 `darwinModbusBinding.cjs`，通过 serialport 的 binding 选项接入，保留原生 open/close/write，仅替换 Darwin 的读取重试路径。保留现有 VMIN=0/VTIME=1 兼容参数；0 字节或暂不可读时，等待 2 ms 后重试，不立即递归。关闭与迟到结果验证原 fd 身份，设备拔出错误保留断开标记。未修改依赖文件、全局 fs 或所有串口的绑定。

隔离 Node/PTY 空闲 3 秒：原读取 278,742 次（278,741 次为空），新读取 1,145 次。真实双端口回归在旧实现 200 ms 产生 30,776 次读取而失败；新实现还核验有效主从应答、关闭和重开。仅修改 VMIN=1/VTIME=0 虽然空闲读取低，却导致真实 PTY 应答超时，已被回归拒绝，未作为最终实现。这个失败与全部原始故障都保留。

本适配依赖 bindings-cpp DarwinPortBinding 类型公开的 fd/isOpen 字段；升级 serialport 时需要复跑真实空闲/收发/重开及 Electron 退出验证。2 ms 是调度间隔，系统繁忙时不保证硬实时延迟。

### 消息预览减少分配

`framePresentation.js` 用 WeakMap 复用模型拥有的冻结帧预览，预览限制变化时重算；可变输入继续刷新。`FrameList.vue` 使用独立 `FrameRow.vue`，以稳定行、实际 peer 显示值和复制反馈作为 props。详情、复制成功/失败和 peer 改名继续更新。满 500 行滑动一行时，时间渲染从 500 次降至 1 次，保留行的 DOM 身份。早期 v-memo 方案在数组下标移位时仍会全部重算，已由先红后绿的真实组件回归识别并替换；不能把早期长跑说成最终行组件验收。

2,000 次更新、每次 500 行的纯预览基准：未变化行重建 998,000 → 0，Node 耗时 412.63 → 43.40 ms。该基准只证明此处减少分配，不能证明 WebKit 的高 RSS 已全部解决。

### Tauri 隐藏窗口持续调度

主窗口显式设置 `backgroundThrottling: disabled`。Tauri 文档说明该配置针对 macOS 14+/iOS 17+；Windows/Linux 不支持此开关。历史窗口沿用默认配置。

受控旧配置实验：隐藏窗口的 100 秒计时器在第 120 秒显示窗口后约 99 ms 才恢复。新配置全程隐藏、没有 Inspector、show、GC 或重载，11.489 秒负载加 5 分钟静置完成：6,440 帧、46 笔 Modbus 事务，三个 100 秒阶段准时推进，清空、断开与数据库统计通过。

## 验证记录

完整 Node 测试最终一轮 1,368 通过，Vue 组件 358 通过；Rust 230 通过、5 项既有忽略。对应 lint、双 renderer 构建通过。最终行组件已通过完整组件回归与双 renderer 构建；双入口三尺寸交互和原生复测另行记录。窗口恢复新增 OPC UA 配置、串口空闲回归均先失败后通过。

最终补充的行组件生命周期回归也已通过：满 500 行滑动一次，累计挂载 501 行、既有行更新 0 次、卸载 1 行。最后 lint 与 diff 检查通过。

### 最终原生与双端长跑

- `native-rtu-visible-bounded-reader/rtu-traffic-reopen/result.json`：最终逐端口读取适配，实际可见 Electron、原生 IPC、PTY 与独立 Node 主站，连续 1,200,343 ms、14,139 笔事务。关闭后重开保留一个可见窗口，实际应用正常退出 0，退出观察耗时 103 ms，没有强杀。主站在主动关闭从站后的收尾阶段超时，保留日志，不计为负载阶段失败。本项验证原生生命周期与协议链路，不等同于逐项操作全部 Modbus 面板。
- `native-rtu-independent-master/rtu-traffic-reopen/result.json`：旧原生读取配合独立 POSIX Python 主站，校验 CRC 与完整应答，20 分钟、13,903 笔事务、窗口恢复与退出 0 均通过。旧读取仍有较高 CPU，且也存在成功长跑，说明原退出问题具有间歇性；不能把全部旧失败都归因到空读取。该对照不是修复版验收，主动关闭后的主站超时同样保留。
- `ws-stable-rows/summary.json`：最终 FrameRow，双端可见负载 600,099 ms，加 300,000 ms 自然静置，共 906,029 ms。每端保存 139,008 帧，9 次重连、36 项非法输入拒绝，序号完整性、各流 wire 顺序摘要、跨端顺序与 SQLite 完整性全部通过，无 renderer 错误或警告。没有 Inspector、强制 GC 或重载。该长跑的测试窗口配置尚未继承后台调度属性，因此只作为可见窗口验收；隐藏行为由前述正式配置试验验证。
- `ws-final-config/summary.json`：修正 duel 脚本继承产品主窗口属性后，最终组合短测通过；每端 24 帧，实际配置包含 `backgroundThrottling: disabled`。仅作组合启动与 IPC 冒烟，不计作长跑。
- `native-window-recovery-complete/result.json`：最终真实窗口恢复故障注入，2,157 ms 恢复；OPC UA 两类配置读取成功，连接与删除端点均返回 PORT_BUSY，迟到完成后只有一个可见窗口，应用实际退出成功。

### 自然内存结果：Tauri 高占用仍未关闭

下表为最终 FrameRow 双端运行的同一进程采样，单位 MiB。Tauri RSS/footprint 均为 WebContent，Electron RSS 为 renderer，不能代表整款应用全部进程总量。

| 阶段 | Tauri RSS | Tauri footprint | Electron renderer RSS |
| --- | ---: | ---: | ---: |
| 开始负载 | 80.22 | 84.14 | 149.89 |
| 负载结束 | 889.81 | 342.81 | 319.22 |
| 保持连接静置 | 889.38 | 341.69 | 263.72 |
| 清空视图 | 889.44 | 354.30 | 264.50 |
| 清空后静置 | 889.38 | 320.20 | 264.44 |
| 断开后静置 | 889.52 | 320.11 | 265.61 |

RSS 在断开后仍约 890 MiB，不能宣称内存问题修复。此前 memo 候选 20+5 分钟运行每端 174,336 帧，最终自然 RSS 1,180.25 MiB、footprint 443.56 MiB；两轮时长与吞吐不同，不据此计算内存改善百分比。原始采样和摘要保留在各目录的 `memory-summary.json`。

## 仍需区分的证据

一次旧 renderer 的 5 分钟双端诊断各保存 44,800 帧，数据库完整性、序号与 wire 顺序通过。Tauri 估算 JavaScript 堆从负载约 10.46 MiB 回到清空约 2.96 MiB；自然静置 RSS 744.5 MiB。随后显式诊断堆快照触发回收才降至约 186.5 MiB。后者只用于归因，不能写成自然内存验收结果。

新生命周期修复、尚未加入最终有界读取时，曾在 4,104 笔事务后复现停止/退出挂起，窗口恢复有效，正常退出仍等待未返回的原生关闭。独立 Node 主站本身也出现超时和关闭挂起；最终补做 Python 主站对照与有界读取长跑均通过，但无法唯一证明此前每次首故障的来源。原生退出根因保留待查，不能据通过长跑或窗口恢复就宣称全部修复。

Electron 上游 PR #54228 关于 libuv 唤醒的讨论仅为调查线索；未证明与本故障同源，也没有改 Electron 或向产品加入周期唤醒。

## 复测入口与边界

基础命令在仓库根目录执行：`npm test`、`npm run lint`、`npm run build`。原生双端脚本为 `tooling/websocket-test/desktop-duel.mjs`，通用负载为 `tooling/soak-test/desktop-soak.mjs`；后者等待预算现在包含 idleMs，并记录恢复阶段时间和 visibility。

详细原始证据保存在工具工作区 `scratch/2026-11-08-linklab-soak-fixes/`，任务索引为 `tasks/2026-11-08-linklab-soak-fixes.md`。原失败保留。没有新增 Windows/Linux 实机、实体串口、安装包或 Ubuntu/RK 板端验收；没有修改其它三款 Tool。
