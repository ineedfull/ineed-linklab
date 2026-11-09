# LinkLab 完整审查修复与验收（2026-10-14）

本轮处理完整审查 L1–L12。Electron/Tauri 继续共用工作台、配置和协议逻辑；原生差异保留在对应服务。未改变 SQLite schema、应用身份或用户数据路径，保留已有品牌与压力修复。源码仍未提交，未生成安装包或发布。

三组实施及最终集成独立复核通过。复核发现的坏帧恢复、模板旧快照/同 ID 重命名删除、DL/T 标记兼容与跨块上下文搜索均已补齐；最终无剩余审查项。本说明仅记录本轮修复与本机验证边界。

## 修复结果与维护入口

| 项目 | 当前行为 | 主要回归入口 |
| --- | --- | --- |
| L1 FC15 错误成功 | 先验证全部线圈地址，再执行原子批量写入，完成后应答；越界返回 exception02 且不修改 map。局部 handler 保护仅用于登记的 LinkLab vector，TCP/RTU 共用，不编辑依赖文件。 | Electron modbusService tests：真实 TCP/RTU |
| L2 历史失败无反馈 | 重试耗尽/队列溢出留下有界失败摘要；后台处理 rejection，显式屏障报 HISTORY_INCOMPLETE；工作台持续显示保存失败。 | batchedPersistence、transportPersistence、Electron boundary、PersistenceWarning tests；桌面 SQLite 锁定 |
| L3 导入提前断连 | 双端校验全部 11 类 transport；非法导入在关闭连接前拒绝，配置与活动 listener 保留。 | managementNative tests、Rust import barrier、桌面无效文件导入 |
| L4 TCP 丢尾 | 正常 client/peer EOF 或用户关闭时刷出 delimiter/fixed/idle 尾部，再清理；超限错误仍丢弃不可信尾部。 | Electron tcpService tests |
| L5 有符号 BCD 溢出 | 舍入后检查幅值是否占用符号位，3 字节/4 小数允许 ±79.9999，拒绝 ±80、±89.1234 及舍入溢出。 | codecs dlt645 tests |
| L6 模拟器保存竞态 | 保存捕获 revision/代次，旧成功不清除新编辑，旧失败/收尾不影响新会话或卸载视图。 | Dlt645SimulatorPanel tests |
| L7 数字草稿被静默修正 | 显式草稿先验证，再归一化；拒绝空值、非法类型、非有限值及要求整数的非整数值。旧配置缺省字段继续补默认值。 | Modbus dialogs/config、DL/T simulator config/component tests |
| L8 Modbus 分类遗漏 | 分类覆盖 TCP/RTU 主站与从站四类端点。 | messageFilters tests |
| L9 实时内容/地址搜不到 | 搜索实际原生 bytes 的 UTF-8 正文、HEX 和当前端点显示的 peer 地址；分块扫描全 payload。 | messageFilters tests、桌面实时搜索 |
| L10 坏帧阻挡后继 | 完整候选校验失败后重扫，跨分片携带可选恢复状态；坏帧内伪长头不能遮住后继合法帧，普通真实半帧保持。 | dlt645 codec、主站 component、simulator lifecycle tests |
| L11 模板删后残留 | 每个成功删除按端点/ID 更新当前列表及尚未返回的列表快照，旧加载不能复活已删模板；同一 ID 的重命名/删除串行且在任务内发布 UI，不同 ID 仍并发，保留视图代次与失败重试。 | SendLibraryPanel tests |
| L12 发送分帧无效 | 共享 send 命令只组帧一次，原生接收 wire bytes；模板/发送历史保留逻辑内容与分帧。已有 DL/T 报文标记原样透传。 | sendWire、workbenchModel、SendPanel、双端 boundary、Rust strict parser→TCP fixture |

具体代码职责与阅读路径见 [代码阅读地图](code-reading.md)。规格和执行计划存放于 `docs/superpowers/`。

## 发送分帧规则

Text/HEX/JSON 先转换成逻辑 payload，勾选追加 CRLF 时先追加 CRLF，再应用分帧。单次、定时、历史载入后重发共用以下规则。

| 分帧 | wire bytes（逻辑内容为 `ping`） | 定义 |
| --- | --- | --- |
| 无 | `70 69 6E 67` | 原样发送 |
| 按行 | `70 69 6E 67 0A` | 末尾没有 CR 或 LF 时追加 LF；已有 CR/LF/CRLF 保留 |
| 长度前缀 | `00 00 00 04 70 69 6E 67` | 四字节无符号大端 payload **字节长度**，长度不包含头 |
| UDP datagram | `70 69 6E 67` | 保持原 datagram 字节 |

`dlt645` 是已有主站/模拟器的内部标记，表示报文已经组帧；共享发送保持其字节、标记和目标会话。其他未知标记拒绝。原生请求只有 `endpointId/bytes/target/framing`，逻辑 `format` 留在模板/发送历史，避免 Tauri 严格解析拒绝多余字段。模板和发送历史不保存重复前缀。

## 历史保存失败语义

失败摘要只保存计数及首个/最近错误的最多 256 字符消息，不积累失败 payload。显式 flush/query/close/dispose 等屏障报告 `HISTORY_INCOMPLETE` 时消费已确认摘要，后续批次仍可保存；transport 屏障等待全部队列收尾再抛错。报错不代表丢失批次已恢复。

Electron 原生告警绕过失败的日志队列，工作台在本进程内持续显示，即使后续写入成功。此新增告警通道为可选 adapter 能力，未将 Electron 的队列实现复制到 Tauri。

## 搜索与协议恢复边界

正文/HEX 搜索扫描完整 payload，以 4096 字节分块、有界 NFC 残留和与关键词相关的匹配状态处理正常 UTF-8、组合字符及 HEX 跨块匹配，不缓存全帧格式化字符串。正规化保留原始大小写，再逐字符匹配；Σ 的词尾/非词尾候选等真实上下文或 EOF 明确后再选择，任意长可忽略标点串也不积累文本。对于连续组合字符极端长序列，正规化窗口有界为 `max(4096, 2 × 关键词 NFD UTF-16 长度, 4)`；越过该窗口的全串规范等价匹配不作保证。已有字符串字段仍使用完整 NFC 正规化。

DL/T `resynchronizing` 状态只在完整候选损坏后启用，由模拟器控制器与主站组件随 remainder 保存，在断连、换会话或释放时清零。残留最大 282 字节，FE 唤醒前缀最多保留 16 字节，避免噪声无限累积。

## 当前源码验证

本机 macOS arm64、已安装的 Node/Rust/Chromium/socat，使用隔离 SQLite、localhost 与 PTY。断网期间通过本地工具执行，未安装或升级依赖。

| 门禁 | 本轮结果 |
| --- | --- |
| `npm test` | 集成补修复后 Node 1103/1103；Vue 组件 283/283 |
| `npm run lint` | 通过，零 warning |
| `npm run build` | Electron/Tauri renderer 均通过；原有 ECharts 大 chunk 提示保留 |
| Rust fmt 与 `cargo test --offline` | 173 通过，5 原生入口默认 ignored，全部另行执行通过；含实际共享请求→严格解析→TCP wire 测试 |
| 构建产物 boundary | 58/58 |
| 双端浏览器、三个尺寸 | 首轮 120 项通过；6 项旧原文复制断言漏掉已生效的默认 LF，更新 wire bytes/原文预期后补跑 6/6 通过；集成补修复后模板/复制范围再验 12/12 |
| 原生 TCP/UDP/PTY | 双端及跨端回环、收发历史/会话/清理通过，managedChildren=0 |
| Modbus TCP/RTU | 双运行时双向互通通过；FC15 越界原子性亦纳入默认 Node 测试 |
| 空闲串口写入 | 20 次写入，最大延迟 0ms（毫秒计时精度） |
| 实际 Electron 桌面 | 15 项流程通过，pageerror=0；DL/T 主站及发送/告警各 8 种主题/字号/侧栏组合，1120×720 |

Electron 桌面包含模板 CRUD、有限定时发送、发送历史、历史窗口查询、DL/T PTY 抄读/重连、导入导出/清理，以及三种 wire bytes 与逻辑历史比对、原生正文搜索、真实 SQLite 锁→可见告警→显式失败→解锁后继续保存。文件选择框提供隔离路径，未读写用户现场配置。

macOS/Linux 默认 `npm test` 的真实 RTU 用例需要 `socat`；Windows 跳过 PTY 分支，仍需 COM 设备验收。离线 Rust 验证需要先安装工具链和锁定依赖。

本轮未新增长期压力验收、Tauri 完整桌面 GUI、实体串口/电表、Windows/Linux 安装、macOS x64 实机、签名安装包或公网更新验收。上述边界及先前压力记录继续保留。
