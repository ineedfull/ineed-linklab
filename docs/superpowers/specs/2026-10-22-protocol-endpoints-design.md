# OPC UA / STOMP 多端点与统一列表

用户要求两种协议与 TCP/UDP 一样支持创建多个端点，取消独立单例页面。沿用会话中自主完成、不重复确认的授权；本次不提交或发布。

## 选择

采用统一端点目录门面，复用现有两种配置存储：OPC UA 原生 profiles.json、STOMP SQLite settings.stompProfiles。目录是这些配置唯一的 UI 写入者，按端点维护独立共享控制器。普通 TCP/UDP 等端点仍由原模型管理。三种来源合并成同一个树、新建入口、协议筛选和操作菜单，每种配置只有一个真实来源。

备选为将两种协议迁至 endpoint_profiles，需要双端数据库迁移、原配置幂等转换及导出格式扩展；本次统一交互并不需要承担这些迁移。仅给独立页面添加下拉切换，仍缺少同时连接和统一操作，不采用。

## 用户行为

- 添加端点可选择 OPC UA Client、STOMP Client、STOMP Server，并填名称和基本地址；保存后选中该端点，详细安全/订阅配置在右侧对应工作台编辑。角色由端点类型固定。
- 端点树包含 OPC UA/STOMP 协议分类，支持搜索、筛选、展开/折叠、重命名、编辑、删除及独立打开/取消/关闭。分组指现有协议分类，不增加自定义目录功能。
- 每个端点拥有独立会话、临时认证、订阅/待确认、消息/值记录及面板草稿。切换选择只切换显示；访问过的面板按稳定 key 保留，删除/卸载才销毁。
- 已保存 profiles 直接显示为端点，不自动联网、不改写或丢弃旧数据。删除先取消/断开对应会话，持久化失败保留该条端点并显示错误。编辑活动连接参数需要先断开；重命名可保持会话。
- OPC UA 保留独立连接配置导入/导出、证书和数据导出；STOMP 配置仍随通用设置导入/导出。统一列表不改变两者已有文件格式及 PKI 位置。

## 边界与接口

新增 `createProtocolEndpointCatalog(runtime,{reactive})`，将持久 profile 投影为 `{id,profileId,name,transport,config}`，类型为 opcua-client / stomp-client / stomp-server，树键为 `protocol:opcua:<profileId>` 或 `protocol:stomp:<profileId>`。普通端点用自身 ID；统一展示层应避免键冲突，不将合成键送入普通 transport API。

目录暴露 state（loading/error/busy/profiles/instances）、endpoints、has(id)、get(id)、initialize()、saveEndpoint(draft)、remove(id)、connect(id)、disconnect(id)、dispose()；get 延迟创建并返回绑定 API，state 与既有工作台一致，saveProfile/importProfiles/exportProfiles 由目录集中处理。所有配置读改写按来源串行，STOMP 与外观设置 saveAll 共用设置写入协调，禁止多个控制器持有陈旧整表后覆盖。

面板新增可选 `controller` 和 `endpoint` props。绑定时不自行 initialize/dispose、不显示全局 profile 下拉/角色切换/删除；右侧保存调用目录，未绑定模式保留作协议专项测试。运行时依旧使用独立 runtime.opcua/stomp，认证帧绝不进入普通 transport/send/history。

原生并发限制保持 STOMP 4、OPC UA 8；补齐 Rust OPC UA 与 Electron 的 8 会话一致性。OPC UA connect 对已连接或正在恢复的实例幂等，防止遗失旧 connectionId。迟到事件继续使用独立 connectionId/sessionId 隔离。

## 验收

先失败后修复：目录集中保存并发、已有 profiles 展示、两个端点独立状态/认证、取消/删除与迟到连接、配置回读不含凭据、外观设置不覆盖配置；面板所有权、树/新建/筛选/重命名/删除与显示矩阵。两端真实桌面验证同应用多个 OPC UA 和 STOMP Client/Server 并行通信、切换保留、关闭其中一个不影响其它、删除后清理。旧 WebSocket 20+3 长跑单独结束后再启动其它 GUI；旧功能回归、原生协议与浏览器 fixture 分开记载。
