# 多协议对攻与压力验证（2026-10-22）

环境：macOS 27.0.1（26A434）、arm64，Node 26.10.0、Electron 43.1.0、Rust 1.96.1。基线提交 `0d111b68e0809a6eb2a47522491c9829cc742110`，保留现有未提交多协议实现。

本轮针对 OPC UA / STOMP 多端点完成后的当前源码。Electron 与 Tauri 共用工作台，测试仅连接本机回环，使用隔离配置；没有修改用户数据、提交、打包或发布。前一轮 Node 1,237、组件 323、Rust 208（5 项原有忽略）、产物 61、浏览器 162 的门禁见[多端点验收](protocol-endpoints-verification-2026-10-22.md)。本轮新增压力证据与旧门禁分别记录。

## 测试设计

- 真实 macOS arm64 Electron + Tauri 桌面串行启动：交换服务端角色，各持续发送至少 600,000 ms；每方向两个原生客户端及一个独立 `@stomp/stompjs` 客户端。批量 32 条、批间暂停 50 ms。端点添加、连接、订阅和有限发布经过实际界面，持续负载调用已连接宿主的原生发送接口。
- 对每个连接核对负载正文完整顺序、无遗漏/重复，保存计数与 SHA-256；删除额外客户端后验证存活连接 ACK/NACK、清空消息后确认及重投。每应用补两条真实 OPC UA 会话/同时推进的订阅和删除隔离。
- 停止后静置 180 秒，先保留视图 60 秒，再清空所有已访问 STOMP 消息面板与测试观察器，继续 120 秒。同一进程与页面，不强制 GC、重载或重启。采样同时检查页面与原生窗口可见、未最小化、无异常及行数上限。
- OPC UA 无 GUI 原生入口单独持续 1,200 秒：加密用户名认证、显式信任、类型读写、恶意写入/订阅、三次服务端重启恢复、退订后静默与过期会话拒绝。
- STOMP 恶意矩阵、四会话容量/删除隔离和额外原生双向互通分别执行，不用浏览器 fixture 代替原生协议。

证据根目录：工具工作区 `scratch/2026-10-22-linklab-protocol-soak/`。首轮桌面失败输出 `desktop-final/`，诊断重跑输出 `desktop-final2/`，OPC UA 输出 `opcua-native-fresh/`，STOMP 输出 `stomp-attacks/`、`stomp-catalog/`、`stomp-native-fresh/`。复现入口见 [STOMP 脚本说明](../tooling/stomp-test/README.md) 与 `tooling/opcua-test/soak-local.mjs`。

## 测试结果

两轮高压桌面均失败；默认节奏对照的原生收发、完整顺序及 3 分钟静置检查通过，但第二方向前台面板状态不一致，不能作为完整双端前台渲染验收。OPC UA 原生长跑已完成。先行短测 `pilot3/summary.json` 通过，不能代替正式时长。

| 已完成检查 | 结果 |
| --- | --- |
| 目录 / OPC UA / STOMP 控制器定向回归 | 37/37 |
| STOMP 恶意报文 | 40/40；认证、版本/host、未知命令、非法转义/长度/UTF-8、超限、部分握手超时等；每项后正常连接仍可投递，退出时监听端口不可连接 |
| STOMP 原生目录 | 每运行时 broker + 3 个客户端，4 个会话同时存活，第 5 个受控拒绝；删除隔离、存活会话 ID 不变、名额复用通过 |
| STOMP 无 GUI 双向互通 | 300,045 ms；11,376 条发送、22,752 次独立 SDK 投递，全序通过；topic、queue 轮转、Unicode/NULL、两端服务端重启和订阅恢复通过 |
| OPC UA 无 GUI 原生长跑 | 1,200,377 ms；每端 2,972 次写入读回，Electron 11,764 / Rust 11,798 次订阅通知；三次恢复 3,226 / 3,219 / 3,299 ms，两端共 720 次预期拒绝；退订静默、过期会话拒绝、原生退出码 0、待请求 0 |
| 测试入口静态检查 | `node --check`、范围 eslint、两仓库 `git diff --check` 通过 |

上述 STOMP 原生脚本的 Electron 设置为真实 SQLite，Rust 设置为内存 fixture；桌面长跑另查两端真实 SQLite，不将 fixture 结果描述成 Rust 数据库验收。

## 测试入口修正与失败记录

首次桌面预跑在退出阶段读取已关闭的 Playwright dispatcher，导致 `app.process()` 抛错。脚本现在在 `app.close()` 前保存子进程句柄；后续短跑完成主路径与清理，修正属于测试入口，不是产品逻辑。完整流观察按连接 ID 独立记录，普通采样只返回计数，避免重复序列化全部消息；完整校验后才清空观察器。

首次 OPC UA 原生尝试使用了早于当前源码的 Rust CLI，发现调用超时。重新从锁文件离线构建 `opcua-harness` / `stomp-harness` 后重跑。失败日志保留，不计作当前构建的产品通过或缺陷证据。

首轮正式桌面第一方向 602,170 ms，61,696 条负载在服务端、两个原生客户端和独立 SDK 的顺序一致，三条原生流 SHA-256 一致；角色交换后 Electron 原生发送报 `STOMP transport is not open`，整轮失败。此前最后采样两端状态正常；原脚本没有记录断开历史，不能凭短跑或另一轮通过直接判断为产品/测试入口原因。已增加最近 100 条原生状态与失败时的桌面指标采集，再按相同参数重跑。诊断短跑 `pilot-diagnostics/` 通过，不能用它替代正式时长或宣称修复该偶发问题。

## 确认的问题与高压边界

**S1 / P2：Tauri broker 高压发送故障使多个客户端断开。** 第二轮 `desktop-final2/` 第一方向 602,019 ms、69,056 条完整通过；第二方向约 145 秒后，Tauri 仍为 listening，但显示 `STOMP peer 发送失败或队列已满`，两个 Electron 客户端均正常关闭（1000）并进入 reconnecting。故障时 Tauri 已观察 18,880 条该方向负载，而 Electron 两客户端合计仅观察 37,006 条；部分已进入 broker 的数据尚未交付，不能声称高压无丢失。脚本随后向已关闭的原生会话发送，得到 `STOMP transport is not open`。真实窗口没有崩溃/重载；精确区分控制器准入触顶和原生发送错误仍需更深诊断。`failure-desktops.json` 与 summary 内最近 100 条状态保留了现场。

**S2 / P2：慢 peer 可耗尽公共发送额度并牵连健康 peer，发布成功提示早于实际发送。** 源码 `packages/workbench/src/model/stompWorkbench.js` 的 `attempt.writeCount` / `writeBytes` 对所有发送 lane 共用；lane 的 Promise 串行只隔离顺序，没有隔离额度。工作区 `controller-starvation-repro.mjs` 使用真实共享控制器、刻意阻塞的原生发送 fixture：慢 peer 积压 1,000 条后，给另一个健康 topic 发布一条，操作返回 true，实际未调用健康 peer 的原生发送且健康 peer 被断开。结果见 `controller-starvation.json`。这是确定的共享控制器边界，未把 fixture 说成真实网络证据；尚未修改产品逻辑或宣称它是高压现场唯一原因。

已完成的常规负载对照 `desktop-baseline2/` 保持同样的角色、三个消费者、1 秒心跳和 20+3 分钟时长，只改为脚本默认每批 16 条、批间 200 ms。该对照的收发检查通过也不能覆盖上述两次高压失败或将问题标成已修复。`desktop-baseline/` 曾在准备阶段因尝试替换只读 Tauri invoke 接口而失败；该测试采集方式已撤销，没有进入产品代码，失败证据保留。

## 默认节奏对照与资源结果

`desktop-baseline2/summary.json` 脚本退出 0：Electron broker 方向 602,228 ms / 30,000 条，Tauri broker 方向 602,244 ms / 46,624 条，合计 1,204,472 ms、76,624 条发送。每方向服务端、两个真实原生客户端三条完整流数量和 SHA-256 一致，独立 SDK 全序一致；未发现遗漏或重复。删除额外端点后 ACK/NACK 与重投、每应用两条同时推进的 OPC UA 订阅、删除隔离及存活读回通过。两端真实 SQLite 各保留两份 STOMP 配置、无 STOMP 帧落盘、设置无测试凭据、quick_check 为 ok，退出清理无错误。

**前台验收限制：** 第二方向约第 60 秒起，Tauri 实际可见面板显示 disconnected/0 行，原生状态仍 listening 且收发继续，随后显式重新选择服务端后完整核对通过。当前证据不能区分人工切换与界面选择变化原因；旧脚本仅记录内部选中名称，没有同时记录实际前台名称。因此 summary 的 passed 只表示其已有断言通过，不足以证明两端前台始终渲染预期负载。本轮不把它列为完整可见压力通过；脚本已补实际前台名称与预期一致断言，供后续重跑使用。该差异同样会影响两方向速率和资源数字，不宜作产品性能对比。

46 次采样均保持窗口在屏幕上、未隐藏/最小化，页面无异常/告警、消息行数不超过 500；Electron renderer PID 72702、Tauri WebContent PID 72889 未更换，timeOrigin 变化在 WebKit 毫秒级误差范围内。断开后同进程静置实际 180,698 ms，没有强制 GC、重载或重启。资源见 `resource-analysis.json`：

| 指标 | 初始 MiB | 采样峰值 MiB | 静置最后 MiB |
| --- | ---: | ---: | ---: |
| Electron renderer RSS | 148.6 | 403.9 | 269.9 |
| Tauri WebContent RSS | 78.0 | 649.6 | 649.4 |
| Tauri WebContent footprint | 193.9 | 482.6 | 160.9 |

物理占用 footprint 已有回收，RSS 仍高于初始。测试观察器在负载期间保留完整消息，最后已清空；本轮不能据此宣称不存在内存泄漏，也不能把 RSS 与 footprint 混用。

## 截图追加：STOMP 确认模式选择框

用户截图显示真实 Tauri 深色界面下选择框矮于同一行输入框。共享 `stomp.css` 的原生 select 外观保留了 macOS 控件尺寸，只有 `min-height` 不足以保证一致；本轮改为自定义外观、明确使用 `--control-height`，用主题文字变量绘制居中的箭头，保留键盘与原生选项交互，强制颜色模式恢复系统外观。

浏览器回归在两个 runtime 预览、三种窗口尺寸、两种主题/字号及侧栏状态下比较选择框与输入框实际几何尺寸；真实桌面脚本新增可选的双端四组尺寸采集。验证完成：

- 修正前真实 Tauri `form-before/tauri-form-geometry.json`：普通模式输入框 32px、选择框 20px，断言失败，与截图一致。
- 修正后 `npm run build` 两端通过；`npm run test:e2e -w @ineed-linklab/workbench -- stomp.spec.js` 6/6（17.3 秒），覆盖三种窗口、两个 runtime 预览、浅/深色、普通/大字与展开/折叠菜单。此处运行时为显式 fixture。
- `form-after2/` 真实 Electron/Tauri 短跑退出 0，两端各四组主题/字号的输入框和选择框均高 32px，顶部差值 0；新加入的实际前台端点一致检查通过。附带两个短方向 576 / 768 条完整原生流、SDK 顺序、多端点 OPC UA、SQLite 与清理通过，不能用短跑替代20分钟压力。
- 最终真实 Electron 截图 `form-after2/electron-final.png` 已检查，选择框与输入框对齐、文字和箭头未重叠。Tauri 本轮以真实 WKWebView 几何尺寸验证；系统屏幕捕获不可用，没有宣称获得 Tauri 完整截图。
- 范围 eslint、`node --check tooling/stomp-test/desktop-duel.mjs` 和两仓库 `git diff --check` 通过。

初次浏览器新增断言因精确标签匹配包含选项文字而定位超时，已改用已有控件 name，失败记录保存 `form-e2e-locator-failure/`。初次修正后桌面启动漏配资源 helper，导致窗口检查无法识别 Tauri PID；`form-after/` 保留失败，补齐两 helper 后 `form-after2/` 通过，脚本新增启动前依赖检查。两项均为验证入口问题，不计作产品故障。

该 CSS 调整晚于长跑已加载界面，不将长跑说成修正后重新完整验收。

## 证据边界

负载期间测试观察器保留正文与计数，因此资源数字包含测试开销；静置清空观察器后仍需区分 RSS 与物理占用 footprint。没有取得分配调用栈，有限长跑不能排除长期泄漏。原生资源 helper 记录与宿主 responsible PID 关联的 WebKit 进程；Electron `workingSetSize` 从 KiB 换算，原生 helper 的 RSS/footprint 从字节换算。

本轮没有验收 Windows/Linux/x64 原生安装、生产 broker、真实厂商 OPC UA 设备、wss/企业 CA 或现场网络。STOMP 长跑主要为 auto ACK 的 topic 广播；手动 ACK/NACK、queue 轮转与重连是独立有限操作检查，不代表同等时长的队列压力。

## 后续修复跟进

原始结果保留。后续代码修复、全功能审查与验证见[压力缺陷修复记录](stomp-soak-fixes-verification-2026-10-22.md)及[完整功能与交互检查](full-feature-review-2026-10-22.md)。跟进已完成17类问题处理，原参数desktop-high-final4双向负载1204641ms/508128条及180.700秒同进程静置通过，完整顺序/前台/数据库/清理均通过；保留内存驻留与平台边界。这里的原始缺陷和失败轮次仍是历史结果，以跟进报告为当前结论。
