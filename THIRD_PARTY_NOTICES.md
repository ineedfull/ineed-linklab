# Ineed LinkLab 第三方声明

本项目使用开源依赖与第三方素材，感谢原作者及贡献者。项目原创源码采用 [Apache-2.0](LICENSE)，第三方文件适用各自条款，原有版权、LICENSE 和 NOTICE 继续有效。

## 清单与原文

- [依赖清单](docs/legal/third-party-inventory.json)：锁定版本、开发/可选标志、许可证元数据、原文文件名与 SHA-256，以及逐条待复核项。
- [许可证原文集](docs/legal/third-party-license-texts.txt)：本地实际收集的许可证及声明，按原始文件 SHA-256 去重，可由清单中的 `licenseFiles` 对应查找。
- [维护与核验说明](docs/legal/README.md)：生成方法、覆盖边界与发布前处理。

清单包含 npm 锁文件中的开发、可选、跨平台条目；有 Tauri 的产品同时包含 Cargo.lock 第三方条目。它不等于每个安装包的实际组件清单。元数据中的 `OR` 表示可选许可路径，`AND` 可能要求同时满足；本轮保留原表达式，不替分发者静默选择。标为 `reviewRequired` 不代表该依赖必然不可用，而是需要补证据或核对具体义务。

### OPC UA 供应商代码

`apps/tauri/src-tauri/vendor/async-opcua-crypto/` 与 `async-opcua-server/` 均为 async-opcua 0.19.0 的第三方代码，继续采用 **MPL-2.0**，保留原 LICENSE、作者声明和源码。它们不会因根 LICENSE 改为 Apache-2.0 而被重新许可。

原生工程 `[patch.crates-io]` 记录本地改动用途：证书 URI SAN 顺序校验与延迟采样调度。分发相关二进制时，需要按 MPL-2.0 提供 Covered Software 的相应源码及修改，并明确获取途径；在实际公开地址确定前，不能仅以一个尚不存在的仓库链接代替这项工作。其它依赖也可能含 MPL-2.0 文件，应按实际分发范围核验。

### 待补许可证据的旧 npm 依赖

`dequeue@1.0.5`、`humanize@0.0.9`、`precond@0.2.3` 的锁文件及已安装 package.json 未声明许可。`precond` 的源码头部和 README 提到 MIT，但这不等于当前已收集完整许可原文。它们不是本项目原创代码，不能直接套用 Apache-2.0。首次公开/分发前需补充对应版本授权证据，或评估替换依赖；本轮未改动这些依赖。

## 原生运行时和分发物

Electron 安装包自带 Chromium、Node.js 等组件；npm 包清单与根许可文件不能替代 Electron 分发物中的 LICENSE、LICENSES.chromium.html 及相关声明。Tauri 使用系统 WebView，并有 Rust、SQLite、TLS 等原生依赖，其具体义务需要对应目标平台和实际构建核对。

图标、字体、复制的示例或 vendor 代码应单独核对来源。项目品牌与微信二维码的来源见[图片说明](docs/images/readme/README.md)；不能因图片出现在仓库中就推定它获得了所有第三方授权。

## 当前覆盖边界

这是依赖声明与本地原文收集，尚不是完整兼容性审核或所有系统安装包的许可认证。未安装的 npm 平台包、未缓存的 Cargo 包，以及没有标准许可文件名的组件可能缺少原文；这些缺口保留在清单中。不要把它们自动标成 MIT、Apache-2.0 或已经审核通过。

正式分发前应针对实际包含的组件补齐原文、版权与 NOTICE，处理需提供源码的义务，并记录公开源码/补丁获取途径。新增、删除或升级依赖/素材后，重新生成并审查差异。发现归属或许可问题，可通过[维护者联系渠道](README.md#官网与交流)反馈。
