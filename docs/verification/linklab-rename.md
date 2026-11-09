# Ineed LinkLab 改名验收

日期：2026-09-20。原项目 `ineed-dev-tool`，新目录 `/Users/pangzhigang/develop/com.ineedfull/ineed-linklab`。基线为 `44e8c39`，保留原分支与 Git 历史；没有提交或推送。本次先完成桌面项目改名，独立网站随后建设。

## 改动范围

- 产品、窗口、菜单、关于、页面标题统一为 **Ineed LinkLab**，定位为「多协议通信调试助手」。
- 根 npm 包为 `ineed-linklab`，8 个 workspace 包使用 `@ineed-linklab/*`；脚本、依赖、导入、Electron preload 桥及测试同步更新。
- Rust 包/可执行文件为 `ineed-linklab-tauri`，库为 `ineed_linklab_tauri`；配置、锁文件、打包命名与验证脚本同步更新。
- `DevToolShell.vue` 改为 `LinkLabShell.vue`，对应 CSS 选择器和测试同步更新。
- 图标源改为 `ineed-linklab.svg`，SVG 标题与引用同步更新；现有 Ineed 渐变、数字脉冲和探针端点造型适合新定位，保留图形。Electron/Tauri PNG 和 ICNS 已重新生成，渲染结果与原图形一致。
- 根目录整体移动，npm workspace 软链接已重新生成；package-lock 只发生名称替换，没有升级第三方依赖。

## 数据兼容

安装标识 `com.ineedfull.dev-tool.electron` / `com.ineedfull.dev-tool`、数据库文件名 `ineed-dev-tool.db` 和布局偏好的 `devtool` 命名空间有意保留。Tauri 因而继续使用原数据位置。

Electron 在 ready 之前检查新旧默认目录：新默认目录没有数据库、旧默认目录有数据库时，沿用旧 userData 与默认 sessionData。显式配置的数据/会话目录和已有 LinkLab 数据库优先。没有搬移、覆盖或删除真实用户数据。

6 项回归覆盖发布名目录、开发包目录、已有 LinkLab 数据优先、自定义数据目录、新安装及自定义 sessionData。原生验证使用独立临时目录和真实 SQLite 测试连接，确认两次启动都读到旧目录内容。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| ESLint | 0 错误、0 警告 |
| Node 测试 | 967 通过，包含 6 条数据路径兼容回归 |
| Vue 组件 | 25 个文件、200 项通过 |
| Electron / Tauri 渲染器构建 | 两端通过 |
| 构建后边界检查 | 56 项通过 |
| Rust fmt | 通过 |
| Rust test --locked | 152 通过、4 忽略；忽略项需要专用集成环境，本次未运行 |
| 浏览器端到端 | 108 项全量用例通过；6 项关于页用例更新旧副标题断言后单独复测全部通过，总计 114 项已验证 |
| Electron 原生启动与重启 | 两轮真实窗口、preload/IPC、SQLite、关于页、新品牌文字通过；页面异常 0，退出码均为 0 |
| Git diff --check | 通过 |
| 原有未跟踪 pnpm-lock.yaml | SHA-256 与改名前一致，未纳入修改 |

改目录后，Tauri 的旧 debug 构建缓存仍携带绝对路径；清理对应插件的开发构建缓存后重新编译通过。保留历史 release 包。Vite 仍提示既有 ECharts 大块体积，这与名称迁移无关，未通过调高阈值屏蔽。

本次原生 Electron 验证来自开发目录的真实程序，不是新 DMG 安装验收。没有重新发布/签名/公证安装包，没有执行 Tauri 全原生界面操作或 Windows/Linux 实机验收。

## 证据

- [Node 与组件测试](linklab-rename-evidence/tests.txt)
- [渲染器构建](linklab-rename-evidence/build.txt)
- [边界检查](linklab-rename-evidence/boundaries.txt)
- [Rust 测试](linklab-rename-evidence/rust.txt)
- [首轮浏览器回归](linklab-rename-evidence/e2e.txt)，保留旧副标题断言失败记录
- [关于页修正后复测](linklab-rename-evidence/about-e2e.txt)
- [原生两轮记录](linklab-rename-native.json)
- [实际关于页截图](linklab-rename-native-about.png)

历史设计、验收文档、历史二进制和其他仓库中的旧截图仍使用当时的 DevTool 名称，不伪造历史记录。后续 LinkLab 网站应使用新品牌并注明旧版本截图的来源。
