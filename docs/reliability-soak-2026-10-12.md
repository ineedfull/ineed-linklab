# LinkLab 双端持续压力与异常输入验收

日期 2026-10-12，基线 `06041df`，macOS arm64、Node 26.10.0、Electron 43.1.0、Tauri/WKWebView。没有修改产品源码；新增可重复的隔离验证入口。精简统计见同名 JSON。

## 入口与覆盖层级

先运行 `npm run build`，安装本项目锁文件依赖以及本机 `socat`，然后分别执行：

```sh
LINKLAB_SOAK_MS=1200000 node tooling/soak-test/desktop-soak.mjs electron
LINKLAB_SOAK_MS=1200000 node tooling/soak-test/desktop-soak.mjs tauri
node tooling/soak-test/native-contract-soak.mjs
node tooling/soak-test/adversarial-tcp.mjs
node tooling/soak-test/verify-history.mjs /tmp/linklab-soak-20261012/electron
node tooling/soak-test/verify-history.mjs /tmp/linklab-soak-20261012/tauri
```

默认结果路径按产品/运行时保存，可用 `LINKLAB_SOAK_OUT` 指定新目录。桌面脚本每次创建新 profile；Tauri 使用唯一应用 ID，隔离数据路径写在 `isolation.json`，不会修改用户应用数据。HTTP、TCP、UDP 和 Modbus 只监听回环；串口使用临时 PTY，没有访问实体串口或现场网络。临时 profile 保留供复查。

Electron 加载生产主进程、preload 和 dist；Tauri 运行生产桌面进程和原生命令，以临时 `devUrl` 加载已构建 dist，并注入仅测试脚本。长跑的流量、开关连接和配置保存通过真实 renderer/native IPC 提交，每次保留同一个桌面进程。测试脚本读取历史计数、检查 Modbus 写后读值，并反复关闭和恢复连接。它覆盖原生窗口中的通信与落盘，不代表所有操作都通过按钮触发。

另用 `LINKLAB_SOAK_UI=1 LINKLAB_SOAK_MS=60000` 运行约一分钟补充真实 DOM 开关端点、选中工作台和消息渲染检查；两端显示行数均达到上限 500。`native-contract-soak.mjs` 是重复启动独立 Electron/Rust 服务门禁，作为补充，不算常驻 GUI 时长。

## 实际结果

| 项目 | Electron | Tauri |
| --- | ---: | ---: |
| 同一桌面进程持续时长 | 1,200,135ms | 1,205,539ms |
| 通信轮数 | 284 | 236 |
| TCP 收发帧各 | 28,400 | 23,600 |
| UDP 收发帧各 | 5,680 | 4,720 |
| PTY 收发帧各 | 5,680 | 4,720 |
| SQLite 总帧数 | 79,520 | 66,080 |
| 打开连接次数 | 61 | 49 |
| 非法 bytes 拒绝次数 | 14 | 11 |
| Modbus 读写事务 | 568 | 472 |

两端成功完成，renderer 异常为 0。退出后重新打开 SQLite，`integrity_check=ok`，每端点收发条数、16 字节帧长度、payload 多重集合完全一致，错误日志为空。由于测试 payload 每 95 个序号重复，此检查验证内容及频次，不单独证明全部帧的严格顺序；本轮未增加完整桌面重启恢复验收。

补充真实 DOM 验证：Electron 62,487ms、20 轮、5,600 帧；Tauri 60,878ms、14 轮、3,920 帧。原生服务门禁持续至少 20 分钟，105 轮、315 次 TCP/UDP/PTY 门禁。恶意 TCP peer 每次发送 1 MiB + 1 字节，Electron 30 次、Rust 10 次均仅断开超限连接，健康 peer 的碎片帧仍完整到达，服务继续监听；Electron shutdown 后会话数为 0。

Electron 主进程 RSS 首次 209.7 MiB、峰值 261.0 MiB、最后 237.1 MiB；renderer 首次 154.2 MiB、峰值 206.2 MiB、最后 182.3 MiB。Tauri 宿主首次 149.0 MiB、峰值 151.4 MiB、最后 118.1 MiB，此值没有包含独立 WebKit XPC 进程，不能和 Electron renderer 比较或据此判断 WebView 内存。

MQTT 暴露后台问题后，追加 `LINKLAB_SOAK_HIDDEN=1 LINKLAB_SOAK_MS=360000` 的真实 Tauri 隐藏窗口测试，继承生产窗口配置。持续 361,921ms、71 轮、19,880 帧、142 次 Modbus 读写均通过，退出后 SQLite 完整性与 payload 核对通过，未重载。该额外负载约为每秒 55 帧，不能等同于 MQTT 每秒 500 条的背景压力；本轮没有据此修改 LinkLab 的窗口后台策略。证据 `/tmp/linklab-soak-hidden-baseline`。

## 图标与证据

用户发现左上角图标显示问号，原因是本次 Tauri HTTP 测试宿主把 SVG 返回为 `text/html`。宿主已按类型返回 `image/svg+xml`/`image/png`，没有改产品图标。两端正式长跑和 DOM 补验均记录图像解码成功、自然尺寸 256×256。

原始证据 `/tmp/linklab-soak-20261012` 包含双端 `summary.json`、`history-verification.json`、运行日志、Electron 截图、独立原生和恶意输入日志。新增脚本通过项目 `npm run lint`；产品基线回归见现有功能验收矩阵，未因测试脚本重复全部产品测试。

## 验收边界

本轮没有安装包、正式签名、Windows/Linux、macOS x64、实体串口或生产升级验收。Tauri 的测试页面注入与临时关闭权限只存在于本次配置；长跑不覆盖全部 UI、辅助访问人工点击或生产安装包替换。三个工具原首轮在同机运行，内存和吞吐是该环境下的样本；20 分钟结果不保证无限运行。
