# LinkLab 高负载内存归因（2026-10-22）

状态：本轮应用修复、自然对照、堆诊断、源码归档及macOS安装包准备完成。上一轮原参数20+3功能压力通过；本任务检查资源归因与重复使用，不将功能通过等同于长期无泄漏。

## 对照与验收入口

复用`tooling/stomp-test/desktop-duel.mjs`的隔离原生Electron/Tauri宿主和真实UI操作；新增独立`memory-cycles.mjs`分支。默认正式压力分支仍使用完整正文观察器。内存诊断支持full、bounded、off：bounded每个连接仅保留计数、前缀、最后序号和首次错误，逐条检查遗漏/重复/序号；off仅做SDK全序和原生UI尾项到达检查，不声称原生完整流验收。

每方向1服务端、2原生客户端、1独立SDK，32条/50ms，固定消息数32768。每轮断开、清空所有访问过的消息面板与观察器、自然静置、删除全部测试端点。采样保留真实前台/窗口可见、timeOrigin、进程资源、DOM/显示行、观察器/解码器计数。三轮共6个方向复用同一宿主进程。

证据根目录为工作区`scratch/2026-10-22-linklab-memory/`。`pilot1`两方向各512条通过；`full-observer1`两方向各32768条、清空后30秒静置及删除通过。后者结束Electron RSS261.5MiB，Tauri RSS646.6MiB/footprint224.8MiB；不能仅凭RSS认定活跃对象泄漏。`bounded-cycles1`修复前三轮自然基线已通过并退出0，6方向各32768条（总196608），每方向清空后自然静置60秒，再删除端点。最终Electron RSS304.8MiB，Tauri RSS832.3MiB/footprint240.5MiB；第三轮仍有上升，尚不视为稳定。

`memory-observer.test.mjs`两项检查独立顺序、常量摘要、遗漏/重复/前缀变化及清空通过；源码从同一工厂函数注入两端。观察器与脚本的资源开销仍存在，不将该诊断等同日常产品基线。

## 已确认的不必要后台渲染

`LinkLabShell.vue`通过v-show保留所有访问过的协议面板；STOMP面板不感知前台选择，其500条历史快照及消息行在隐藏时仍刷新。基线真实采样显示：同一应用2个原生客户端时约12286个DOM节点，仅1个可见面板；单服务端约5179个。这与源码的两个500行消息树相符。

这是不必要的后台渲染与分配，尚不能将它等同于全部剩余RSS的原因。3项回归首先预期失败；现由Shell传递visible，隐藏时取消RAF/释放显示快照，保留controller及500条模型历史；重新选择恢复最新快照。真实broker累计1201条全部投递（含隐藏时600条）、恢复最新500条、草稿/回执/ACK和选择传递的组件回归通过。没有在切换时断开、dispose或裁剪模型历史。

## 时间显示统一

用户追加要求已纳入本轮。公共 `dateTime.js` 格式函数支持整数毫秒和显式时区ISO，统一转为本地 `YYYY-MM-DD HH:mm:ss.SSS`，缺失/无效值为 `--`，epoch0有效。紧凑帧列表和趋势横轴用 `HH:mm:ss.SSS`，悬停/详情/十字线/缩放范围保留完整日期；STOMP消息/待ACK、OPC UA源/服务器时间和证书有效期、Modbus及DL/T645的事务/采集状态共用完整格式。数据库、报文和导出数据契约未修改。

ISO原样显示、DL/T645缺少日期/毫秒、趋势默认时间和非法日历日期的回归已先红后绿。Node1253、组件337、Rust串行215/5原有忽略、产物61、lint/build/fmt通过；浏览器首轮161通过/1受HMR影响，固定源码后相关双端三尺寸6/6通过，详见下文。独立只读审查当前新增内存和时间改动，无实质问题。

## 修复后自然对照

`bounded-after1` 已通过并退出0：同样3轮、6方向各32768条、32条/50ms、每方向清空后静置60000ms，再删除端点；51次采样、实际884398ms。SDK与3条原生流完整顺序检查均通过，页面无错误/告警，窗口在屏幕上且未最小化。两端宿主/renderer始终复用；Tauri WebContent PID66418、Electron renderer PID66255保持不变，结束后所有采样进程均退出。

| 指标 | 修复前有界3轮 | 修复后有界3轮 |
| --- | ---: | ---: |
| 双客户端应用负载时DOM节点 | 12286/12287 | 6287/6288 |
| Tauri RSS峰值 / 最后MiB | 845.7 / 832.3 | 752.3 / 668.4 |
| Tauri footprint峰值 / 最后MiB | 592.8 / 240.5 | 524.7 / 254.0 |
| Electron renderer RSS峰值 / 最后MiB | 485.0 / 304.8 | 477.2 / 318.2 |
| 删除后页面节点Tauri / Electron | 78 / 77 | 78 / 77 |

两组最终消息行、观察器正文/连接及解码器均0。后台消息树减少已直接确认；RSS与footprint、两端最终指标并非全部同向下降，因此不把这次单组对照当作全面性能改善或长期无泄漏证明。Tauri报告的timeOrigin有4–5ms范围抖动，WebContent PID与Electron timeOrigin稳定；没有操作重载/重启，不将抖动误报为精确相等。

全量浏览器首轮161通过、1项受测试期间公共时间函数编辑触发Vite HMR影响而超时。trace保留App及各面板hot updated、旧DOM被移除的证据；固定源码后相同双端流程三种尺寸6/6通过。首轮失败不删除、不改写为全量162/162。后续自然对照只加载固定dist资源，没有HMR。

## 关闭观察器与心跳诊断

`off-after1`在第二方向出现一次服务端“heartbeat or handshake timeout”，原证据不能唯一确定是哪个原生/SDK连接，保留为未确认归因。发现脚本采样使用execFileSync，与SDK共享Node事件循环；受控250ms子进程测试下10ms心跳计时器运行0次，证明同步采样能阻塞SDK心跳。更换为异步execFile后受控测试与异常传播测试通过；应用心跳阈值、消息量和发送节奏没有更改。追加最多100条原生状态、20次peer快照、页面计时器间隔及SDK连接端口诊断，不保留消息正文。

异步化之前的反向诊断`off-diagnostic1`通过，两方向各32768条；页面最大计时器间隔约250–260ms，没有长阻塞证据。异步化后按原失败角色顺序的`off-async1`通过并退出0，两方向各32768条、实际228335ms；最终Tauri RSS529.3MiB/footprint170.1MiB，Electron262.8MiB，消息行/观察器/解码器0，所有采样进程退出。off模式仅SDK完整顺序及原生界面尾项检查，不能替代原生完整流验收。一次复跑通过并不证明原失败一定由同步采样触发，也不能据此宣称产品不存在心跳风险。

## 堆与原生采集边界

`tooling/soak-test/macos/heap-probe.m`为显式诊断库，仅在隔离的Ineed LinkLab开发宿主路径及LINKLAB_MEMORY_PROBE_DIR环境下启用；专用memory-runner在最后一次exec设置DYLD_INSERT_LIBRARIES，普通开发与发布不走此入口。不链接进产品或安装包。编译产物位于scratch。文件请求在主线程访问WebKit Inspector；`memory-heap.mjs`在普通采样之后采集原生vmmap/heap、Electron堆及Tauri JS堆。

Inspector堆快照会触发GC并改变资源，必须另跑诊断并标记，不能作为自然回收验收。当前自然基线没有加载该库、打开Inspector、强制GC或重载。实际堆采集已完成，结果如下。

## 独立堆诊断结果

`heap1`/`heap2`在负载前等待探针超时，保留失败。受控对比确认经过/usr/bin/env后DYLD_INSERT_LIBRARIES消失；第二次改为直接启动CLI仍在后续链路丢失，vmmap未见诊断库、目标环境没有DYLD变量但保留普通probe变量。最终专用memory-runner通过普通变量传递库路径，仅在隔离宿主最后一次exec注入；`heap3`实际取得两端4组快照及原始WebContent PID35038的vmmap/heap。

`heap3`两个方向各32768条，SDK及每方向3条原生流全序通过，退出0；25次采样、实际248922ms。所有采样进程退出，最终页面消息行/观察器/解码器0；两端原宿主未重载。此运行打开Inspector并采集会触发GC的快照，资源数据仅供诊断，不能与自然回收等同。

| 阶段 | Tauri JS估算MiB / 消息形状对象 / controller | Electron JS估算MiB / 消息形状对象 / controller |
| --- | --- | --- |
| 初始 | 1.26 / 0 / 0 | 4.74 / 0 / 0 |
| Tauri服务端负载后 | 8.28 / 500 / 1 | 22.40 / 1001 / 2 |
| Electron服务端负载后 | 9.97 / 1000 / 2 | 20.78 / 501 / 1 |
| 全部删除后 | 1.35 / 0 / 0 | 7.74 / 1 / 0 |

对象统计按属性形状识别，不能自动把每个候选都当真实消息。Electron最后1个候选正文/destination/messageId/ackId均空，id和createdAt为V8 Hole；唯一入边为AllocationSite.transition_info，经FeedbackVector回到代码模块。这是V8对象字面量分配模板，没有负载正文；保留路径见证据electron-final-message-retention.json。没有因该模板修改产品或刻意清理JIT。

原生heap在快照GC之前采集：WebContent malloc字节初始17026368，两个负载阶段135646832/216719376，删除静置后94132884。最后non-object占90947684字节；vmmap WebKit Malloc显示allocated87.2MiB、dirty153.3MiB、dirty+swap碎片66.2MiB。可定位到WebKit分配区及部分WebCore布局/渲染对象，未启用MallocStackLogging，无法继续把non-object字节逐项归属到分配调用栈。JS快照/原生malloc不涵盖全部映射、图形及进程共享页，不把它们与RSS直接相加，也不声称所有剩余内存均为系统缓存。

目前确认并修复的是隐藏面板持续渲染；本轮清空/删除后的消息及controller释放有快照证据，原生长期驻留和更长时段增长仍保留。未增加强制GC、页面重载、定期重启或推测性的内存裁剪。

最终新增诊断工具lint及4项工具测试通过，git diff --check通过；独立只读复核无可操作问题。应用源代码在前述完整门禁后没有再改动；新增变更仅为诊断入口与文档。

## 提交与安装包

应用源码及全部已有功能归档为`f7e4df36804ed2526fff57d7a0bbb4a78a52ae46`（218文件）；提交后工作树干净。`npm run release:build -- --platform=macos --arch=all`退出0，维护脚本生成四个DMG；manifest记录sourceCommit为该提交、sourceDirty=false。`release:verify`退出0，四个文件摘要、大小及格式通过。构建集合：`release/desktop/0.1.0-20261022T074613195Z-87d0ad5d/`。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| ineed-linklab-0.1.0-electron-macos-arm64.dmg | 128325555 | `2b51ceb3381379b76a8df9e47e096ea145cf5a663c498a542debb9cb8d05e1b7` |
| ineed-linklab-0.1.0-tauri-macos-arm64.dmg | 11426349 | `365e1c58ae562034d73bda642ac70ab400dfcf7e86a8c982770e0b32cb4e8328` |
| ineed-linklab-0.1.0-electron-macos-x64.dmg | 130111198 | `269e2abb3fc5d0ee11e3c24a93b66a4677e1a4f48e81733693bee9a448684a16` |
| ineed-linklab-0.1.0-tauri-macos-x64.dmg | 11900810 | `c7d11aaf4f405cece74151aaba8a095c3e2b16c850aea1a846adf4853a13a06d` |

四个DMG均hdiutil verify、只读挂载、Bundle ID/版本/品牌名和单一Mach-O架构检查通过；两个Electron包内当前renderer全部字节与源码构建结果一致，关键OPC UA/STOMP/WebSocket/main/preload文件一致，ASAR未包含tooling。Tauri依赖列表未含诊断库。Electron arm64包内运行时Node smoke实际加载SQLite内存数据库、串口binding、node-opcua和ws通过；x64本机执行返回errno -86，未完成该架构运行时smoke。第一次完整运行检查失败记录保留，随后明确标注x64未运行，四包静态检查通过。

包检查证据：工作区scratch/2026-10-22-linklab-memory/package-inspection.json；完整构建日志在集合build-logs和工作区gates内。仍为0.1.0测试包，未正式代码签名/公证；本轮没有安装替换、生产包GUI、Intel实机、Windows/Linux或自动更新验收，没有push、上传或发布。原生长期驻留、实体设备、生产服务器/企业CA和更长期运行仍按上述边界保留。本报告与计划的归档更新作为独立文档提交，不改变安装包已记录的应用源码来源。
