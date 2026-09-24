# SDK 多连接实施计划

设计依据：[DebugRouter 支持多连接](https://bytedance.larkoffice.com/docx/K3WUdlIwWoxxZtxZESecIjr1nCd)。本计划只涉及 `debug_router` SDK 主链路；现有 `debug_router_connector` Multiplexer 是独立的一层，在本轮保持旧协议行为。

每一步先讨论并确定该步的接口、行为和边界，再编码、运行单元测试、由独立 agent 检查代码简洁性，最后单独提交。优先复用现有设施，避免冗余校验、兼容分支和只为过渡而存在的封装。单个功能点的源码增量尽量不超过 100 行；完整性需要时可以超出。完整功能接通前，中间步骤不得影响现有上下游行为。

| 步骤 | 状态 | 功能点与验收重点 |
| --- | --- | --- |
| 1 | **OK** | TCP 服务的状态和消息回调携带所属连接身份，保持单连接及新连接替换旧连接的现有行为。提交 `2e2ae5d`；相关 7 项单测通过，独立 agent 已审查。 |
| 1a | **OK** | 将内部 TCP 监听器、连接对象及 Core 适配器更名为 `TcpServer`、`TcpConnection`、`TcpServerTransport`；保留对外 USB API 并注明其 TCP 含义。只改命名，不改变行为。 |
| 2 | 待讨论 | TcpServer 和 Core 建立多连接所有权及定向收发：多个 TCP 客户端与出站 WebSocket 可共存，关闭一条连接不影响其他连接。正式启用时机需先确认，避免 Session 路由尚未完成时改变上下游行为。 |
| 3 | 待讨论 | 将协议解析、封装和版本判断集中到协议层；每条连接独立保存协议状态与 `client_id`。旧版兼容仅在协议层完成，在线上字段 `session_id`、`target_id` 的不同语义处加注释；非协议层统一使用新语义命名。 |
| 4 | 待讨论 | 为 DevTool 后端预留按 Target 创建、销毁 Session 的接口，并贯通 C++、Android、iOS、Harmony。DevTool 实际的 Session 实现尚未完成，本步不伪造后端状态。 |
| 5 | 待讨论 | 旧前端兼容：按连接和 Target 管理默认 Session，并在协议边界转换旧 `session_id` 字段，保持旧前端可用。 |
| 6 | 待讨论 | 新协议的显式 Session 创建、销毁、结果事件、CDP 路由和按 Session 定向发送。 |
| 7 | 待讨论 | 精确清理连接断开、Target 销毁及服务停止涉及的 Session 和路由；补全跨平台、并发及旧/新协议组合测试。 |

已确认的总体约束：`Connect`/`Disconnect` 管理出站 WebSocket，`StartServer`/`StopServer` 管理 TCP 服务；公开连接状态按“是否存在任意活动连接”聚合。新协议的 Session 创建由后端同步返回；现有 Connector 在本轮仍作为旧协议客户端。第 2 步的实际启用时机尚待确认，其余未定细节留到对应步骤逐项讨论。
