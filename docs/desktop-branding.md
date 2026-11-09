# 桌面开发与压力测试宿主品牌

macOS 的 Dock 名称、应用菜单和图标来自原生宿主元数据。开发与测试入口统一显示 `Ineed LinkLab`，使用当前维护的 ICNS。正式产品名、Electron appId、Tauri identifier、安装包文件名和用户数据兼容方式保持原值。

`npm run dev:electron` 和 `tooling/soak-test/desktop-soak.mjs electron` 使用 `scripts/dev-electron.mjs`。脚本在忽略目录 `artifacts/electron-dev/` 缓存 Electron 副本，按正式打包配置写入品牌名称、ID 与图标，本地 ad-hoc 重签；缓存键包含 Electron 版本、架构、品牌元数据和图标摘要。没有修改 node_modules 中的 Electron。

`npm run dev:tauri` 和 Tauri 子工作区内的 `npm run dev` 使用 `scripts/dev-tauri.mjs`。macOS 的 Cargo target runner 在构建完成后由 `scripts/tauri-app-runner.mjs` 将实际可执行文件装入 `artifacts/tauri-dev/<identifier>/Ineed LinkLab.app`；Tauri 仍负责 Vite、编译和原生热重载。runner 用 Node `process.execve` 替换自身，保证停止或重建时关闭实际窗口，避免多余应用进程。该 macOS runner 需要 Node 22.15+，本项目推荐 Node 26。其他系统沿用 Tauri/Cargo 原入口。

根 Tauri 命令直接调用 Node 启动器，以完整转发 `--config` 等参数。隔离压力测试的 identifier 与 devUrl 由原有测试配置提供，临时 .app 同步使用该 identifier，不替换正式数据目录。代码、图标与品牌元数据变更后重新启动对应开发命令；Tauri 重建时重新生成宿主。

这里的签名用于本地开发与测试，正式发行仍遵循 [打包与验收](desktop-packaging.md) 的签名要求。Electron 发行配置也明确设置 CFBundleName / CFBundleDisplayName。

## 2026-10-13 本机验证

macOS arm64 原生对照：默认 Electron 的 Dock/应用菜单为 Electron，新宿主的名称、菜单和窗口标题均为 Ineed LinkLab；裸 Tauri 的 Dock 名称为 ineed-linklab-tauri，新宿主为 Ineed LinkLab。独立 Swift 读取 NSRunningApplication.localizedName 和 AX 菜单/窗口标题，ICNS 与维护源逐字节一致。

常规 Tauri 开发入口实际触发一次原生重建，原进程退出、只保留一个新品牌窗口；停止命令后没有遗留窗口。两端可见回环短测通过：Electron 800/160/160 条 TCP/UDP/PTY 发送与接收一致、16 次 Modbus；Tauri 700/140/140 条一致、14 次 Modbus，异常输入分别拒绝 1 项。窗口资源检查无缺失图标，两端 renderer errors 为空。

Electron/Tauri 边界和旧用户数据兼容测试 66/66、发布回归 21/21、lint 与 diff 检查通过。证据在工具工作区 `scratch/2026-10-13-tools-desktop-branding/`；本次未重做长期压力测试、生产安装包或其他系统验收，未提交/发布。
