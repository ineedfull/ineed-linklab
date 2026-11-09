# 压力缺陷修复与复验（2026-10-22）

状态：17类问题处理、可执行回归及原参数双端可见高压完成；S1/S2本轮复验通过，内存驻留风险保留。所有已有协议工作的未提交源码保留；本轮未提交、打包或发布。

完整协议角色及交互一致性见[全功能检查](full-feature-review-2026-10-22.md)。原始失败见[多协议对攻与压力验证](protocol-soak-verification-2026-10-22.md)，历史结果保持。

## 已确认原因与实现

1. 慢连接共享公共额度，可能令健康 peer 被拒绝；本地发布未等待原生完成而提示成功。改为每 peer 独立有界发送 lane，队列项保留原始 count/bytes 直到实际完成；失败、断开、移除可取消队列，健康 peer 独立前进。发布等待所有目标结算，区分已发送、失败、入队与无订阅者。
2. `desktop-high1` 原 32条/50ms 复测仍失败，说明仅隔离额度不足。`desktop-diagnostic1` 抓到两个 Electron 客户端首次 ERROR 均为 `Broker peer send queue limit exceeded`。后续迟到报文经 broker 自动 addPeer 复活，产生 `CONNECT required` 并覆盖首因。
3. 同一 peer 原先每帧等待一次完整 native IPC 往返才发下一帧。现将该 peer **已在队列中的**相邻帧即时合并为最多64KiB/128项一次发送，不额外等待凑批；单个超64KiB合法帧独立发送。1000条/peer、1MiB/peer encoded payload、8MiB/client 等原有额度未放大。此实现已通过队列、取消、顺序和解析回归；真实GUI原高压最终结果见下文；单独该项并不足以解决全部瓶颈。
4. 失败 peer 以 retired 状态保留到真实原生移除，忽略迟到报文/旧快照/心跳；仍受64个 peer 总额限制，不使用无限增长的 tombstone 集合。手动 ACK 队列恢复保持原序，原生移除不会重复恢复。
5. 断开取消的客户端发送保留“会话已结束”，异步失败不会更新新会话；broker 以对象身份防止旧失败关闭同 ID 替换 peer。

6. 解锁后 `desktop-high-final` 仍在不足30秒超限。`desktop-ipc-diagnostic2` 显示三条peer完成通知同时延迟、峰值1179ms，已有128帧合批仍会积压。只在served副本把Tauri行数降到10的诊断对照两方向各60秒通过，13,312/18,560条全序；不计正式验收。
7. 消息列表与协议处理共用WebView线程。先按requestAnimationFrame合并快照，`desktop-high-final2` 延长到约78秒后仍超限；回归进一步证实满500条滚动时新增1条会重建所有500条正文。提取稳定key的StompMessage行组件后，未变行复用，协议处理保持即时、有界历史仍500条。组件回归600条全量投递、最近500条展示、清空/卸载取消及行状态/ACK通过；滚动旧正文读取从500次降到只读取新行。最终组件335、相关浏览器6、lint/build与产物61通过。

8. 行复用后的 `desktop-high-final3` 到64,576条仍超限；发送和展示的优化不能单独证明吞吐问题解决。对照既有传输的帧批处理，补上Tauri GUI原生STOMP入口的有界事件合并：16ms截止、8ms定时检查，最多200帧/64KiB原始字节，大帧独发；会话/端点身份不混合，状态及peer变化先冲刷数据。Weak定时任务随service sink释放结束，不改传输容量/超时。Rust合并用例先红后绿；串行215通过/5原有忽略，专项10通过，含真实ACK先于断连，fmt通过。

诊断的内存JS改写开关和计时包装已从正式脚本移除，脚本副本归档证据根目录 `desktop-ipc-diagnostic-harness.mjs`，只作历史诊断材料。正式 `desktop-high-final4` 使用磁盘上的完整500条生产界面、原32/50ms/600000×2+180000参数，最终通过，结果见下文。

共享文件：`stompSendQueue.js`、`stompBroker.js`、`stompWorkbench.js`、`StompPanel.vue`、`StompMessage.vue`；Tauri原生GUI批处理在`stomp/event_batch.rs`及`lib.rs`接入。两端继续使用同一套工作台。原生 WebSocket 服务未为这次 STOMP 吞吐修复改动容量/超时。

## 验证入口及证据

证据根目录：工具工作区 `scratch/2026-10-22-linklab-soak-fixes/`。完整回归日志另归档到其中 `gates/`。

| 验证 | 本轮结果 |
| --- | --- |
| 阻塞 native 的慢/健康 peer、真实完成提示、移除取消、溢出退出 | 先红后绿 |
| 断开期间发送状态、旧失败与替换 peer | 先红后绿，独立复核2/2 |
| 合批、有序、字节边界、失败后迟到帧不复活 | 先红后绿；相关最终37/37 |
| 独立复核 | 相关22/22；整批取消、超64KiB、NULL/Unicode、实际 observer 拼帧/分片、1000条手动ACK重投探针通过 |
| Node / Vue | 1253/1253 / 最终335/335 |
| lint / 双端 renderer / 产物边界 | 通过 / 通过 / 61/61 |
| Rust | 首轮209通过、1项测试监听端口冲突；保留失败后串行210通过；追加原生事件合并后最终串行215通过、5原有忽略，真实ACK先于断连专项10/10；对应TCP/UDP/PTY及显式Modbus原生入口另通过 |
| 浏览器预览 | 完整162/162；OPC UA字号追加6/6；最终共享选择框影响范围12/12；稳定消息行追加6/6 |
| STOMP 原生恶意矩阵 | 40/40，34742ms，每项后独立SDK健康检查 |
| STOMP 原生有限互通 | 两方向topic/queue、Unicode/NULL、独立SDK、重启/订阅恢复通过；压力参数为0，仅有限快检 |
| WebSocket 原生攻击回归 | 握手/非法帧/慢握手/容量/恢复矩阵通过；总45153ms，附带1秒负载，不计长期压力 |
| OPC UA 原生 | 300000ms要求、总307339ms；两端各727读写轮次、各93预期拒绝，3次重启恢复、退出无悬挂请求 |
| 真实 Electron 综合 | 15组流程、16显示组合通过，含TCP、PTY电表、模板/历史、定时/组帧、JSON、SQLite锁恢复 |
| 真实 OPC UA 桌面操作 | Electron8组、Tauri9组通过，含确认写入/回读、原生订阅、无效替换保留旧订阅及导航；锁屏期间不作为可见压力验收 |

桌面脚本已将观察器改为使用产品真实 `StompDecoder`，按连接/peer 增量解码拼帧、分片与正文NULL，完整顺序核对不会因合批误计数。

## 控件与原生几何

新增共享 `protocolControls.css` 供 OPC UA/STOMP 使用。浏览器和原生行为分别检查，避免仅依据 Chromium 的32px认为 WKWebView 也正常。

- `opcua-form-before` 记录 WKWebView select20/21px、input32px，但首次探针比较 computed min-height18px，约束偏弱，没有正确拒绝。
- 加强为产品 control-height 后，`opcua-form-before2` 正确失败；修复后 `opcua-form-after` 两端四组设置均32px。
- 此专用检查的 summary 明确标为 **native control geometry only; no visible pressure acceptance**。
- STOMP 既有 select 高度/顶部对齐回归保持；最终浏览器12项通过，原生正式长跑还将重复核对。

## 最终可见长跑入口

`desktop-pilot2` 在进入负载前因 Tauri `visibilityState=hidden` 失败；系统实时报告 `CGSSessionScreenIsLocked=True`，锁定时间1792636756。失败原始证据保留，未修改正式可见性断言。解锁后继续的失败轮次与诊断见上文；当前正式轮次desktop-high-final4使用以下固定参数：

```sh
LINKLAB_STOMP_FIRST_SERVER=tauri \
LINKLAB_STOMP_VERIFY_FORM=1 \
LINKLAB_STOMP_DESKTOP_OUT=<工作区>/scratch/2026-10-22-linklab-soak-fixes/desktop-high-final4 \
LINKLAB_STOMP_DESKTOP_MS=600000 \
LINKLAB_STOMP_DESKTOP_IDLE_MS=180000 \
LINKLAB_STOMP_DESKTOP_BATCH=32 \
LINKLAB_STOMP_DESKTOP_PAUSE_MS=50 \
LINKLAB_DUEL_RESOURCE_HELPER=<工作区>/scratch/2026-10-21-linklab-duel/resource-sample \
LINKLAB_DUEL_WINDOW_HELPER=<工作区>/scratch/2026-10-21-linklab-duel/window-state \
node tooling/stomp-test/desktop-duel.mjs
```

保持桌面解锁、只运行一个 GUI 验证；两个方向各10分钟、同进程静置3分钟。本轮已完成完整原生连接顺序与SDK、前台端点、窗口/进程、ACK/NACK、多个OPC UA订阅、SQLite和清理，实际结果见下文。

没有新增 Windows/Linux/x64 安装、实体串口、厂商 OPC UA 或生产 broker/企业 CA 验收。有限回环与观察器开销不能证明长期无泄漏；本轮最终资源结论仅基于完成的可见长跑，不沿用失败轮次或旧默认低速对照。

## 最终改动独立复核

只读复核STOMP列表快照、稳定行组件、原生事件合并及接入，没有发现实质缺陷。确认消息对象仍具响应性、清空/卸载取消刷新，事件合并保留顺序和身份且Weak定时器不持有service。现有测试尚未单独覆盖“等待绘制时的客户端ACK/NACK与receipt更新”、operation ID切换和混合peer元数据组合；这些是非阻塞覆盖边界，不将它们描述成已执行的专项用例。复核期间未运行并行构建、测试或应用。

## 原参数可见高压最终结果

`desktop-high-final4/summary.json` 为passed=true，脚本退出0，清理无错误；采样关联的应用/renderer/WebContent进程全部退出。正式参数保持32条/50ms、每方向600000ms目标、静置180000ms，没有降低负载、放大队列、重载或强制GC。

| 服务端方向 | 实际负载时长ms | 完整负载条数 | 顺序与完整性 |
| --- | ---: | ---: | --- |
| Tauri | 602484 | 320576 | 服务端及两个原生客户端数量/全序/SHA-256一致，SDK全序一致 |
| Electron | 602157 | 187552 | 服务端及两个原生客户端数量/全序/SHA-256一致，SDK全序一致 |

合计1204641ms、508128条；未发现遗漏、重复、队列超限或故障重连。每方向界面发布由服务端和SDK共同观察，清空后ACK/NACK、queue重投、额外客户端删除隔离通过。两端OPC UA各两条同时推进的原生订阅，删除一条后另一条继续读回。两端SQLite各保留两份配置，无测试凭据、无STOMP帧历史，quick_check=ok。

46次采样窗口可见/在屏幕上/未最小化、实际前台名称与目标一致、无页面错误/告警，历史最多500条。同一renderer/WebContent PID和timeOrigin保持；同进程静置实际180.700秒，先保留视图约60秒，再清空所有访问过的STOMP历史和观察器约120秒。最终清空行数及观察器计数均0。

| 资源指标 | 初始MiB | 采样峰值MiB | 静置最后MiB |
| --- | ---: | ---: | ---: |
| Electron renderer RSS | 157.9 | 1074.0 | 829.6 |
| Tauri WebContent RSS | 73.3 | 1281.5 | 1281.3 |
| Tauri WebContent footprint | 114.4 | 611.7 | 473.4 |

**资源保留项：** 有回收，但两端驻留仍高于初始；Tauri RSS几乎未下降，物理占用footprint有所下降。负载期观察器保留完整消息，结果包含测试开销；本轮没有分配调用栈，不能区分全部剩余占用的缓存/分配器保留/真实泄漏。S1/S2的功能及原高压复验通过，不等于长期内存问题全部排除，也不将两方向速率直接当作产品性能比较。

原始证据：工作区`scratch/2026-10-22-linklab-soak-fixes/desktop-high-final4/`的summary.json、samples.jsonl、resource-analysis.json、cleanup-process-check.txt和Electron截图；原始日志归档到gates/。此前失败、锁屏、诊断及低速对照保持，不冒充本次正式通过。
