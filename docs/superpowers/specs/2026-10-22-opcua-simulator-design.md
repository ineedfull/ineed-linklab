# OPC UA 模拟服务端

用户已同意将模拟服务端补入统一端点；沿用已有的多端点、共享工作台、各运行时原生协议适配器。首个完整流程是：添加服务端、编辑节点、启动、客户端浏览/读取/写入/订阅、观察变化、停止，再次启动或删除。

## 界面与生命周期

添加端点新增 `opcua-server`，在 OPC UA 分类内与客户端共存。每个实例独立配置、控制器、节点草稿、监听端口和运行状态。切页不停止；删除/退出释放该实例。客户端已有端点ID、配置文件、PKI与会话行为保持兼容。服务端配置单独写 `opcua/server-profiles.json`，不自动启动。

服务端工作台沿用协议控件、主题、字号、状态、启动/停止、保存/导入/导出和错误反馈。提供节点增删编辑、载入示例、当前值/质量/完整时间、手动更新与自动变化设置。运行中锁定结构与监听参数，可更新节点当前值。配置保存的是明确的初始值，不将远程写入静默覆盖成下次启动初值。列表/记录均有界。

## 原生接口

共用 `runtime.opcua.execute(request)`。新增：

| action | 请求 | 返回 |
| --- | --- | --- |
| serverProfiles | 无 | `{profiles}` |
| saveServerProfiles | `{profiles}` | `{profiles}` |
| startServer | `{connectionId,config,nodes}` | `{sessionId,endpointUrl,namespaceIndex,nodes:[{id,nodeId}]}` |
| stopServer | `{connectionId,sessionId?}` | `{stopped:true}` |
| serverSnapshot | `{connectionId,sessionId}` | `{values:[{nodeId,dataType,arrayType,value,statusCode,sourceTimestamp,serverTimestamp}]}` |
| setServerValue | `{connectionId,sessionId,nodeId,value}` | `{updated:true}` |

`stopServer`幂等；给定旧sessionId不得关闭新代。start pending计入4实例上限；取消、启动失败、端口冲突与退出都关闭socket/定时器。快照与更新必须验证sessionId，旧完成结果不能覆盖新会话。控制器串行轮询快照（1秒，不重叠），停止/销毁取消后续轮询。异常事件使用`serverStatus`，不与客户端事件混淆。

## 配置与节点契约

配置默认 `{listenHost:'127.0.0.1',listenPort:4840,path:'/LinkLab',namespaceUri:'urn:ineedfull:linklab:simulator'}`。首版地址支持127.0.0.1/0.0.0.0；端口整数1..65535；path以/开头、1..128、仅字母数字/下划线/连字符；namespaceUri为非空urn或http(s)URI、最多256、无控制字符，不得复用标准namespace0及双端server application保留URI。UI明确当前为None/匿名测试模拟器，面向可信网络，不声称提供加密/认证。

节点 `{id,name,dataType,arrayType,value,writable,simulation}`：id为1..80位字母数字/点/下划线/连字符且唯一；name非空最多100。1..100节点，数组最多100项、每字符串最多4096字符，节点JSON整体最多256KiB。类型Boolean/Int16/UInt16/Int32/UInt32/Int64/UInt64/Float/Double/String/ByteString/DateTime；64位十进制字符串、ByteString base64、DateTime显式时区ISO。实际NodeId由原生返回，不硬编码namespaceIndex。所有UI与两端原生独立校验，不能只依赖前端。

simulation默认`{mode:'manual',intervalMs:1000,min:0,max:100,step:1}`。数组及非数值类型只manual；Boolean可toggle；Int16/UInt16/Int32/UInt32/Float/Double可increment，interval整数100..60000，合法类型范围内min<=max、step>0，下一拍current+step超出[min,max]回min；手动/远程写入仅按类型校验，不强制模拟范围。自动变化由原生任务驱动，与页面是否可见无关。远程写只允许writable节点；本地模拟器可更新readonly节点（模拟传感器）。

profile为`{id,name,config,nodes}`；最多50，整个列表1MiB，去除未知字段，原子写入。只保存初始配置，不含临时运行数据。现有客户端文件与SQLite迁移不变。

## 验证

测试先覆盖原生/模型缺失行为再实现。真实Node SDK验证两运行时多实例、发现/浏览、类型读写/readonly、订阅和自动变化、停止/重启、旧会话与端口/名额复用；异常输入边界和启动取消也覆盖。共享组件检查增删节点/保存/运行锁/切页/失败反馈。两端浏览器矩阵覆盖浅深色/普通大字/侧栏/窄窗口；原生GUI串行、隔离数据/回环。机器时间不改，所有界面使用统一日期格式。
