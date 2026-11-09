# LinkLab 开发指南

[返回产品首页](../README.md) · [代码阅读地图](code-reading.md)

## 依赖与结构

按 `.nvmrc` 使用 Node.js 26。Tauri 需准备 Rust 与[平台开发依赖](https://v2.tauri.app/start/prerequisites/)；既有研发基线使用 Rust 1.96，具体锁定依赖见 Cargo.lock。

```text
apps/electron/   Electron 入口、受限 IPC、协议服务与原生测试
apps/tauri/      Tauri / Rust 入口、协议服务与原生测试
packages/       Vue 工作台、领域、编解码与运行时契约
scripts/        品牌宿主、安装依赖、打包及发布
```

两端共用工作台与领域模块，平台适配留在各 runtime。端点、事件、写入与诊断的调用链见[阅读地图](code-reading.md)。

## 安装与启动

仓库根目录使用锁文件安装：

```sh
npm ci
npm run dev:electron
```

国内下载 Electron 二进制遇到问题时，可用 `npm run bootstrap`。该命令设置 Electron / electron-builder 二进制镜像后执行 `npm install`，与 `npm ci` 的锁定安装语义不同；安装后检查锁文件改动。

Tauri 桌面入口：

```sh
npm run dev:tauri
```

两个命令都会启动真实桌面。macOS 开发与长跑入口准备独立品牌宿主，Dock、菜单和窗口显示 LinkLab；缓存与热加载见[宿主品牌](desktop-branding.md)。

## 验证

```sh
npm test
npm run lint
npm run build
```

`npm test` 包含 Node 与 Vue 组件测试；macOS/Linux 的 Modbus RTU 真实伪终端用例要求 PATH 中有 `socat`，Windows 跳过该 PTY 用例，仍需真实 COM 设备验收。`lint` 不接受 warning。

安装锁文件对应的 Chromium 后运行浏览器交互回归：

```sh
npm run install:chromium -w @ineed-linklab/workbench
npm run test:e2e
```

Playwright 使用各产品渲染器入口与隔离测试桥，结果不能替代原生协议验收。Rust 基础检查：

```sh
cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check
cargo test --locked --manifest-path apps/tauri/src-tauri/Cargo.toml
```

已缓存工具链和锁定依赖时才可追加 `--offline`。协议原生专项入口见 OPC UA、WebSocket、STOMP 等对应指南；串口回环入口为 `node tooling/serial-test/pty-loopback.mjs`。这些测试使用隔离数据及本机服务。

历史 `verify:phase-*` 聚合入口仍在 package.json，选择门禁应依据变更范围，不将阶段编号视为当前任务进度。[功能矩阵](existing-features-acceptance.md)和[双端长跑](reliability-soak-2026-10-12.md)记录实际环境与限制，[后续验证](reliability-soak-2026-10-13.md)记录背压等修复。

## 接收分帧边界

分隔符和空闲分帧最多缓存 1 MiB（1,048,576 字节）的未完成帧，分隔符计入上限。两字节分隔符对应最大载荷 1,048,574 字节；单次读取包含多条完整帧时，总字节数可以超过 1 MiB。Raw 与定长保持各自规则。

持续没有分隔符或空闲、达到上限时，整条未完成帧被丢弃，报告带限制信息的 IO_ERROR，并关闭串口/TCP 客户端或受影响的 TCP 服务端 peer；TCP 服务端继续监听其它 peer。修正配置或对端输入后重新打开连接，不把截断消息当作有效帧。

## UI、数据与打包

遵循[字号规范](typography.md)、[窗口参数与分组](window-forms.md)和[时间规则](superpowers/specs/2026-07-15-unified-millisecond-timestamps-design.md)。工具箱入口收纳编码与校验、设备模板、验收检查，避免占用端点列表空间。

配置与模板可通过工作区导出。完整历史备份需退出应用后备份实际用户数据目录，不手动合并数据库或修改应用身份。

图标副本在 `packages/workbench/src/assets/ineed-linklab.svg`；先维护品牌源，再运行 `npm run icons:generate`。安装图标需重新打包安装。Electron afterPack 校验 ASAR 内容摘要，编解码以 runtime dependency 打入安装包，不能依赖源码目录。

新安装包使用 `release:plan/build/verify`，目标系统原生构建。旧 `package:mac:*` 入口保留兼容，不与标准发布清单混用；签名、目录与各平台验收见[桌面打包](desktop-packaging.md)。`release:upload` 是远端动作，只有明确发布任务才运行。

首页图片的日期与环境见[图片维护](images/readme/README.md)。

## 退出异常排查

[2026-11-08 Electron退出挂起调查](reviews/2026-11-08-electron-exit-hang.md)记录一次旧联调实例的原生清理挂起、8组隔离复现及当前证据边界；短时复现通过不代表原问题已经修复。

[长跑问题修复与验证](soak-fixes-verification-2026-11-09.md)记录关闭所有权、2秒窗口恢复、预览分配优化和Tauri隐藏窗口调度修复。原生串口根因与自然内存回收按报告实际结果判断，不用窗口恢复代替退出成功。
