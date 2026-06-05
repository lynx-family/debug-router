# DebugRouter Multiplexer 技术方案

## 1\. 背景

`debug\_router` SDK 侧当前只能同时维持一个 DevTool 前端连接。如果多个前端进程同时启动，例如 HDT、Lynx DevTool MCP、VSCode 插件等，它们都通过 `debug\_router\_connector` 直接连接 SDK 侧 DevTool，就会发生连接抢占，表现为后启动的前端抢走 SDK 侧连接，旧前端被断开并弹出提示。这类冲突的根因不是端口本身，而是 SDK 侧 DebugRouter 的连接模型是单前端独占。SDK 侧 native 代码里只保存一个当前 transceiver 或 USB client，新连接会替换旧连接。因此，如果直接把多个前端都接到 SDK，冲突无法在前端工具之间自然消失。本方案在 `debug\_router\_connector` 内引入 DebugRouter Multiplexer，把多前端并发问题收敛到 connector 内部解决。

## 2\. 目标

1. SDK 侧仍然只看到一个 DevTool 前端连接，不改 SDK 侧独占模型。

2. 多个 DevTool 前端可以同时启动，并通过同一个稳定入口访问同一个 SDK runtime。

3. 对 HDT、DevTool MCP、VSCode 插件等接入方尽量透明，升级 `debug\_router\_connector` 即可获得能力。

4. 支持 CDP/App request\-response 的 message id 隔离，避免多个前端同时使用相同 id 时串包。

5. 保留旧逻辑回退能力，必要时可以关闭 Multiplexer。

## 3\. 非目标

6. 不修改 SDK native 侧以支持多个物理 frontend client。

7. 不改变 HDT 与 connector 之间既有 WebSocket 协议。

## 4\. 整体架构

### 4\.1 部署视图

|不支持的场景|主要支持场景|
|---|---|
|- 一个手机客户端不支持同时连多个PC<br>- 手机客户端上的后台应用不支持被调试，被调试后行为不确定|- 一台PC可以同时调试多个客户端上的多个应用<br>- 一个卡片可以支持同时连接多个HDT类的应用|

### 4\.2 逻辑视图

`debug\_router\_connector` 进程不再自己持有物理 SDK 连接，而是负责发现、拉起并连接本地 detached Multiplexer daemon。Multiplexer daemon 内部运行 Multiplexer Host，负责真实设备发现、USB client 连接、SDK 消息收发和消息路由。所有前端进程里的 connector 都是 daemon client。对接入方来说，它仍然表现为一个正常的 `DebugRouterConnector` 实例。

## 5\. 单例选主与发现机制

实现文件：

- `debug\_router\_connector/src/multiplexer/discovery\.ts`

- `debug\_router\_connector/src/connector/DebugRouterConnector\.ts`本地状态目录为：其中：

```Plain Text
spawn.lock
daemon.lock
daemon.json







```

`spawn\.lock` 由 connector 进程抢占，用来决定谁负责拉起 daemon。它只在 daemon 启动窗口内短暂存在，daemon ready 或启动超时后释放。`daemon\.lock` 由 daemon 进程持有，用来表示当前 daemon 存活。daemon 退出时释放该 lock。`daemon\.json` 内容包含：

```TypeScript
type MultiplexerDiscoveryInfo = {
  pid: number;
  protocolVersion: number;
  controlPort: number;
  token: string;
  heartbeat: number;
};







```

daemon 启动 control server 后写入 `daemon\.json`，并每秒刷新 `heartbeat`。写入时使用临时文件加 `renameSync`，避免 connector 读到半截 JSON。如果进程发现 `daemon\.lock` 存在，但 `daemon\.json` 不存在、不匹配协议版本，或 heartbeat 超过 `MULTIPLEXER\_STALE\_TIMEOUT`，并且 lock 本身也足够旧，则认为 daemon 已崩溃，可以清理 stale lock。任意 connector 都可以重新抢 `spawn\.lock` 并拉起新的 daemon。默认启用 Multiplexer：

```TypeScript
const multiplexerEnabled =
  option.enableMultiplexer ?? option.enableProxy ?? isMultiplexerEnabled();







```

回退方式：

```TypeScript
new DebugRouterConnector({ enableMultiplexer: false })







```

或：

```Bash
DEBUG_ROUTER_MULTIPLEXER=false







```

关闭 Multiplexer 后会恢复旧的 `LatestDriverProcess` 多开抢占逻辑。

## 6\. Multiplexer Host

实现文件：

- `debug\_router\_connector/src/multiplexer/MultiplexerHost\.ts`Host 做三类事情：

8. 对下连接真实 SDK runtime。

9. 对上提供 control WebSocket 给 connector client。

10. 负责 request\-response 路由、事件广播和 message id 重写。

```Plain Text
http://127.0.0.1:<controlPort>/health?token=<token>
ws://127.0.0.1:<controlPort>/debug-router-multiplexer/control?token=<token>







```

`token` 存在 `daemon\.json` 中，用于避免本机其他无关进程误连 control server。Host 暴露的 control RPC 包括：

```Plain Text
connectDevices
getDevices
connectUsbClients
startWSServer
startWatchAllClients
sendMessageToWeb
sendMessageToApp
sendCustomizedMessage
sendRawMessage
sendMessage
closeClient







```

这些 RPC 的语义与原 `DebugRouterConnector` 或 `UsbClient` 方法保持一致。connector client 调用这些 API 时，实际会通过 control WebSocket 转发给 Host 执行。

## 7\. Multiplexer Client

实现文件：

- `debug\_router\_connector/src/multiplexer/``MultiplexerRemoteClient``\.ts`

- `debug\_router\_connector/src/multiplexer/MultiplexerDevice\.ts`

- `debug\_router\_connector/src/multiplexer/MultiplexerUsbClient\.ts`connector client 启动时读取 `daemon\.json`，连接 Host control WebSocket。如果 discovery 不存在或不新鲜，则每 500ms 重试，并触发 daemon ensure 流程。连接成功后，Host 会推送一次 `snapshot`，其中包含当前 device 列表和设备侧 runtime client（原代码中叫 usb client）列表。connector client 使用 `MultiplexerDevice` 和 `MultiplexerUsbClient` 在本进程内构建镜像对象，并写入本地 `driver\.devices` 和 `driver\.usbClients`。之后 Host 会继续推送增量事件：

```Plain Text
snapshot
device-connected
device-disconnected
client-connected
client-disconnected
usb-client-message


```

connector client 收到这些增量事件后，只做两类本地同步：

11. 更新当前进程里的镜像对象，例如 `driver\.devices` 和 `driver\.usbClients`。

12. 按旧版 `DebugRouterConnector` 的事件名继续 `emit`，例如 `device\-connected`、`client\-connected`、`app\-client\-connected` 等。因此接入方原来基于 `connector\.on\(\.\.\.\)` 的事件订阅方式不需要改。需要强调的是，`MultiplexerDevice` 只是当前 connector 进程里的设备镜像/代理对象，不会真的启动 ADB/usbmux 监听，也不会真实扫描 runtime client。真实的 device watcher 和 runtime client watcher 只运行在 daemon 内部的 Host 进程里。所以 `MultiplexerDevice\.startWatchClient\(\)` 是空实现：

```TypeScript
startWatchClient() {
  // The multiplexer host owns the physical client watcher.
}


```

真实监听只由 Host 持有，普通 connector 只能通过 Host 推送的事件更新自己的本地镜像。`MultiplexerUsbClient` 保留原 `Client` 接口：

```TypeScript
sendCustomizedMessage(...)
sendRawMessage(...)
sendMessage(...)
sendClientMessage(...)
close()
on(...)
once(...)
off(...)


```

但这些调用都会通过 `MultiplexerRemoteClient` 发到 Host。

## 8\. WebSocket 前端身份传递

实现文件：

- `debug\_router\_connector/src/websocket/WebSocketConnection\.ts`

- `debug\_router\_connector/src/websocket/WebSocketServer\.ts`这一节讲的是一层前置 plumbing：把“这条消息来自哪个 WebSocket frontend”传到 Multiplexer Host。它不负责判断 SDK 回包属于哪个请求，也不负责改写 CDP/App message id。旧逻辑里，HDT 前端通过 WebSocket 发送 `Customized` 消息时，只携带目标 runtime client id，不携带“哪个 WebSocket 前端发起”这个信息。多个 HDT 同时连入时，Host 如果只知道目标 runtime client id，就只能广播回所有 WebSocket frontend，无法定向回原发起方。因此改动如下：

```TypeScript
this.server.sendMessageToApp(id, message, this.clientId());


```

`sendMessageToApp` 新增 `fromWebClientId` 参数：

```TypeScript
sendMessageToApp(id: number, message: string, fromWebClientId?: number)


```

同时 `WebSocketController` 增加：

```TypeScript
sendMessageToWebClient(id: number, message: string)


```

这样消息进入 Host 时，Host 可以把 `fromWebClientId` 记录到 pending target 里；等第 9 节的 message id 路由命中后，再通过 `sendMessageToWebClient\(webClientId, message\)` 只发回对应的 HDT 前端。所以第 8 节解决的是“回包最终发到哪个 WebSocket 连接”；第 9 节解决的是“SDK 回来的这条 response 属于哪个原始 request”。

## 9\. Message ID 重写与路由

实现文件：

- `debug\_router\_connector/src/multiplexer/MultiplexerHost\.ts`这一节讲的是 request\-response 的归属判定。它会用到第 8 节传进来的 `webClientId`，但解决的是另一个问题：不同前端都可能使用相同的 CDP/App message id，例如两个 HDT 同时发：

```JSON
{ "id": 1, "method": "Runtime.enable" }


```

如果直接透传到 SDK，SDK 回包时无法区分应该回给哪个前端。仅有 `webClientId` 还不够，因为 SDK response 里不会带 `webClientId`，通常只带 CDP/App message id。因此 Host 必须把每个前端请求里的原始 id 改写成全局唯一 id，并记录：

```Plain Text
globalMessageId -> 原始 id + 回包目标(controlId 或 webClientId)


```

Multiplexer 的处理方式：

13. 前端消息进入 Host。

14. Host 从 `Customized\.data\.data\.message` 中解析 CDP/App payload。

15. 如果 payload 中存在 `id`，Host 分配一个全局唯一 `globalMessageId`。

16. Host 将原始 id 改写为全局 id，并记录 pending 映射。

17. 消息发送给真实 SDK runtime。

18. SDK 回包后，Host 根据全局 id 查 pending。

19. Host 将 id 改回前端原始 id。

20. Host 只把回包发给原发起方。pending 映射分为两类：

```TypeScript
type PendingTarget =
  | {
      kind: "control";
      controlId: number;
      originalId: number;
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  | {
      kind: "websocket";
      webClientId: number;
      originalId: number;
    };


```

`control` 表示 connector client 通过 `MultiplexerUsbClient\.sendCustomizedMessage` 发起的请求。回包会 resolve 对应 RPC Promise。`websocket` 表示 HDT 这类 WebSocket frontend 发起的请求。回包会通过 `sendMessageToWebClient` 定向发回对应 `webClientId`。

### 9\.1 SDK 主动事件广播策略

Host 收到 SDK 侧消息后，会先尝试从 CDP/App payload 中提取 request id。这里用是否存在有效 id 来区分 response 和 event：

- 有 id：按 request\-response 处理，通过 pending 映射找到原始发起方，只定向回对应 frontend。

- 无 id：按 SDK 主动事件或 notification 处理，因为它不属于某一个 frontend 的请求，所以广播给所有当前在线的上层消费者。无 id 事件的广播路径有两条，它们服务的是两类不同入口，不是同一个对象的重复发送：

21. `driver\.wss?\.sendMessageToWeb\(routedMessage\)`：广播给原有 WebSocket 前端入口，也就是 HDT 这类直接接入 WebSocket server 的 frontend。

22. `MultiplexerHost\.broadcast\(\{ event: \&\#34;usb\-client\-message\&\#34;, \.\.\. \}\)`：广播给连接 daemon control WebSocket 的 connector client，让 `MultiplexerUsbClient` 镜像对象也能收到 SDK 主动事件。也就是说：WebSocket frontend 走原 WebSocket 广播路径；通过 connector API 拿到 `MultiplexerUsbClient` 的接入方走 control event 路径。

## 10\. 典型调用流程

### 10\.1 第一个前端启动

第一个 connector 只负责拉起 daemon，然后作为 daemon client 连接 control WebSocket。真实 SDK 连接由 daemon 持有。

### 10\.2 后续前端启动

后续 connector 不再拉起新 daemon，直接复用已有 daemon。

### 10\.3 HDT 请求 SDK

## 11\. 与旧多开抢占逻辑的关系

Multiplexer 开启时，不再启动旧的 `LatestDriverProcess` 抢占监控。原因是 Multiplexer 本身就是为了解决多进程共存，如果继续启用旧监控，后启动进程仍会触发抢占。Multiplexer 关闭时，旧逻辑保持不变：

```TypeScript
if (!multiplexerEnabled) {
  this.prepareDriverDataDir();
  this.startMonitorMultiOpen();
}







```

这保证了兼容性和回退能力。

## 12\. 内部仓库接入

内部仓库：

```Plain Text
/Users/zhengyuwei/Project/internal_debug_router/DebugRouter



```

修改文件：

```Plain Text
driver/src/driver/DebugRouterDriver.ts



```

新增并优先透传 Multiplexer 新命名：

```TypeScript
super({
  enableMultiplexer: option.enableMultiplexer,
  multiplexerDaemonIdleTimeout: option.multiplexerDaemonIdleTimeout,
  ...
});



```

同时保留旧字段作为 deprecated alias，便于灰度期间兼容已有接入：

```TypeScript
enableProxy?: boolean;                 // deprecated alias of enableMultiplexer
proxyDaemonIdleTimeout?: number;       // deprecated alias of multiplexerDaemonIdleTimeout



```

内部包不承载 Multiplexer 核心逻辑。后续发布时需要更新内部包对 `@lynx\-js/debug\-router\-connector` 的依赖版本。注意：当前内部依赖如果仍是 `^0\.0\.9`，由于 semver 对 `0\.0\.x` 的处理不会自动吃到 `0\.0\.10`，需要显式升级到包含 Multiplexer 的版本。

## 13\. 兼容性

默认行为：

```Plain Text
Multiplexer enabled



```

新命名关闭方式：

```TypeScript
new DebugRouterConnector({
  enableMultiplexer: false,
});



```

或：

```Bash
DEBUG_ROUTER_MULTIPLEXER=false



```

旧命名保留为 deprecated alias，便于灰度期间平滑升级：

```TypeScript
new DebugRouterConnector({
  enableProxy: false,
  proxyDaemonIdleTimeout: 300000,
});



```

```Bash
DEBUG_ROUTER_PROXY=false
DEBUG_ROUTER_PROXY_DAEMON_IDLE_TIMEOUT=300000



```

新接入建议统一使用 `Multiplexer` 命名；旧 `Proxy` 命名只作为兼容入口保留。对 HDT、DevTool MCP、VSCode 插件而言，理论上只需要升级 `debug\_router\_connector` 版本，不需要理解 Multiplexer 内部协议。

## 14\. 容灾与恢复

### daemon 崩溃

daemon 崩溃后 heartbeat 不再刷新。已有 connector 的 control WebSocket 会断开，并继续尝试重新发现 daemon。heartbeat 超时后，任意 connector 都可以抢 `spawn\.lock`，重新拉起 daemon。已有 connector client 的 control WebSocket 断开后，会：

23. 清空当前 socket。

24. reject 未完成的 pending RPC。

25. 重置 ready promise。

26. 触发 daemon ensure 流程，必要时抢 `spawn\.lock` 拉起新 daemon。

27. 每 500ms 重新读取 discovery 并连接新的 daemon。

### control RPC 超时

RPC 请求默认 10 秒超时。超时后删除 pending 并 reject Promise。

### Host 收到未知 id 回包

未知 id 回包不广播，直接消费掉。这样做是为了避免某个前端的 request\-response 回包泄漏给其他前端。

