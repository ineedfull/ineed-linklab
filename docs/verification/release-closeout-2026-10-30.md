# LinkLab：2026-10-30 发布前收尾验证

## 源码与门禁

功能及修复归档 4579064；持续游标释放、恢复和静置验收脚本 005e654；候选文件来自干净的 005e654。

Node 1328、组件 352、Rust 229（5 个既有忽略）、vendor subscription 12；lint、build、fmt。

## 持续负载

Electron 协议服务与 Rust 原生服务连续 1200.113 秒，各 2972 次读写、2972 次 BrowseNext 释放，两游标配额下各 238 页；各 360 次预期拒绝、3 次断服恢复；静置 180.050 秒，无迟到订阅数据、无待处理原生请求。该项是原生服务长跑，未计作 GUI 可见长跑。

有限时长的内存采样出现恢复，不代表排除所有长期泄漏；同时运行构建，不能用本轮 RSS 精确比较不同产品。全部测试使用隔离用户数据和回环服务，未使用用户云账号施压。

## 实际候选包

macOS Electron arm64 原始 DMG 两轮真实窗口、TCP echo、配置/历史重启和同版本替换通过；四个 DMG 身份/版本/架构检查通过。本轮 Tauri 生产包完整 GUI 未验收，Rust 原生协议长跑单独记录。

Linux x64 DEB/AppImage 载荷和摘要一致，提取后的实际应用在 Ubuntu + Xvfb 两轮 GUI、真实回环通信及重启替换通过。未宣称物理桌面、系统级 DEB 安装或 FUSE 验收。Windows x64 NSIS 在 Wine 9 实际安装/覆盖安装/卸载、载荷一致及生成的 SQLite 哨兵保留通过，嵌入 Node/SQLite 可加载。新 NSIS 模板遇到 Wine 返回成功的 PowerShell 空实现，仅在私有测试环境禁用该空实现后使用安装器官方 tasklist 备用路径；未修改生产安装器。

Windows 实机 GUI、真实旧用户数据升级、DPAPI、Intel Mac 与实体设备仍待对应环境。

本轮安装文件为未正式签名的测试包；没有发布签名自动更新 feed。同版本替换不能替代正式跨版本自动升级。每个文件的 buildId、sourceCommit、大小、SHA-256 和验证范围以本工作区 `docs/downloads/2026-10-30-closeout/` 交接文件为准；旧 URL 保留，失败候选不发布。
