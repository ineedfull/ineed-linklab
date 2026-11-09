# LinkLab 压力与异常通信复核（2026-10-13）

本轮本机验收完成：发现并修复 5 类原生通信/历史问题，Electron 与最终 Tauri 修复版均通过至少 20 分钟可见负载、3 分钟恢复及全量 SQLite 历史门禁。Tauri 首轮 UDP 错序失败证据保留，修复后重新跑完整可见长测。源码起点为 `ae1b8da`，保留此前桌面品牌修改。环境为 macOS arm64、Node 26.10.0、Electron 43.1.0、Tauri/WKWebView。原始证据位于工具工作区 `scratch/2026-10-13-linklab-visible-soak/`。内存观察有明确限制，见后文。

## 已复现与修复

| 问题 | 复现证据 | 修复及已验证行为 |
| --- | --- | --- |
| Tauri TCP 并发大报文字节交错 | 客户端和服务端各 4 个发送线程、每报文 512 KiB、发送缓冲区 4 KiB、对端延迟 100ms 开始读取。修复前报文内部出现其他报文的字节；日志 `concurrent-tcp-isolated-red.log` | 同一端点的发送锁覆盖 `write_all` 的全部部分写入与出站历史入队；不同端点使用独立锁。两项真实回环测试通过；并发 IPC 的先后处理顺序仍不保证等于 JavaScript 发起顺序 |
| macOS TCP 服务端大报文提前停止 | 不加入并发，只发送 512 KiB 并让对端较慢读取；修复前返回一次 peer 发送失败，见 `accepted-tcp-red.log` | 接受的 socket 显式使用阻塞模式及现有 2 秒写超时。macOS 接受的连接会继承监听 socket 的非阻塞模式，仅靠 `write_all` 不能等待可写缓冲区；完整字节内容、长度和成功反馈均已通过原生测试 |
| Tauri 空闲串口读取造成发送饥饿 | 原生循环第 38 轮出现批次延迟 2332ms。独立 PTY 复现中发送一个字节等待 655ms，见 `serial-latency-red.log` | 读写分别持有原生克隆句柄，保持写入串行，并在关闭时释放两个句柄。最终原生循环 1,620 次写入最大等待 9ms；双端 PTY 批次延迟 201～216ms，设备移除与资源清理检查均通过。实体串口与其它操作系统还需验收 |
| Electron 串口出站历史顺序错误 | 真实桌面后台 6 分钟收发中 PTY 帧完整，但出站历史按 drain 回调完成顺序记录，8,080 帧中有 5,595 个位置与实际收帧不一致；见 `electron-background-history.log`。延迟首个 drain 的回归也重现 `[2,3,1]` | 同一会话将 write、drain、历史入队作为串行任务，并在执行前重新校验会话，防止关闭后的排队写入。两项新回归先失败后通过；串口测试 49/49，完整 Node 回归 1,028/1,028。修复后 Electron 可见长跑 174,720 帧全部内容、频次与收发历史顺序验证通过 |
| Tauri UDP 出站历史顺序错误 | 首轮双端可见长跑的 Tauri UDP 113,040 个独立帧全部完整，但 83 个历史位置与本机收帧顺序不同；见 `tauri-history-final.log`。暂停首个真实 datagram 发送后的历史提交，在客户端和服务端都重现记录 `[2,1]` 而实际发送 `[1,2]`，见 `udp-order-red.log` | 同一会话用发送锁覆盖原生 datagram 发送与历史入队。两项默认 Rust 回归先失败后通过；Rust 最终 172 通过。修复后 `udp-fixed/tauri/` 完整可见长跑 1,576,960 帧全量门禁通过，其中 UDP 每方向 112,640 帧顺序一致；原始失败长跑仍保留 |

TCP 三项与 UDP 两项回归属于默认 Rust 测试；串口饥饿回归需要真实隔离 PTY，默认忽略，由 `serial-latency.mjs` 实际执行。没有降低原有 PTY 批次延迟验收门槛，也没有跳过 UDP 顺序核对。UDP 协议本身不承诺网络顺序；这里验证的是受控本机回环下的实际发出顺序与应用出站记录之间的一致性，不向产品增加公网 UDP 保序承诺。

## 本轮已执行的检查

- 最终 `npm test`：Node 1028/1028、组件 245/245。没有改前端产品代码；新增两项 Electron 串口行为回归。
- `npm run test:e2e`：126/126，包含双端浏览器适配器及普通/大字、主题、窄窗口等现有用例。浏览器适配器结果不代表原生桌面长跑。
- 最终 `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml`：172 通过、5 项默认忽略；忽略项通过专门的原生入口补测。
- Electron 原生 TCP 客户端/服务端分别完成 4 路 × 512 KiB 慢对端并发发送；完整接收 2 MiB、内容无交错，shutdown 后 session 为 0。Tauri 三项大报文回归也通过，见 `concurrent-final/`。
- 修复后重新执行超限 TCP 测试：Electron 30 个恶意连接、每连接 1 MiB + 1 字节；Rust 10 次，覆盖 delimiter/idle 的原生超限分支。受影响连接关闭、健康 peer 碎片帧仍完整、监听继续，没有截断攻击帧进入正常接收。
- Modbus Electron/Rust TCP/RTU 双向互通已通过。
- 原生重复负载：修复前的第 38 轮失败证据保留在 `native/`；`native-final/native-summary.json` 最终通过，持续 1,223,441ms（20.39 分钟），81 轮、324 个门禁。每轮实际执行 TCP、UDP、PTY 与空闲串口发送延迟检查。Tauri 修复覆盖全程；Electron 历史顺序修复在该循环后段应用，另以修复后的完整可见桌面长跑核对大量历史。

## 首轮可见桌面长跑

两端均使用同一宿主和页面完成持续负载及三分钟恢复观察。采样没有锁屏、隐藏或最小化记录，图标图片均成功解码。

| 运行时 | 持续负载 | 恢复观察 | 入站加出站帧 | 端点打开 | 非法发送拒绝 | Modbus 事务 | 退出后历史核对 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Electron | 1,239,498ms / 20.66 分钟 | 约 180 秒 | 174,720 | 129 | 31 | 312 | integrity_check=ok；TCP/UDP/PTY 内容、独立序号频次、出站与收帧顺序全部通过，无错误日志 |
| Tauri（UDP 修复前） | 1,230,145ms / 20.50 分钟 | 约 181 秒 | 1,582,560 | 1,133 | 282 | 2,826 | integrity_check=ok；全部独立序号完整，TCP/PTY 顺序通过；UDP 83 个位置错序，因此整轮最终历史门禁失败 |

首轮 WebKit 使用 responsibility API 关联到 Tauri 宿主 PID 71342；WebContent 72075、GPU 72074、Networking 72102 保持身份。Electron 宿主 71116、renderer 71120 也保持身份。1420 秒附近退出属于负载加恢复完成后的正常测试清理，没有用重启解释运行中回收。

| 首轮进程 | 物理内存占用峰值 MiB | 负载结束附近 MiB | 清空静置末 MiB | 断开静置末 MiB | RSS 峰值 → 断开末 MiB |
| --- | --- | --- | --- | --- | --- |
| Electron 宿主 | 136.49 | 132.91 | 132.88 | 132.81 | 266.91 → 266.34 |
| Electron renderer | 242.05 | 161.88 | 159.63 | 159.63 | 341.83 → 303.06 |
| Electron GPU | 548.14 | 57.69 | 42.49 | 42.49 | 94.77 → 87.55 |
| Tauri 宿主 | 81.05 | 80.27 | 64.91 | 63.44 | 173.78 → 158.17 |
| Tauri WebContent | 264.41 | 202.85 | 176.16 | 176.16 | 663.12 → 661.20 |
| Tauri GPU | 263.06 | 21.08 | 21.00 | 21.05 | 52.44 → 52.34 |

来自每 10 秒 `proc_pid_rusage` 的 RSS 与 `ri_phys_footprint`，阶段取进度文件标记区间的首末观测。Tauri 阶段即时推送，采样定位误差约一个 10 秒间隔；Electron 进度每 60 秒转存一次，因此阶段附近读数可能滞后约 70 秒，不能用作精确瞬时回收时点。GPU 物理内存记账包含共享/图形资源，不能只读 RSS 或直接累加它来宣称应用私有堆大小。Tauri WebContent 后半程物理占用范围 204.85～254.92 MiB，RSS 632.64～663.12 MiB；清空/断开有物理回收，但 RSS 未回到初始 302.34 MiB。此轮不能证明所有泄漏已排除，也尚未获取分配调用栈归因；这是明确保留的内存诊断限制。原始 `native-samples.json` 与 `resource-analysis.json` 保留全部采样。

## UDP 修复后 Tauri 最终验收

`udp-fixed/tauri/summary.json`：持续负载 1,230,403ms（20.51 分钟）、总时长 1,410,902ms（含约 180 秒恢复），1,408 轮、1,129 次端点打开、281 次非法发送拒绝、2,816 个 Modbus 事务。最终保存 1,576,960 帧：TCP 每方向 563,200、UDP/PTY 各每方向 112,640。`history-verification.json` 的 integrity_check=ok，六组方向的内容、独立序号频次均无差异，三个端点的出站与实际收帧顺序相同，运行和数据库错误日志均为空。10,000 / 100,000 UDP 实时只读检查作为中途证据保留，最终仍执行全部帧验证。

宿主 4081、WebContent 4251、GPU 4250、Networking 4252 在该轮内保持身份，页面 time origin 和 URL 未变。每 10 秒采样未记录锁屏、隐藏或最小化；窗口/原生应用名称为 Ineed LinkLab，图标图片成功解码。清空及断开后的显示行数为 0。两个正式验收宿主、对应 WebKit XPC、socat 与压力脚本退出，采样末尾关联进程组为空；没有清理其他工具的进程。

| 最终 Tauri 进程 | 首次观测物理占用 MiB | 物理占用峰值 MiB | 负载结束附近 MiB | 清空静置末 MiB | 断开静置末 MiB | RSS 峰值 → 断开末 MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 宿主 | 66.63 | 79.33 | 78.85 | 64.39 | 62.72 | 170.20 → 155.44 |
| WebContent | 495.52 | 495.52 | 230.99 | 202.17 | 202.20 | 706.16 → 704.23 |
| GPU | 254.34 | 256.45 | 15.77 | 15.59 | 15.58 | 48.89 → 48.77 |

第二轮 WebContent 在首次观测有 495.52 MiB 启动峰值，后半程物理占用为 246.91～286.49 MiB，RSS 662.14～706.16 MiB。清空/断开物理占用降至约 202 MiB，RSS 保留约 704 MiB。与首轮分别记录，不把重新启动后的数值当作同一进程的回收证据。这些观测确认运行中存在回收，也保留 RSS 随负载增加及分配归因未完成的限制；没有宣称所有内存问题均已解决。

## 可重复入口

先在仓库根目录运行 `npm run build`，安装项目依赖及本机 `socat`。当前可见长跑计划如下，结果目录每次使用新路径：

```sh
LINKLAB_SOAK_UI=1 LINKLAB_SOAK_BURST=4 LINKLAB_SOAK_MS=1200000 LINKLAB_SOAK_IDLE_MS=180000 LINKLAB_SOAK_OUT=/tmp/linklab-soak-new/electron node tooling/soak-test/desktop-soak.mjs electron
LINKLAB_SOAK_UI=1 LINKLAB_SOAK_BURST=4 LINKLAB_SOAK_MS=1200000 LINKLAB_SOAK_IDLE_MS=180000 LINKLAB_SOAK_OUT=/tmp/linklab-soak-new/tauri node tooling/soak-test/desktop-soak.mjs tauri
node tooling/soak-test/verify-history.mjs /tmp/linklab-soak-new/electron
node tooling/soak-test/verify-history.mjs /tmp/linklab-soak-new/tauri
node tooling/soak-test/concurrent-tcp.mjs
node tooling/soak-test/serial-latency.mjs
node tooling/soak-test/adversarial-tcp.mjs
LINKLAB_SOAK_MS=1200000 node tooling/soak-test/native-contract-soak.mjs
```

每轮发送 TCP 400、UDP 80、PTY 80 个独立 16 字节序号帧，读取 Modbus 主从一致性并按 UI 按钮重新开关端点。并发 IPC 可以改变发起顺序，因此核对独立序号的完整内容及频次，再核对收帧和实际出帧历史的顺序；另用 `LINKLAB_SOAK_SEND_MODE=sequential` 检查按原始序号严格递增。固定负载结束后依次连接静置、清空实时视图、断开静置各 60 秒；清空视图保留 SQLite 历史供退出后完整性检查。

这是固定时长内尽力发送的可靠性负载，并非固定吞吐的双端性能对比。Electron 每次串口发送等待原生 drain 完成；Tauri 当前写入路径不同，因此各端循环数和总帧数不同。最终结果按各端实际发送的独立序号逐条验证，不用另一端的吞吐作为完整性基准。

仅使用回环网络、socat 虚拟串口与新隔离数据库。Electron 使用品牌开发宿主加载生产 main/preload/dist；Tauri 使用品牌运行入口、随机测试 identifier 和临时 devUrl 加载已构建 dist。真实收发走原生 IPC，DOM 操作覆盖端点开关和实时视图。未改用户数据、正式应用 ID、正式签名或安装包。

## 环境与验收边界

本轮短测曾在启动后遇到锁屏，窗口最小化且 WKWebView 定时器被暂停，因此未纳入可见窗口长跑结果。用户解锁后完成上述长跑，临时使用 `caffeinate -di` 保持显示器唤醒，随测试退出已结束。锁屏期间独立 Electron 后台补测发现串口历史顺序问题，作为失败证据保留，不能替代修复后可见双端验收。上轮 Tauri 只采宿主 RSS，不能替代本轮 WebContent 资源验证。

本轮没有 Windows/Linux、macOS x64 实机、实体串口、安装包升级、正式发布或现场网络攻击验收；本地畸形输入验证也不是外部安全审计。尚未提交代码。
