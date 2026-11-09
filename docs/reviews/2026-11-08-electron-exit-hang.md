# 2026-11-08 Electron退出挂起调查

## 已确认的现象

旧Electron PID94607来自11-05的Qt独立联调run-10，用户反馈Dock图标存在但窗口无法打开。恢复前已无renderer；主进程2秒采样的全部主线程样本停在：

```text
node::FreeEnvironment
  → node::Environment::RunCleanup
  → node::Environment::CleanupHandles
  → uv_run → uv__io_poll → kevent
```

这说明采样时已进入Node原生环境清理，尚未释放全部底层句柄；不能据此判断具体句柄，也不能确定最早是谁发起退出。旧Inspector HTTP列表可返回，但执行超时，renderer CDP超时；SIGTERM未使残留进程退出，保留sample后才对该PID使用SIGKILL。未发现以Electron/LinkLab命名的系统崩溃报告；目录中的`vw-linklab-interop`报告属于Qt验证程序，不能算作Electron崩溃证据。

旧主进程物理footprint及其峰值均237.2MiB；没有证据将此次挂起归因为内存耗尽，亦不能用该采样推断renderer此前的内存。当前只能定位到退出清理阶段，未定位触发条件与具体原生资源，不宣称已经修复根因。

## 本机隔离复现

macOS27.0.1、Electron43.1.0 arm64、生产main/桥/Modbus服务与已构建renderer；每例独立用户目录、仅本地PTY。诊断bootstrap观察退出事件和资源类别，不修改产品协议实现。下列耗时按100ms轮询精度记录：

| 场景 | 观察结果 |
| --- | --- |
| 空白程序正常退出 | exit0，约302ms |
| 已打开RTU从站后退出 | exit0，约207ms |
| RTU关闭主窗口→activate重开→退出 | 重开成功，退出约102ms |
| RTU伪串口对端消失后退出 | exit0，约101ms |
| 已打开RTU时直接app.exit诊断 | exit0，约203ms；非推荐的正常退出流程 |
| 已打开RTU时SIGTERM | 正常shutdown链完成、exit0，约101ms |
| 持续RTU收发过程中退出 | 36笔事务后exit0，约102ms |
| 原LinkLab＋Qt完整联调脚本 | 3 passed/0失败/0跳过，78.269秒；134笔事务、60秒自动变化、Qt/LinkLab/socat均退出，无本轮残留 |

因此短时RTU收发、常规窗口恢复、PTY消失及终止信号均未复现旧实例挂起；这些通过结果不排除长时间运行或特定系统状态下的问题。完整联调顺手补齐Qt测试在“水位比测”后选择人工参考的新步骤，保留既有断言。

## 下一次可采集的线索

对恢复后的隔离可见PID32685附加当前进程内的观察器，最多记录256条事件：退出/关闭/activate、TransportCoordinator/Modbus/OPC UA/STOMP清理的开始/完成/失败类型、资源类别及窗口数量。事件写入工具工作区scratch，不记录端点配置、报文或凭据；不自动打开端点。观察器随当前进程退出消失，没有纳入发行产品或变更持久化结构。

这能区分下次是否未完成某个JS服务关闭，或所有服务已完成但仍卡在原生清理；原生具体句柄仍需当时的sample/lsof配合。现有Qt联调脚本`cleanup()`对`app.close()`没有总时限，是退出异常时可能让测试监督进程一直等待的独立风险，本轮未将增加强杀超时当成产品根因修复。

## 证据与边界

工具工作区`scratch/2026-11-08-linklab-exit-debug/`保留独立复现脚本、每例events/result、原完整联调结果、visible-exit-events.jsonl及观察器脚本；旧sample在`scratch/2026-11-08-vw-water-coefficient/linklab-process-sample.txt`。恢复证据在同日`linklab-window-recovery/`。

本轮未修改LinkLab产品逻辑、未重跑跨协议/长时压力或其它系统原生验收；既有Modbus自动变化开发保留，未提交/发布。

## 同日长跑补充：已再次捕获退出挂起

随后四款 Tool 长跑中的独立 RTU 专项，两次捕获了相同的原生退出清理停滞，不能再以早先短测正常作为问题已排除的依据。

| 隔离场景 | 有效负载与停止 | 关窗恢复 | 实际退出 |
| --- | --- | --- | --- |
| 原始 Python 非阻塞驱动，隐藏窗口，20 分钟进程观察 | 2451 笔后驱动约 209 秒停止；后续独立主站超时，关闭端口请求超过 8 秒未完成 | 恢复出可见窗口 | 10 秒未退出；先保存 sample，后 SIGKILL |
| 独立 Node/modbus-serial 主站，Darwin vmin=0/vtime=1，20 分钟进程观察 | 3374 笔后约 277 秒停止增长，客户端进程仍在 | activate 已收到，但 800ms 后无主窗口 | 10 秒未退出；先保存 sample，后 SIGKILL |
| 附 async_hooks 的 6 分钟诊断组 | 4384 笔，持续增长 | 恢复成功 | 约 101ms，实际 exit0 |
| 附 async_hooks、独立主站与客户端关闭时限的 12 分钟组 | 8749 笔有效收发，未停滞 | 恢复成功 | 约 100ms，实际 exit0 |

两次异常退出的主线程均停在前述 `FreeEnvironment → RunCleanup → CleanupHandles → uv_run/kevent`。第二次关窗触发的首轮 `ModbusService.closeAll` 没有完成事件；随后 shutdown 调用却已完成，`will-quit` 与 JavaScript `process-exit` 也已记录，操作系统进程仍未结束。这证实仅观察 JS 退出事件或 shutdown Promise 不足以判定真正退出。

6 分钟诊断发现未完成的 `FSREQCALLBACK` 来源于 `@serialport/bindings-cpp/dist/unix-read.js → fs.read`，但正常异步串口读取也会存在该资源；这组本身正常退出，不能仅凭该调用栈认定根因。64KiB 读缓冲多次正常轮换，固定缓冲边界触发的假说暂不成立。

第一组包含后续 Inspector 关闭端口与定时器诊断，第二组没有这些修改，仍捕获同阶段挂起，因此现场不只依赖第一组诊断操作。不过两组均使用 macOS PTY；第二组主站的异常退出也被其 await close 隐藏，收发停滞最先发生在客户端、PTY 还是 LinkLab 仍未证明。没有把原始驱动停滞后的时间计为持续有效负载，也没有把 SIGKILL 算作正常退出。

新增证据位于工具工作区 `scratch/2026-11-08-tools-long-soak/`：

- `exit-rtu-long/rtu-traffic-reopen/{result.json,events.jsonl,sample.txt}`：第一组退出结果及采样。
- `exit-rtu-strict-02/rtu-traffic-reopen/{result.json,events.jsonl,sample.txt}`：独立主站复测、窗口缺失及退出采样。
- `exit-rtu-diagnostic/rtu-traffic-reopen/{result.json,latest-state.json}`：正常诊断对照。
- `exit-rtu-async-strict/rtu-traffic-reopen/{result.json,latest-state.json}`：12 分钟独立主站诊断对照。
- `rtu-strict-{main,client,socat}-sample.txt`、`rtu-before-close-state.json`：停滞时三方状态。

后续优先在保留原生读取调用来源的情况下，区分关闭中的 session 过早移除、底层 read 取消以及 PTY 特有行为；再用真实串口复核。当前为已复现、未修复，未增加强杀逻辑掩盖资源释放问题。

### 已确认的上层生命周期缺陷

代码核对和可控延迟关闭复现确认：`ModbusService.close()` 在等待队列和 `closeResource()` 之前执行 `sessions.delete(endpointId)`，且没有单独保存 closing session/Promise。首次 native close 不返回时，第二次 close 会返回 `closed:true`，shutdown 也能完成，底层资源仍打开。`closing-session-repro.cjs/json` 使用真实 ModbusService 与可控关闭回调验证了这个顺序；主动释放回调后首轮关闭才真正结束。此复现证明上层记账缺陷，不模拟也不解释原生 read 最初为何停滞。

同一情况下，`main.cjs` 的 macOS activate 分支一直等待 `rendererTransportClosePromise` 后才 `createMainWindow()`。首次 close 不完成就没有恢复窗口的入口，与第二组“activate 已收到、主窗口仍为空”吻合。因此“关窗后无法再打开”和“shutdown 已完成但资源未释放”各有明确的代码路径，底层 read 停滞仍是待解部分。

建议修复方向：对关闭中的会话保留资源所有权，重复 close/全局 shutdown 等待同一关闭结果；为失败清理保留可重试状态；窗口恢复不因无界 native close 永久失去交互。需要验证晚到关闭不会销毁新连接、关闭失败不会误报成功及正常持久化不受影响，不能只加 app.exit/SIGKILL 作为修复。本轮按测试调查范围保留问题，产品行为尚未修改。
