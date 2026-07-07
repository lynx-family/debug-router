# DebugRouter Multiplexer 技术方案

## 1. 背景

`debug_router` SDK 侧的连接模型仍然是单前端独占：native 侧只保存一个当前 transceiver 或 USB client，新连接会替换旧连接。HDT、Lynx DevTool MCP、VSCode 插件等多个 DevTool 前端如果都直接通过 `debug_router_connector` 连接同一个 SDK runtime，就会出现后启动前端抢走连接、旧前端断开的现象。

Multiplexer 的当前实现把“多前端并发”收敛到 `debug_router_connector` 内部：本机只保留一个 detached daemon 持有真实设备和 SDK runtime 连接，所有 connector 进程和 WebSocket frontend 都通过这个 daemon 共享同一条物理通道。

## 2. 术语、用法与目标

### 2.1 阅读指引

这份文档用于帮助快速建立代码结构和调用流程的上下文。建议优先阅读：

1. `4. 整体架构`：看清 connector 进程、daemon、WebSocket frontend 和 SDK runtime 的边界。
2. `5. 公开 DebugRouterConnector facade`、`6. daemon 发现、启动与替换`：理解普通接入方如何自动复用 daemon。
3. `10. WebSocket frontend 路径`、`11. Message ID 重写与路由`：理解多前端并发时如何做来源隔离和定向回包。
4. `12. 旧多开 owner 兼容`、`13. 容灾、恢复和退出`：理解旧 `LatestDriverProcess` 兼容、daemon 崩溃和 idle 退出。

当前实现的重点边界是：公开 `DebugRouterConnector` 已是 Multiplexer facade；真实物理连接在 daemon 内；connector 侧主要持有 device 和 USB runtime client 镜像；WebSocket app client 目前进入 daemon 内的 `ClientList`，但不会作为 connector control client 的同步事实来源。

### 2.2 术语

| 名称 | 含义 |
|---|---|
| debug_router SDK | SDK 侧 DebugRouter 组件，负责接收前端调试消息并返回 SDK runtime 事件和响应。 |
| debug_router_connector | PC 侧 DebugRouter 连接库，负责设备发现、连接 SDK runtime，并向 HDT/浏览器调试页面提供 WebSocket 调试入口。 |
| DebugRouter Multiplexer | connector 内部的本地多路复用机制，由 daemon 统一持有真实设备和 SDK 连接，并为多个前端做消息隔离、id 重写和定向回包。 |
| Multiplexer daemon | 本机 detached 共享进程，负责真实物理连接、control server、WebSocket server、snapshot/event 广播和路由。 |
| control client | 普通 connector 进程通过 control WebSocket 连接 daemon 后形成的 daemon client。 |
| WebSocket Driver frontend | HDT 这类 type 为 `Driver` 的 WebSocket 前端页面。 |
| runtime client | SDK runtime 对应的调试目标。当前 connector 镜像主要覆盖 USB runtime client；WebSocket app client 由 daemon 内 `WebSocketController` 跟踪并出现在 `ClientList` 中。 |

### 2.3 接入方用法

对 HDT、Lynx DevTool MCP、VSCode 插件等接入方而言，Multiplexer 是 `debug_router_connector` 内部能力。接入方仍按原方式创建和使用 `DebugRouterConnector`：

```ts
const connector = new DebugRouterConnector(options);
```

原有设备发现、runtime client 连接、消息发送和事件订阅接口保持兼容：

```ts
connector.on("device-connected", (device) => {
  // 复用原有处理逻辑
});

connector.on("client-connected", (client) => {
  // 复用原有处理逻辑
});

const devices = await connector.connectDevices();
const clients = await connector.connectUsbClients(deviceId);
```

普通 connector 进程不会再直接持有真实 SDK 连接，而是自动发现或拉起本机 Multiplexer daemon，并通过 daemon 访问真实设备和 runtime。接入方只需要升级到包含 Multiplexer 能力的 `debug_router_connector` 版本，并继续使用原有 `DebugRouterConnector` API。

### 2.4 目标

目标：

1. SDK 侧仍然只看到一个真实 DevTool 前端连接，不要求 SDK native 支持多 frontend。
2. 多个 `DebugRouterConnector` 实例、HDT 页面和其他上层工具可以同时存在，并复用同一个本地 daemon。
3. 公开 `DebugRouterConnector` API 尽量保持原有调用习惯：设备和 runtime client 通过本地镜像对象与事件暴露给接入方，WebSocket server 仍保留原路径和兼容字段。
4. 对 CDP/App request-response 做 message id 隔离，避免不同前端使用相同 id 时串包。
5. daemon 崩溃、协议升级、空闲退出和旧多开 owner 被抢占时有可恢复路径。

### 2.5 非目标

非目标：

1. 不修改 SDK native 侧的单连接模型。

### 2.6 方案取舍

另一个方案是在 SDK 侧直接支持多前端连接和消息分发。当前实现选择 connector 内 Multiplexer，原因是改动边界更可控，接入方升级成本更低，也便于灰度和回滚。代价是本地链路多了一次 connector 到 daemon 的跨进程转发，并需要额外维护 daemon 的发现、生命周期和排障链路。

| 方案 | 优点 | 缺点 |
|---|---|---|
| connector 内 Multiplexer | 不改 SDK native；接入方只需升级 connector；灰度和回滚更可控。 | 多一层本地转发；daemon 生命周期和问题排查多一层。 |
| SDK 侧支持多前端 | 链路更短，连接模型更直接。 | native 改造面更大；依赖业务发版覆盖；回滚更困难；SDK 侧也需要新增分发、生命周期和兼容逻辑。 |

## 3. 当前代码边界

公开 facade：

- `debug_router_connector/src/connector/DebugRouterConnector.ts`
- `debug_router_connector/src/connector/index.ts`
- `debug_router_connector/src/index.ts`

connector 侧 daemon client 与镜像对象：

- `debug_router_connector/src/multiplexer/client/MultiplexerDaemonClient.ts`
- `debug_router_connector/src/multiplexer/client/MultiplexerDaemonManager.ts`
- `debug_router_connector/src/multiplexer/client/MultiplexerDiscovery.ts`
- `debug_router_connector/src/multiplexer/client/MultiplexerDevice.ts`
- `debug_router_connector/src/multiplexer/client/MultiplexerUsbClient.ts`

daemon 侧：

- `debug_router_connector/src/multiplexer/daemon/entry.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerDaemon.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerHost.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerControlServer.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerControlConnection.ts`
- `debug_router_connector/src/multiplexer/daemon/PendingRouteTable.ts`
- `debug_router_connector/src/multiplexer/daemon/LegacyOwnershipGuard.ts`

协议和工具：

- `debug_router_connector/src/multiplexer/protocol/control.ts`
- `debug_router_connector/src/multiplexer/protocol/discovery.ts`
- `debug_router_connector/src/multiplexer/protocol/event.ts`
- `debug_router_connector/src/multiplexer/protocol/snapshot.ts`
- `debug_router_connector/src/multiplexer/protocol/validation.ts`
- `debug_router_connector/src/multiplexer/utils/paths.ts`
- `debug_router_connector/src/multiplexer/utils/FileLock.ts`
- `debug_router_connector/src/multiplexer/utils/atomic_file.ts`

WebSocket 与物理层：

- `debug_router_connector/src/websocket/WebSocketServer.ts`
- `debug_router_connector/src/websocket/WebSocketConnection.ts`
- `debug_router_connector/src/physical/PhysicalConnector.ts`

当前 `src/connector` 目录只导出新的 `DebugRouterConnector` facade，没有 `LegacyDebugRouterConnector` 公开实现。

## 4. 整体架构

### 4.1 进程视图

```text
接入方进程
  DebugRouterConnector
    MultiplexerDaemonClient
      ws://127.0.0.1:<controlPort>/debug-router-multiplexer/control
        Multiplexer daemon
          MultiplexerHost
            PhysicalConnector
              SDK runtime / device

HDT 等 WebSocket frontend
  ws://<host>:<wssPort>/mdevices/page/android
    daemon 内 WebSocketController
      MultiplexerHost
        PhysicalConnector
          USB SDK runtime / device
```

connector 进程不再直接持有真实设备 watcher 和 SDK runtime 连接。真实连接只在 daemon 进程内的 `MultiplexerHost -> PhysicalConnector` 中存在。connector 进程当前主要维护本地 `MultiplexerDevice` 和 `MultiplexerUsbClient` 镜像；WebSocket app/web client snapshot 的类型和 facade 处理分支已经存在，但当前 Host 不会把 WebSocket client 连接事件广播到 control clients。

### 4.2 本地状态目录

默认目录是：

```text
~/.DebugRouterConnector/multiplexer/
  spawn.lock
  daemon.lock
  daemon.json
```

可通过 `multiplexerRootDir` 或 `multiplexerDataDir` 覆盖路径，主要用于测试、隔离运行或特殊打包场景。

`daemon.json` 的当前结构由 `MultiplexerDiscoveryInfo` 定义：

```ts
type MultiplexerDiscoveryInfo = {
  pid: number;
  protocolVersion: number;
  minSupportedProtocolVersion?: number;
  controlPort: number;
  heartbeat: number;
  startedAt?: number;
  daemonVersion?: string;
  capabilities?: string[];
};
```

`spawn.lock` 用于抢占 daemon 启动权，只在 connector ensure daemon 的启动窗口内持有。`daemon.lock` 由 daemon 进程持有，表示当前 daemon owner。`daemon.json` 由 daemon 在 control server 启动后写入，并按 heartbeat 周期刷新。写入通过 `writeJsonAtomic()` 完成，避免其他进程读到半截 JSON。

## 5. 公开 `DebugRouterConnector` facade

`DebugRouterConnector` 构造时创建：

1. `MultiplexerDiscovery`，负责读取和校验 `daemon.json`。
2. `MultiplexerDaemonManager`，负责 ensure、spawn、replace、health check 和 stale cleanup。
3. `MultiplexerDaemonClient`，负责连接 daemon control WebSocket、发送 RPC、接收事件。
4. 本地 `DriverClient`、trace recorder、设备和 runtime client 镜像 Map。

如果 `manualConnect` 为 false，构造函数会自动调用 `connectDevices()`。`connectDevices()`、`startWatchAllClients()` 和 daemon 断线后的 desired-state 恢复都会先调用 `reacquireLegacyOwnership`，确保 daemon 重新成为旧 `LatestDriverProcess` owner 后再恢复物理 watcher。

公开 facade 的当前行为：

- `connectDevices()` 通过 control RPC 让 daemon 启动物理设备发现，并把返回 snapshot upsert 成本地 `MultiplexerDevice`。
- `connectUsbClients()` 通过 daemon 启动指定 device 的 runtime client watcher，并把返回 snapshot upsert 成本地 `MultiplexerUsbClient`。
- `getDevices()`、`getDeviceUsbClients()`、`getAllUsbClients()` 从本地镜像读取，必要时等待本地事件。
- `startWSServer()` 通过 daemon 启动 WebSocket server，并把返回的 `WebSocketServerInfo` 同步成本地兼容字段 `wssPort`、`wssHost`、`roomId`、`wss.wssPath`。
- `sendMessageToWeb()`、`sendMessageToApp()` 仍保留原调用方式，但实际转发给 daemon。
- `disableAllClients()` 和 `addDeviceManager()` 在 Multiplexer-only facade 中不再操作物理对象，只记录 warning。
- `close()` 只关闭当前 connector 的 control socket、取消订阅并清理本地镜像，不直接关闭 daemon。daemon 是否退出由 idle timeout 或 shutdown/replacement 流程决定。

daemon control socket 断开时，facade 会清空本地镜像、reject 未完成 RPC、按 100ms 延迟调度 desired-state 恢复：重新连接 daemon、恢复设备发现、恢复 `startWatchAllClients()` 和已请求的 WebSocket server。

## 6. daemon 发现、启动与替换

`DebugRouterConnector` 将部分行为转发给 Daemon 时会调用函数 `MultiplexerDaemonClient.call()`。 `MultiplexerDaemonClient.call()` 会先执行 `connect()`；`connect()` 通过 `MultiplexerDaemonManager.ensureDaemon()` 获得可用 daemon。

`MultiplexerDiscovery.validateDiscovery()` 的校验顺序：

1. `daemon.json` 缺失、JSON 非法或 shape 非法时返回 unusable。
2. 缺少 `protocolVersion` 时返回 unusable。
3. heartbeat 超过 `multiplexerStaleTimeout` 时返回 stale。
4. connector 协议低于 daemon 的 `minSupportedProtocolVersion` 时返回 `connector-protocol-too-old`。
5. daemon 协议低于 connector 协议时返回 `replace-required`。
6. 其余 compatible 情况返回 usable。

默认协议常量当前是：

```text
MULTIPLEXER_PROTOCOL_VERSION = 1
MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION = 1
```

`MultiplexerDaemonManager` 对校验结果的处理：

- usable：先访问 `http://127.0.0.1:<controlPort>/health`；health ok 才复用。
- usable 但 health 暂时失败：如果 pid 仍存活，按 `readyPollInterval` 重试 3 次。
- `replace-required`：抢 `spawn.lock`，优先通过 `shutdownDaemon` RPC 请求旧 daemon 主动退出；如果未退出，再 SIGTERM/SIGKILL；随后清理 `daemon.lock` 和 `daemon.json` 并拉起新 daemon。
- connector 协议过旧：抛出升级错误，不清理、不杀掉新版 daemon。
- stale、invalid 或 missing：抢 `spawn.lock` 后执行 cleanup。若 discovery 中 pid 存活会强制停止；若 `daemon.lock` owner 仍存活且不是刚停止的 pid，也会按 lock owner 停止；最后清理本地 artifact 并 spawn。

关键默认值：

```text
startupTimeout = 5000ms
readyPollInterval = 100ms
replacementTimeout = 1000ms
healthCheckTimeout = 500ms
spawnLockStaleTimeout = startupTimeout + replacementTimeout + 1000ms
```

spawn 使用当前 Node 可执行文件 detached 启动 `multiplexer/daemon/entry.js`，`stdio: "ignore"`，随后 `unref()`。启动参数会传入 discovery/lock 路径、协议版本、control port、heartbeat、daemonVersion、capabilities、legacy driver dir、idle timeout、WebSocket 配置和 daemon 侧 `PhysicalConnectorOption`。

## 7. daemon 进程与 Host

`entry.ts` 负责解析 daemon 参数、创建 `MultiplexerHost` 和 `MultiplexerDaemon`，并注册 `beforeExit`、`SIGINT`、`SIGTERM`、`uncaughtException`、`unhandledRejection` 清理逻辑。清理会调用 `daemon.stop()`；强制退出路径最多等待 3000ms。

`MultiplexerDaemon.start()` 的流程：

1. 抢占 `daemon.lock`。
2. 启动 `MultiplexerHost`。
3. 读取 Host 实际 control port。
4. 写入 `daemon.json`。
5. 启动 heartbeat timer，默认每 1000ms 刷新一次 discovery heartbeat。

`MultiplexerDaemon.stop()` 的流程：

1. 停止 heartbeat timer。
2. 停止 Host。
3. 删除 `daemon.json`。
4. 释放 `daemon.lock`。

`MultiplexerHost` 是 daemon 内部核心对象，负责：

- 持有真实 `PhysicalConnector`。
- 启动 control server，提供 `/health` 和 `/debug-router-multiplexer/control`。
- 启动 WebSocket server，继续使用 `/mdevices/page/android`。
- 管理 device watcher、runtime client watcher 和 WebSocket client。
- 序列化 snapshot 并广播 control event。
- 处理 message id 重写、pending route 和回包归属。
- 维护旧 `LatestDriverProcess` owner 状态。
- 管理 idle timeout 和 shutdown handler。

## 8. control 协议

### 8.1 RPC

control RPC 当前由 `ControlRpcMethod` 定义：

| RPC | 作用 |
|---|---|
| `connectDevices` | 启动物理设备发现，返回设备 snapshot |
| `getDevices` | 从 daemon 当前物理连接读取设备 snapshot |
| `connectUsbClients` | 启动指定设备的 runtime client watcher，返回 client snapshot |
| `startWatchClient` | 对单个 device 启动 runtime client watcher |
| `stopWatchClient` | 停止单个 device 的 runtime client watcher 并清理该 device 的 watcher 状态 |
| `disconnectDevice` | 断开指定 device |
| `reacquireLegacyOwnership` | 让 daemon 重新声明旧 `LatestDriverProcess` owner |
| `shutdownDaemon` | 请求 daemon 主动停止，用于 replacement/yield |
| `startWSServer` | 在 daemon 内启动 WebSocket server |
| `startWatchAllClients` | 对当前所有设备启动 runtime client watcher |
| `sendMessageToWeb` | 广播消息到 WebSocket Driver frontend |
| `sendMessageToApp` | 从 control 或 WebSocket frontend 发送消息到 runtime |
| `sendCustomizedMessage` | 构造 Customized CDP/App 请求并等待回包 |
| `sendRawMessage` | 透传原始 request-response 消息到 `PhysicalConnector.sendRawMessage` |
| `sendMessage` | 透传 fire-and-forget 消息到 runtime |
| `closeClient` | 关闭指定 runtime client |

RPC 请求和响应都带 `kind`、`id`，请求可带 `meta.protocolVersion`、`clientVersion`、`capabilities`。`MultiplexerDaemonClient` 默认 RPC 超时是 5000ms；如果 RPC 参数里有正数 `timeout`，实际超时取 `max(rpcTimeout, timeout + 1000ms)`。

### 8.2 Event

`ControlEvent` 类型当前定义了：

```text
snapshot
legacy-ownership-changed
device-connected
device-disconnected
client-connected
client-disconnected
usb-client-message
ws-client-message
ws-web-message
websocket-app-client-connected
websocket-app-client-disconnected
websocket-web-client-connected
websocket-web-client-disconnected
```

每个 control 连接建立后，Host 会先向该 control id 发送一次 `snapshot`。当前 Host 实际广播的增量 event 覆盖 `legacy-ownership-changed`、device connected/disconnected、USB runtime client connected/disconnected 和 `usb-client-message`。`DebugRouterConnector.applyHostEvent()` 对 WebSocket client 事件也有兼容分支，但 daemon 内 `WebSocketController` 调用的是可选 `WebSocketControllerHost.emit`，而 `MultiplexerHost` 当前没有实现这个 `emit` 方法，所以 WebSocket app/web client 连接事件只在 daemon 内用于 active Driver frontend 计数，不会同步成 connector 侧 WebSocket client 镜像。

`DebugRouterConnector.applyHostEvent()` 会把实际收到的 event 同步到本地镜像，并继续按旧事件名对外 `emit`，例如 `device-connected`、`client-connected`、`app-client-connected`、`usb-client-message`。

## 9. connector 侧镜像对象

`MultiplexerDevice` 是 connector 进程内的设备代理对象。它保存 daemon snapshot，并通过 RPC 操作 daemon 内真实 device：

- `startWatchClient()` -> `startWatchClient`
- `stopWatchClient()` -> `stopWatchClient`
- `disConnect()` -> `disconnectDevice`
- `getHost()` 默认返回 snapshot host，缺省时返回 `127.0.0.1`

`MultiplexerUsbClient` 是 connector 进程内的 runtime client 代理对象。它保留原 `Client` 接口习惯：

- `clientId()`
- `deviceId()`
- `close()`
- `sendCustomizedMessage()`
- `sendRawMessage()`
- `sendMessage()`
- `sendClientMessage()`
- `on()` / `once()` / `off()` / `onAllEvents()`

其中发送类方法都会转成 daemon RPC。`handleMessage()` 只处理来自 daemon 的 `usb-client-message` event：CDP/App notification 会按 method 触发本地事件，request-response 回包由 daemon 侧 route 表处理。

本地镜像同步规则：

1. 收到 `snapshot` 时，以 snapshot 为准同步 device/client Map，并移除 snapshot 中不存在的本地对象。
2. 收到 `device-connected`、`client-connected` 时 upsert 本地对象。
3. 收到断开 event 时删除本地对象并发出兼容事件。
4. daemon control socket 断开时清空 device、USB client 和已缓存的 WebSocket client 镜像，并调度 desired-state 恢复。

## 10. WebSocket frontend 路径

`WebSocketController` 已从具体 `DebugRouterConnector` 类解耦，依赖结构化 `WebSocketControllerHost`。在 Multiplexer 当前实现里，这个 host 是 daemon 内的 `MultiplexerHost`。

`startWSServer` RPC 在 daemon 内执行：

1. 根据 `websocketOption.port` 或默认 `19783` 选择端口，使用 `detect-port` 避免冲突。
2. 使用 `ip.address()` 生成 host，返回 `WebSocketServerInfo`。
3. 创建 `WebSocketController`，监听 `/mdevices/page/android`。

WebSocket client 握手流程：

1. server 分配 client id，发送 `Initialize`。
2. client 回 `Register`，携带 type 和 info。
3. type 为 `Driver` 的连接放入 `webClients`，代表 HDT 这类 Web frontend。
4. 其他 type 放入 `websocketAppClients`，代表 WiFi app client。
5. Host 收到连接/断开通知后维护 `activeWebSocketDriverIds`，用于 idle 判断；这些连接事件当前不广播给 connector control clients。

消息路径：

- Driver frontend 发 `Customized` 到 USB runtime：`WebSocketClient` 取出目标 `client_id`，调用 `WebSocketController.sendMessageToApp(id, message, fromWebClientId)`，再进入 `MultiplexerHost.handleWebSocketMessage()` 和 `PhysicalConnector.usbClients`。
- WebSocket app client 发消息到 frontend：`WebSocketClient` 调用 `handleWebSocketAppMessage()`，当前 Host 把它交给 `handlePhysicalMessage(appClientId, message)` 复用入站路由/广播逻辑。
- `ClientList` 由 Driver frontend 触发，返回当前 WebSocket app clients 和 USB runtime clients；USB runtime client 会带 `network: "USB"`，WebSocket app client 会带 `network: "WiFi"`。

`sendMessageToWebClient(webClientId, message)` 用于把命中的 request-response 回包只发回原始 Driver frontend；`sendMessageToWeb(message)` 用于 SDK 主动事件广播。

当前实现边界：

- `WebSocketController` 仍保留“未带 `fromWebClientId` 时直接发给 `websocketAppClients`”的兼容分支。
- 在 daemon 当前路径中，Driver frontend 发起的 `Customized` 会带 `fromWebClientId`，因此进入 Host 统一路由。
- Host 当前的出站路由目标是 `PhysicalConnector.usbClients`，所以本地实现已闭环的是 Driver frontend 到 USB runtime 的 request-response 隔离。
- WebSocket app client 会出现在 `ClientList` 中，但其连接事件和独立 request-response 路由没有同步成 connector control client 的事实来源；WiFi runtime 的完整双向路由不属于当前已闭环能力。

## 11. Message ID 重写与路由

不同 frontend 可能同时发送相同 CDP/App id，例如都发送：

```json
{ "id": 1, "method": "Runtime.enable" }
```

SDK response 只会带 message id，不会带 control id 或 WebSocket client id。因此 Host 在消息发往 runtime 前必须把原始 id 改写成全局唯一 id，并记录回包目标。

`PendingRouteTable` 当前 route 结构：

```ts
type PendingControlRoute = {
  kind: "control";
  globalMessageId: number;
  controlId: number;
  originalId: number;
  clientId: number;
  createdAt: number;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
};

type PendingWebSocketRoute = {
  kind: "websocket";
  globalMessageId: number;
  webClientId: number;
  originalId: number;
  clientId: number;
  createdAt: number;
};
```

route 默认超时 10000ms。control route 超时时会 reject 对应 Promise；WebSocket route 超时只删除映射。

出站处理：

1. Host 解析外层 JSON。
2. 忽略 `UsbConnect` 和 `UsbConnectAck`。
3. 如果 `data.data.client_id` 为非 0/truthy 值，发往 runtime 前统一改成 `-1`。
4. 从 `data.data.message` 中识别 Customized payload，兼容 message 是字符串或对象两种形态。
5. 只有 payload 中存在安全整数 `id` 时才建立 pending route。
6. Host 分配 `globalMessageId`，把原始 id 改成全局 id，写入 `PendingRouteTable`。
7. 调用真实 `UsbClient.sendMessage()` 发给 SDK runtime。

入站处理：

1. Host 收到 runtime 消息后解析 Customized payload。
2. 如果 payload 中有安全整数 id，先按全局 id 从 `PendingRouteTable` 中 `take()` route。
3. 命中 route 时，把 id 改回 frontend 原始 id，并把 sender/client_id 改回真实 runtime client id。
4. control route 如果带 `resolve`，说明来自 `sendCustomizedMessage()`，直接 resolve 被提取出的 Customized 内层 message；否则通过 `usb-client-message` event 发回指定 control。
5. WebSocket route 通过 `sendMessageToWebClient(webClientId, message)` 只发回原始 Driver frontend。
6. 如果消息带 response id 但没有命中 route，直接丢弃，避免回包泄漏给其他 frontend。
7. 如果消息没有 response id，视为 SDK 主动事件：改写 runtime client id 后，同时广播给 WebSocket Driver frontend 和 control clients。

route 清理：

- control socket 断开时，`clearByControlId(controlId)` 并 reject control route。
- WebSocket frontend 断开时，`clearByWebClientId(webClientId)`。
- Host physical discovery reset 或 legacy owner 丢失时，清空全部 route。

## 12. 旧多开 owner 兼容

Multiplexer 当前不再让每个 connector 进程竞争旧 `LatestDriverProcess`。旧 owner 文件只由 daemon 侧 `LegacyOwnershipGuard` 维护，用来兼容仍依赖旧多开 owner 的物理连接逻辑。

`LegacyOwnershipGuard.start()` 当前行为：

1. 如果 `DriverCloseMultiOpen=true`，直接进入 attached 状态，并发出 `daemon-started` 变更。
2. 否则创建 legacy driver dir，删除旧 `lockfile` 目录。
3. 写入 `LatestDriverProcess` 为 daemon pid。
4. 每 500ms 检查 owner 文件。

监控逻辑：

- owner pid 是当前 daemon：保持 attached。
- owner 文件缺失或非法：重新写当前 daemon pid。
- owner pid 不存活：重新写当前 daemon pid。
- owner pid 是另一个存活进程：daemon 进入 unattached，Host 调用 `handleLegacyOwnershipLost()`。

Host 丢失 legacy owner 后会：

1. 标记 `legacyOwnershipAttached = false`。
2. reject 并清空所有 pending route。
3. 停止当前物理发现状态，清空 devices 和 usbClients。
4. 如果允许重建 `PhysicalConnector`，关闭旧物理连接并创建新的 `PhysicalConnector`。
5. 发布空 snapshot，并刷新 WebSocket `ClientList` / `DeviceList`。
6. 广播 `legacy-ownership-changed`，connector facade 转成 `MultiOpenStatus.unattached` 回调。

connector 后续在 `connectDevices()`、`startWatchAllClients()` 或 desired-state 恢复前会调用 `reacquireLegacyOwnership`，让 daemon 重新声明 owner。这里不是回到旧 connector 实现，而是让 daemon 重新获得旧物理层需要的 owner 文件。

## 13. 容灾、恢复和退出

### 13.1 daemon 崩溃或 control socket 断开

daemon 崩溃后，connector 的 control socket 会关闭。`MultiplexerDaemonClient.closeSocket()` 会 reject pending RPC，并通知连接状态 listener。`DebugRouterConnector` 收到 disconnected 后清空本地镜像，然后调度 desired-state 恢复。

恢复过程：

1. `daemonClient.connect()` 重新 ensure daemon。
2. 如果之前已经请求过设备发现，重新 `connectDevices(-1, null, isAutoListenClients)`。
3. 如果之前请求过 `startWatchAllClients()`，重新启动全量 runtime watcher。
4. 如果之前启动过 WebSocket server，重新 `startWSServer()`。

状态恢复以 daemon snapshot 作为最终收敛点。无论中间丢失了哪些增量事件，重连后的全量 snapshot 都会覆盖 connector 本地镜像。

| 状态 | 所有者 | 恢复方式 |
|---|---|---|
| 真实设备连接 | daemon 内 `PhysicalConnector` | daemon 重新扫描并广播 snapshot。 |
| 本地 `devices` / `usbClients` 镜像 | connector facade | 由 snapshot 覆盖重建。 |
| connector pending RPC | connector 内 `MultiplexerDaemonClient` | control socket 断开时 reject，由调用方按原逻辑重试。 |
| pending route | daemon 内 `PendingRouteTable` | request 生命周期内创建；control/WebSocket 断开、Host reset 或超时后清理。 |
| WebSocket frontend 连接 | daemon 内 `WebSocketController` | WebSocket 连接断开后由前端重连；Driver 连接数只用于 daemon idle 判断。 |

### 13.2 daemon 空闲自动关闭

公开 facade 默认传入：

```text
multiplexerDaemonIdleTimeout = 600000ms
```

Host 的 idle 判断只看两类上层消费者：

1. control WebSocket 连接，也就是 connector API 用户。
2. type 为 `Driver` 的 WebSocket frontend。

当两类连接都为 0 时，Host 启动 idle timer。timer 到期后调用 daemon 的 idle handler，daemon 执行 `stop()` 并让 entry 进程退出。idle 期间如果有新的 control 或 Driver frontend 连接进入，timer 会被取消。

`multiplexerDaemonIdleTimeout` 为负数、非有限数字或在嵌入场景未设置时，Host 不启用 idle 自动关闭。

### 13.3 daemon replacement/yield

当 connector 发现 daemon 协议过旧或 daemon 不健康需要替换时，Manager 会优先通过 `shutdownDaemon` RPC 请求 daemon 主动停止。Host 收到后调用 shutdown handler，daemon 走 `stop()` 清理 heartbeat、discovery、lock、control server、WebSocket server 和 physical connector。只有 daemon 未按时退出时，Manager 才会尝试 SIGTERM/SIGKILL。

### 13.4 未知 response id

Host 收到带有效 response id、但 route 表中没有匹配项的 runtime 回包时，直接丢弃，不广播。这是为了避免某个前端的 request-response 回包泄漏给其他前端。

## 14. 配置与兼容性

公开 `DebugRouterConnectorOption` 当前新增或使用的 Multiplexer option：

| Option | 作用 |
|---|---|
| `multiplexerDaemonIdleTimeout` | daemon 空闲退出超时，facade 默认 600000ms |
| `multiplexerStartupTimeout` | 等待 daemon ready 的超时时间，默认 5000ms |
| `multiplexerStaleTimeout` | discovery heartbeat 判 stale 的超时时间，facade 默认 5000ms |
| `multiplexerRpcTimeout` | control RPC 默认超时，默认 5000ms |
| `multiplexerRootDir` | Multiplexer 根目录，默认 `~/.DebugRouterConnector` |
| `multiplexerDataDir` | Multiplexer 数据目录，优先级高于 root dir |
| `multiplexerDaemonEntry` | daemon entry js 路径，测试或特殊打包场景使用 |
| `multiplexerLegacyDriverDir` | 旧 `LatestDriverProcess` 所在目录 |
| `websocketOption.port` | daemon WebSocket server 期望端口，默认 19783 |
| `websocketOption.roomId` | WebSocket `RoomJoined` 返回的 room id |

原有 physical option 会传给 daemon 内的 `PhysicalConnector`，包括 `manualConnect`、`enableWebSocket`、`enableAndroid`、`enableIOS`、`enableHarmony`、`enableDesktop`、`enableNetworkDevice`、`adbHostPort`、`hdcHostPort`、`usbConnectOpt`、`networkDeviceOpt`。`reportService` 不传给 daemon 内 physical connector，facade 侧仍负责 report service 初始化。

当前公开 facade 不再把 `enableMultiplexer`、`enableProxy`、`proxyDaemonIdleTimeout`、`DEBUG_ROUTER_PROXY*` 作为兼容入口。接入方应使用 `multiplexer*` 命名。

协议兼容规则：

1. `daemon.protocolVersion === connector.protocolVersion`：直接复用。
2. `daemon.protocolVersion > connector.protocolVersion` 且 `connector.protocolVersion >= daemon.minSupportedProtocolVersion`：复用高版本 daemon，旧 connector 只调用自身已知 RPC 和事件。
3. `connector.protocolVersion < daemon.minSupportedProtocolVersion`：connector 拒绝接入并提示升级，不清理新版 daemon。
4. `daemon.protocolVersion < connector.protocolVersion`：connector 认为 daemon 过旧，走 replacement 流程。

## 15. 典型流程

### 15.1 第一个 connector 启动

1. facade 创建 discovery、manager 和 daemon client。
2. `connectDevices()` 触发 `daemonClient.connect()`。
3. manager 发现没有可用 daemon，抢 `spawn.lock`。
4. manager spawn detached daemon entry。
5. daemon 抢 `daemon.lock`，启动 Host/control server，写入 `daemon.json`。
6. connector 连上 control WebSocket，收到初始 `snapshot`。
7. facade 通过 `connectDevices` RPC 让 Host 启动物理设备发现。

### 15.2 后续 connector 启动

1. facade 读取已有 `daemon.json`。
2. discovery fresh 且 health ok，直接连接已有 control server。
3. 新 control 连接收到当前 snapshot。
4. 后续设备、runtime client 和 SDK 消息事件由 daemon 广播给所有 control clients；WebSocket frontend 连接状态当前保留在 daemon 内部。

### 15.3 HDT 请求 runtime

1. facade 调用 `startWSServer()`，daemon 启动 WebSocket server。
2. HDT 作为 type `Driver` 注册，进入 `webClients`。
3. HDT 发送 `Customized`，携带目标 runtime `client_id`。
4. Host 为 CDP/App id 分配全局 id，记录 `webClientId + originalId + clientId`。
5. runtime 回包后，Host 命中 route，恢复原始 id 和 runtime client id。
6. Host 只把回包发给原 HDT web client。

### 15.4 SDK 主动事件

1. runtime 发出无 request id 的 CDP/App notification。
2. Host 识别为主动事件，改写 runtime client id。
3. 如果 WebSocket 已启用，Host 广播给所有 Driver frontend。
4. Host 同时通过 `usb-client-message` event 广播给所有 control clients。
5. 每个 connector facade 将事件分发到对应 `MultiplexerUsbClient` 的本地事件系统。
