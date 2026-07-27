# DebugRouter Multiplexer Technical Design

## 1. Background

The `debug_router` SDK still uses an exclusive single-frontend connection model: the native side keeps only one current transceiver or USB client, and a new connection replaces the previous one. When multiple DevTool frontend processes start at the same time, such as Lynx DevTool MCP and VSCode extensions, they all connect to the SDK-side DevTool through `debug_router_connector`. The later frontend then takes over the SDK connection and disconnects the existing frontend.

The current Multiplexer implementation moves this multi-frontend concurrency problem into `debug_router_connector`: the local machine keeps one detached daemon that owns the real device and SDK runtime connections, and all connector processes and WebSocket frontends share the same physical channel through that daemon.

## 2. Terms, Usage, and Goals

### 2.1 Reading Guide

This document helps readers quickly understand the code structure and call flow. Recommended reading order:

1. `4. Overall Architecture`: understand the boundary between connector processes, daemon, WebSocket frontends, and SDK runtime.
2. `5. Public DebugRouterConnector Facade` and `6. Daemon Discovery, Startup, and Replacement`: understand how normal callers automatically reuse the daemon.
3. `10. WebSocket Frontend Path` and `11. Message ID Rewriting, Routing, and Notification Query Memoization`: understand source isolation, targeted responses, and coalescing for concurrent frontends.
4. `12. Legacy Multi-open Owner Compatibility` and `13. Fault Recovery and Shutdown`: understand `LatestDriverProcess` compatibility, daemon crashes, and idle shutdown.

The most important implementation boundary is: the public `DebugRouterConnector` is now a Multiplexer facade; real physical and WebSocket connections live inside the daemon; the connector side holds device, USB runtime, WiFi runtime, and WebSocket frontend mirrors for the resources requested by that facade.

### 2.2 Terms

| Name                        | Meaning                                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| debug_router SDK            | The SDK-side DebugRouter component. It receives debugging messages from frontends and returns SDK runtime events and responses.                                                                                                                |
| debug_router_connector      | The PC-side DebugRouter connection library. It discovers devices, connects to SDK runtimes, and provides a WebSocket debugging entry for Lynx DevTool/browser DevTool pages.                                                                   |
| DebugRouter Multiplexer     | A local multiplexing mechanism inside the connector. A daemon owns the real device and SDK connections, isolates messages, rewrites IDs, and routes responses for multiple frontends.                                                          |
| Multiplexer daemon          | A local detached shared process. It owns real physical connections, the control server, the WebSocket server, snapshot/event broadcast, and routing.                                                                                           |
| memoized notification query | An ID-less `Customized` query whose runtime reply is an SDK-initiated notification. The daemon can coalesce duplicate queries and briefly reuse the latest notification for the same runtime client.                                           |
| control client              | A daemon client created when a normal connector process connects to the daemon through the control WebSocket.                                                                                                                                  |
| WebSocket Driver frontend   | A WebSocket frontend page whose type is `Driver`.                                                                                                                                                                                              |
| runtime client              | A debugging target for an SDK runtime, including USB runtime clients and WiFi runtimes connected as WebSocket app clients. The daemon tracks both types and synchronizes WiFi runtime mirrors to facades that requested the WebSocket service. |

### 2.3 Caller Usage

For Lynx DevTool MCP, VSCode extensions, and similar callers, Multiplexer is an internal capability of `debug_router_connector`. Callers continue to create and use `DebugRouterConnector` in the original way:

```ts
const connector = new DebugRouterConnector(options);
```

The original device discovery, runtime client connection, message sending, and event subscription APIs remain compatible:

```ts
connector.on("device-connected", (device) => {
  // Reuse the existing handling logic.
});

connector.on("client-connected", (client) => {
  // Reuse the existing handling logic.
});

const devices = await connector.connectDevices();
const clients = await connector.connectUsbClients(deviceId);
```

A normal connector process no longer owns a real SDK connection. Instead, it automatically discovers or starts the local Multiplexer daemon and accesses real devices and runtimes through that daemon. Callers only need to upgrade to a `debug_router_connector` version that includes Multiplexer and continue using the existing `DebugRouterConnector` API.

### 2.4 Goals

1. The SDK side still sees only one real DevTool frontend connection. No SDK native multi-frontend support is required.
2. Multiple `DebugRouterConnector` instances, Lynx DevTool pages, and other upper-layer tools can coexist and reuse the same local daemon.
3. The public `DebugRouterConnector` API should keep the existing usage shape as much as possible: device and runtime clients are exposed through local mirror objects and events, while the WebSocket server keeps the original path and compatibility fields.
4. CDP/App request-response message IDs are isolated so concurrent frontends using the same ID do not receive each other's responses.
5. Repeated ID-less state queries are coalesced without changing the SDK notification format or suppressing the original notification broadcast.
6. The implementation has recovery paths for daemon crashes, protocol upgrades, idle shutdown, and legacy multi-open owner preemption.

### 2.5 Non-goals

1. Do not modify the SDK native single-connection model.

### 2.6 Tradeoffs

Another possible solution is to add multi-frontend connection and message fanout support directly on the SDK side. The current implementation chooses a connector-side Multiplexer because the change boundary is more controlled, caller upgrade cost is lower, and rollout or rollback is easier. The tradeoff is that the local message path adds one connector-to-daemon hop and the daemon discovery, lifecycle, and troubleshooting path must be maintained.

| Solution                        | Advantages                                                                                          | Disadvantages                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector-side Multiplexer      | No SDK native change; callers only upgrade the connector; rollout and rollback are more controlled. | Adds one local forwarding hop; daemon lifecycle and debugging add another layer.                                                                         |
| SDK-side multi-frontend support | Shorter path and a more direct connection model.                                                    | Larger native change surface; depends on business SDK releases; rollback is harder; the SDK side still needs fanout, lifecycle, and compatibility logic. |

## 3. Current Code Boundary

Public facade:

- `debug_router_connector/src/connector/DebugRouterConnector.ts`
- `debug_router_connector/src/connector/index.ts`
- `debug_router_connector/src/index.ts`

Connector-side daemon client and mirror objects:

- `debug_router_connector/src/multiplexer/client/MultiplexerDaemonClient.ts`
- `debug_router_connector/src/multiplexer/client/MultiplexerDaemonManager.ts`
- `debug_router_connector/src/multiplexer/client/MultiplexerDiscovery.ts`
- `debug_router_connector/src/multiplexer/client/MultiplexerDevice.ts`
- `debug_router_connector/src/multiplexer/client/MultiplexerUsbClient.ts`
- `debug_router_connector/src/multiplexer/client/MultiplexerWebSocketClient.ts`

Daemon side:

- `debug_router_connector/src/multiplexer/daemon/entry.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerDaemon.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerHost.ts`
- `debug_router_connector/src/multiplexer/daemon/MemoizedNotificationQueryTable.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerControlServer.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerControlConnection.ts`
- `debug_router_connector/src/multiplexer/daemon/PendingRouteTable.ts`
- `debug_router_connector/src/multiplexer/daemon/LegacyOwnershipGuard.ts`

Protocol and utilities:

- `debug_router_connector/src/multiplexer/protocol/control.ts`
- `debug_router_connector/src/multiplexer/protocol/discovery.ts`
- `debug_router_connector/src/multiplexer/protocol/event.ts`
- `debug_router_connector/src/multiplexer/protocol/snapshot.ts`
- `debug_router_connector/src/multiplexer/protocol/validation.ts`
- `debug_router_connector/src/multiplexer/utils/paths.ts`
- `debug_router_connector/src/multiplexer/utils/FileLock.ts`
- `debug_router_connector/src/multiplexer/utils/atomic_file.ts`

WebSocket and physical layer:

- `debug_router_connector/src/websocket/WebSocketServer.ts`
- `debug_router_connector/src/websocket/WebSocketConnection.ts`
- `debug_router_connector/src/physical/PhysicalConnector.ts`

The current `src/connector` directory only exports the new `DebugRouterConnector` facade. There is no public `LegacyDebugRouterConnector` implementation.

## 4. Overall Architecture

### 4.1 Process View

```text
Caller process
  DebugRouterConnector
    MultiplexerDaemonClient
      ws://127.0.0.1:<controlPort>/debug-router-multiplexer/control
        Multiplexer daemon
          MultiplexerHost
            PhysicalConnector
              SDK runtime / device

WebSocket frontends
  ws://<host>:<wssPort>/mdevices/page/android
    daemon-side WebSocketController
      MultiplexerHost
        USB SDK runtime / WiFi SDK runtime / device
```

Connector processes no longer directly own real device watchers or SDK runtime/WebSocket connections. USB physical connections exist only in daemon-side `MultiplexerHost -> PhysicalConnector`, while daemon-side `WebSocketController` owns WiFi runtime and Driver frontend connections. Connector processes maintain local `MultiplexerDevice`, `MultiplexerUsbClient`, and `MultiplexerWebSocketClient` mirrors; WebSocket mirrors and events are exposed only to control clients that called `startWSServer()`.

### 4.2 Local State Directory

Default directory:

```text
~/.DebugRouterConnector/multiplexer/
  spawn.lock
  daemon.lock
  daemon.json
```

`multiplexerRootDir` or `multiplexerDataDir` can override the path, mainly for tests, isolated runs, or special packaging scenarios.

`daemon.json` is defined by `MultiplexerDiscoveryInfo`:

```ts
type MultiplexerDebugInfo = {
  protocolVersion?: number;
  clientVersion?: string;
  daemonVersion?: string;
  processId?: number;
  timestamp?: number;
};

type MultiplexerDiscoveryInfo = {
  pid: number;
  protocolVersion: number;
  minSupportedProtocolVersion?: number;
  controlPort: number;
  heartbeat: number;
  startedAt?: number;
  debugInfo?: MultiplexerDebugInfo;
};
```

`spawn.lock` serializes daemon startup and is only held during the connector's daemon ensure window. `daemon.lock` is held by the daemon process and marks the current daemon owner. `daemon.json` is written after the daemon starts the control server and is refreshed on each heartbeat. Writes use `writeJsonAtomic()` so other processes do not read partial JSON.

## 5. Public `DebugRouterConnector` Facade

The `DebugRouterConnector` constructor creates:

1. `MultiplexerDiscovery`, which reads and validates `daemon.json`.
2. `MultiplexerDaemonManager`, which handles ensure, spawn, replacement, health checks, and stale cleanup.
3. `MultiplexerDaemonClient`, which connects to the daemon control WebSocket, sends RPCs, and receives events.
4. Local `DriverClient` and device, USB runtime, WiFi runtime, and WebSocket frontend mirror Maps. Connection trace is not created or owned by the facade.

If `manualConnect` is false, the constructor automatically calls `connectDevices()`. The Host reacquires the legacy `LatestDriverProcess` ownership inside `connectDevices()` and `startAllDeviceClientWatchers()`, so desired-state recovery restores ownership and physical watchers with one control RPC.

Current public facade behavior:

- `connectDevices()` sends a control RPC to let the daemon start physical device discovery, then upserts returned snapshots into local `MultiplexerDevice` objects.
- `connectUsbClients()` asks the daemon to start the runtime client watcher for a device, then upserts returned snapshots into local `MultiplexerUsbClient` objects.
- `getDevices()`, `getDeviceUsbClients()`, and `getAllUsbClients()` read from the local mirrors and wait for local events when necessary.
- `startWSServer()` asks the daemon to start the WebSocket server and mirrors returned `WebSocketServerInfo` into compatibility fields: `wssPort`, `wssHost`, `roomId`, and `wss.wssPath`.
- After a facade calls `startWSServer()`, it becomes a WebSocket-state requester. Host sends it a targeted current WebSocket snapshot, later snapshots, and `client-message` events whose source is `websocket-runtime` or `websocket-driver`. Facades that did not request the WebSocket service do not consume this state.
- `getAllWebsocketAppClients()` and `getAllAppClients()` continue to expose WiFi runtimes through `MultiplexerWebSocketClient` proxies. Proxy send and close operations become daemon RPCs.
- `sendMessageToWeb()` and `sendMessageToApp()` keep the original public call shape, but both forward through the daemon's unified `sendMessageWithoutReply` RPC.
- `disableAllClients()` and `addDeviceManager()` no longer operate on physical objects in the Multiplexer-only facade; they only log warnings.
- `close()` only closes the current connector's control socket, removes subscriptions, and clears local mirrors. It does not directly close the daemon. Daemon shutdown is controlled by idle timeout or shutdown/replacement flow.

When the daemon control socket disconnects, the facade clears local mirrors, rejects pending RPCs, and schedules desired-state recovery after 100 ms: reconnect the daemon, restore device discovery, restore `startAllDeviceClientWatchers()`, and restore a previously requested WebSocket server.

## 6. Daemon Discovery, Startup, and Replacement

When `DebugRouterConnector` forwards some behavior to the daemon, it calls `MultiplexerDaemonClient.call()`. `MultiplexerDaemonClient.call()` validates the complete RPC request before connecting; `connect()` then obtains an available daemon through `MultiplexerDaemonManager.ensureDaemon()`.

`MultiplexerDiscovery.validateDiscovery()` validates in this order:

1. Missing `daemon.json`, invalid JSON, or invalid shape returns unusable.
2. Missing `protocolVersion` returns unusable.
3. Heartbeat older than `multiplexerStaleTimeout` returns stale.
4. Connector protocol lower than daemon `minSupportedProtocolVersion` returns `connector-protocol-too-old`.
5. Daemon protocol lower than connector protocol returns `replace-required`.
6. Other compatible cases return usable.

Current default protocol constants:

```text
MULTIPLEXER_PROTOCOL_VERSION = 1
MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION = 1
```

`MultiplexerDaemonManager` handles validation results as follows:

- usable: first call `http://127.0.0.1:<controlPort>/health`; reuse only when health is OK.
- usable but health temporarily fails: if the pid is still alive, retry 3 times with `readyPollInterval`.
- `replace-required`: acquire `spawn.lock`, first request graceful daemon shutdown through the `shutdownDaemon` RPC; if the daemon does not exit, try SIGTERM/SIGKILL; then clean up `daemon.lock` and `daemon.json` and start a new daemon.
- connector protocol too old: throw an upgrade error. Do not clean up or kill the newer daemon.
- stale, invalid, or missing: acquire `spawn.lock` and run cleanup. If the discovery pid is alive, stop it. If the `daemon.lock` owner is alive and is not the pid just stopped, stop by lock owner. Finally clean local artifacts and spawn.

Important defaults:

```text
startupTimeout = 5000ms
readyPollInterval = 100ms
replacementTimeout = 1000ms
healthCheckTimeout = 500ms
spawnLockStaleTimeout = startupTimeout + replacementTimeout + 1000ms
```

Spawn uses the current Node executable to start `multiplexer/daemon/entry.js` as a detached child with `stdio: "ignore"`, then calls `unref()`. Startup arguments include discovery/lock paths, protocol versions, control port, heartbeat, serialized `debugInfo`, legacy driver dir, idle timeout, WebSocket config, and daemon-side `PhysicalConnectorOption`.

## 7. Daemon Process and Host

`entry.ts` parses daemon arguments, creates `MultiplexerHost` and `MultiplexerDaemon`, and registers cleanup logic for `beforeExit`, `SIGINT`, `SIGTERM`, `uncaughtException`, and `unhandledRejection`. Cleanup calls `daemon.stop()`. Forced exit paths wait at most 3000 ms.

`MultiplexerDaemon.start()` flow:

1. Acquire `daemon.lock`.
2. Start `MultiplexerHost`.
3. Read the actual Host control port.
4. Write `daemon.json`.
5. Start the heartbeat timer, which refreshes discovery heartbeat every 1000 ms by default.

`MultiplexerDaemon.stop()` flow:

1. Stop the heartbeat timer.
2. Stop Host.
3. Delete `daemon.json`.
4. Release `daemon.lock`.

`MultiplexerHost` is the core daemon object. It is responsible for:

- Owning the real `PhysicalConnector`.
- Starting the control server that serves `/health` and `/debug-router-multiplexer/control`.
- Starting the WebSocket server that continues to use `/mdevices/page/android`.
- Managing device watchers, runtime client watchers, and WebSocket clients.
- Serializing snapshots and broadcasting control events.
- Rewriting message IDs, managing pending routes, and routing responses.
- Coalescing configured ID-less queries and briefly memoizing their notification replies per runtime client.
- Maintaining legacy `LatestDriverProcess` owner state.
- Managing idle timeout and shutdown handlers.

## 8. Control Protocol

### 8.1 RPC

Control RPC methods are defined by `ControlRpcMethod`:

| RPC                     | Purpose                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `connectDevices`        | Start physical device discovery and return device snapshots.                                                |
| `connectUsbClients`     | Start the runtime client watcher for a device and return client snapshots.                                  |
| `startDeviceClientWatcher` | Start the runtime-client watcher for one device.                                                          |
| `stopDeviceClientWatcher`  | Stop the runtime-client watcher for one device without disconnecting it.                                  |
| `disconnectDevice`      | Disconnect a device.                                                                                        |
| `shutdownDaemon`        | Request graceful daemon shutdown, used by replacement/yield.                                                |
| `startWSServer`         | Start the WebSocket server inside the daemon; this RPC takes an empty `{}` parameter object.                 |
| `startAllDeviceClientWatchers` | Start watchers for all current and future devices.                                                   |
| `stopAllDeviceClientWatchers`  | Stop all current watchers and disable automatic watching for later devices.                          |
| `sendMessageWithReply`         | Forward a request-response message to a USB or WiFi runtime and return the complete response envelope. |
| `sendMessageWithoutReply`      | Send a fire-and-forget message to one App runtime, one Web Driver, or all Web Drivers.                 |
| `closeClient`           | Close a runtime client.                                                                                     |

Single-device watching uses separate `startDeviceClientWatcher({ deviceId })` and `stopDeviceClientWatcher({ deviceId })` RPCs; `deviceId` must be non-empty and extra fields are rejected at runtime. All-device watching uses `startAllDeviceClientWatchers({ force? })` and `stopAllDeviceClientWatchers({})`. Stopping all watchers also disables automatic watching for devices discovered later; either start RPC can enable watching again. The Connector validates the complete RPC request before sending it, and the daemon validates it again when receiving it. `connectUsbClients` remains separate because it returns the resulting client snapshot while watcher RPCs return no payload.

`sendCustomizedMessage` remains a public mirror-client API but is no longer a control RPC. `MultiplexerUsbClient` and `MultiplexerWebSocketClient` allocate the inner message id and assemble the legacy `Customized` envelope locally, send it through the `sendMessageWithReply` RPC, then extract `response.data.data.message` from the complete response envelope and return that string to the caller. This keeps one request-response transport RPC while preserving the existing public return types: `sendRawMessage` returns `ResponseMessageType`, while `sendCustomizedMessage` returns the inner message string.

`sendMessageWithoutReply` always uses the fixed `{ target, clientId, message }` shape. `{ target: "app", clientId, message }` sends to one USB or WiFi Runtime App, `{ target: "web", clientId, message }` sends to one Web Driver, and `{ target: "web", clientId: -1, message }` broadcasts to all Web Drivers. `target: "app"` rejects the `-1` broadcast sentinel because App broadcast is not supported. This explicit target domain prevents equal numeric App and Driver ids from redirecting a message to the wrong client kind.

`MultiplexerDebugInfo` is shared by discovery, health, snapshots, RPC requests, RPC responses, and events. It contains only optional diagnostic context: `protocolVersion`, `clientVersion`, `daemonVersion`, `processId`, and `timestamp`. Version strings no longer appear as standalone DTO or constructor fields. `processId` identifies the process that generated the context, while `timestamp` records when it was generated. The `capabilities` field has been removed from the complete Multiplexer protocol and daemon startup path because compatibility follows protocol-version negotiation and an additive protocol evolution policy rather than per-feature declarations. The required top-level `protocolVersion` and optional `minSupportedProtocolVersion` remain in discovery and health because they perform actual compatibility arbitration.

RPC requests and responses both contain `kind` and `id`. Connector requests populate `debugInfo` with the Connector process and timestamp; daemon discovery, health, snapshots, responses, and events populate it with the Daemon process and timestamp. `MultiplexerDaemonClient` has a default RPC timeout of 5000 ms. RPCs with a positive operation `timeout` use `max(rpcTimeout, timeout + 1000ms)`; RPCs without an operation timeout continue to use the default timeout, with no method-specific exception.

### 8.2 Event

`ControlEvent` currently defines:

```text
snapshot
legacy-ownership-changed
client-message
```

After a control connection is established, Host first sends a `snapshot` to that control id. Every physical-device, USB-runtime, WebSocket-runtime, and WebSocket-Driver lifecycle change is represented by a new snapshot rather than a dedicated lifecycle event. The Connector diffs consecutive snapshots and emits the legacy public lifecycle events locally. Additions are reported in dependency order (device before runtime), while removals are reported in reverse dependency order (runtime and WebSocket clients before device).

Runtime routing is transport-independent: USB and WiFi share ID restoration, route lookup, targeted replies, unknown-response dropping, and notification fanout. All message traffic uses `client-message` with `source: "usb-runtime" | "websocket-runtime" | "websocket-driver"`. WebSocket snapshots and messages are sent only to controls that requested `startWSServer`; facades that did not request the server filter shared WebSocket state and messages. When an already-connected control requests the shared server, Host sends it a fresh targeted snapshot so existing WiFi runtimes are mirrored immediately.

Connection trace is daemon-owned and is not part of `snapshot` or the control protocol. `MultiplexerHost` is the only owner that constructs `ConnectionTraceRecorder` from `connectionTrace`, passes that same instance to the `PhysicalConnector` it creates, records whole-chain connection facts, and closes the recorder. It does not reuse a recorder from an injected `PhysicalConnector` or an incoming `traceRecorder` option. In addition to the legacy device, runtime, and WebSocket-client connection facts, Host records daemon lifecycle and stop triggers, control-socket connections, shared WebSocket-server lifecycle, and legacy-ownership acquisition or loss. Control-socket events include the `controlId` and the resulting active-connection count; server and ownership events carry their endpoint or owner metadata. The Connector facade no longer exposes `getConnectionTrace()` or `onConnectionTrace()`, and the daemon exposes no trace query/subscription RPC or trace control event. The recorder's existing buffer, listener, and query capabilities remain available internally for now but are not exposed across processes.

Trace configuration is daemon-startup-global. The first Connector that actually starts the daemon determines `connectionTrace`; later Connectors reuse that daemon and cannot replace its recorder configuration until the daemon restarts. The daemon constructs the recorder using the original `ConnectionTraceOptions` rules and `process.env.DriverConnectionTracePath`, so the default remains disabled when neither provides an output. A string `connectionTrace.output` is converted to an absolute path and serialized to the daemon. A `WritableStream` remains valid for an in-process `PhysicalConnector`, but cannot cross the Multiplexer process boundary, so the facade ignores that output and logs a warning while forwarding the other trace options. `MultiplexerDaemonManager` explicitly removes `traceRecorder` from daemon startup serialization; the daemon entry also rejects a manually supplied recorder instance.

`DebugRouterConnector.applyHostEvent()` synchronizes snapshots into local mirrors and maps unified `client-message` sources back to compatibility event names such as `usb-client-message`, `ws-client-message`, and `ws-web-message`. The public Connector event surface therefore remains unchanged.

## 9. Connector-side Mirror Objects

`MultiplexerDevice` is a device proxy object in the connector process. It stores daemon snapshots and operates on the real daemon-side device through RPC:

- `startWatchClient()` -> `startDeviceClientWatcher({ deviceId })`
- `stopWatchClient()` -> `stopDeviceClientWatcher({ deviceId })`
- `disConnect()` -> `disconnectDevice`
- `getHost()` returns the snapshot host, or `127.0.0.1` if missing.

`MultiplexerUsbClient` is a runtime client proxy object in the connector process. It keeps the original `Client` API shape:

- `clientId()`
- `deviceId()`
- `close()`
- `sendCustomizedMessage()`
- `sendRawMessage()`
- `sendMessage()`
- `sendClientMessage()`
- `on()` / `once()` / `off()` / `onAllEvents()`

`sendRawMessage`, `sendMessage`, and `close` map to the `sendMessageWithReply`, `sendMessageWithoutReply`, and `closeClient` daemon RPCs respectively. `sendCustomizedMessage` and `sendClientMessage` assemble their `Customized` request locally and reuse the `sendMessageWithReply` RPC. `handleMessage()` only handles `client-message` events whose source is `usb-runtime`: CDP/App notifications trigger local events by method, while request-response replies are handled by the daemon-side route table.

`MultiplexerWebSocketClient` is a connector-process compatibility proxy for a real daemon-side WebSocket client. It refreshes `id`, `type`, and `raw_info` from `WebSocketClientSnapshot`, but does not own a real socket. `sendMessage()` selects the `sendMessageWithoutReply` RPC target from the snapshot type: Driver proxies target the specified Web Driver, while other proxies target the WiFi Runtime App. `sendCustomizedMessage()` assembles the request locally and reuses `sendMessageWithReply`; `close()` remains a direct runtime operation. Driver-type proxies also retain `handleListClients()` behavior and build a compatible `ClientList` from the facade's current WiFi and USB mirrors, then send it only to the requesting Driver.

Local mirror synchronization rules:

1. On `snapshot`, upsert device and USB-client Maps. For a facade that requested the WebSocket service, also upsert WebSocket app/frontend Maps.
2. Diff the snapshot against the local Maps and emit compatibility connection events for additions.
3. Remove absent runtimes and WebSocket clients before absent devices, emitting compatibility disconnection events in dependency order.
4. On `client-message`, map `source` to the corresponding compatibility message surface.
5. When the daemon control socket disconnects, clear device, USB client, and cached WebSocket client mirrors, then schedule desired-state recovery.

## 10. WebSocket Frontend Path

`WebSocketController` has been decoupled from the concrete `DebugRouterConnector` class and depends on the structural `WebSocketControllerHost`. In the current Multiplexer implementation, that host is the daemon-side `MultiplexerHost`.

`startWSServer` RPC runs inside the daemon:

1. Select a port from `websocketOption.port` or default `19783`, using `detect-port` to avoid conflicts.
2. Use `ip.address()` to build the host and return `WebSocketServerInfo`.
3. Create `WebSocketController` and listen on `/mdevices/page/android`.

After startup, the shared WebSocket server remains running even when every control that requested it disconnects. Requester removal only stops snapshot/event delivery to that control; the server is closed together with the daemon during idle shutdown, explicit shutdown, or replacement.

WebSocket client handshake:

1. The server allocates a client id and sends `Initialize`.
2. The client replies with `Register`, including type and info.
3. Connections whose type is `Driver` are stored in `webClients`, representing WebSocket Driver frontends.
4. Other types are stored in `websocketAppClients`, representing WiFi app clients.
5. Host maintains `activeWebSocketDriverIds` on connect/disconnect for idle detection, and sends the latest WebSocket snapshot only to control clients that requested `startWSServer`.

Message paths:

- Driver frontend sends `Customized` to a target runtime: `WebSocketClient` extracts the target `client_id`, calls `WebSocketController.sendMessageToApp(id, message, fromWebClientId)`, and enters `MultiplexerHost.handleWebSocketMessage()`. Host selects either a WebSocket app client (WiFi) or `PhysicalConnector.usbClients` (USB) by client id.
- WebSocket app client sends a message to frontend: `WebSocketClient` calls `handleWebSocketAppMessage()`. Host passes it to the transport-independent `handleRuntimeMessage(appClientId, message, "websocket-runtime")`, so WiFi and USB share routing while retaining an explicit message source.
- `ClientList` is triggered by Driver frontends and returns current WebSocket app clients and USB runtime clients. USB runtime clients use `network: "USB"`; WebSocket app clients use `network: "WiFi"`.

`sendMessageToWebClient(webClientId, message)` sends a matched request-response reply only to the original Driver frontend. `sendMessageToWeb(message)` is used for SDK-initiated event broadcast.

Current implementation boundaries:

- `WebSocketController` still keeps a compatibility branch that sends directly to `websocketAppClients` when `fromWebClientId` is missing.
- In the current daemon path, Driver frontend `Customized` messages carry `fromWebClientId`, so they enter Host unified routing.
- Host unified outbound routing supports both `PhysicalConnector.usbClients` and `WebSocketController.websocketAppClients`; both runtime types share message-ID rewriting, pending routes, and targeted response delivery.
- `sendMessageWithReply` and `closeClient` remain Runtime-only RPC operations. The public `sendCustomizedMessage` helper reuses `sendMessageWithReply`. `sendMessageWithoutReply` selects the client identity domain first: `target: "app"` checks only WebSocket App and USB clients, while `target: "web"` routes only through the Web Driver controller, so overlapping numeric ids cannot redirect a message across domains.
- Runtime `Customized` messages are associated with the registered WebSocket app client id, so they still enter unified routing when the payload omits `sender`. `WebSocketClient` does not emit an eager duplicate message for this branch; Host emits the routed or broadcast result exactly once. Non-`Customized` runtime messages and Driver messages continue to use requester-scoped `client-message` events with distinct sources.
- WebSocket parsing and routing errors are contained and logged by the client handler instead of escaping or closing the socket. On close, the controller also checks the source client instance before removing a Map entry, so a WiFi runtime and Driver frontend with the same numeric id cannot disconnect each other.
- WebSocket app clients appear in `ClientList` and are synchronized to requesting Connector facades through snapshots. Driver-to-WiFi, Connector-to-WiFi, targeted responses, raw events, disconnect cleanup, and late-requester snapshot recovery are covered by integration and E2E tests.

## 11. Message ID Rewriting, Routing, and Notification Query Memoization

### 11.1 ID-Bearing Request/Response Routing

Different frontends can send the same CDP/App ID at the same time, for example:

```json
{ "id": 1, "method": "Runtime.enable" }
```

SDK responses only carry message IDs. They do not carry control IDs or WebSocket client IDs. Therefore Host must rewrite the original ID into a globally unique ID before forwarding the message to runtime, and record the response target.

Current `PendingRouteTable` route structure:

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

The route timeout defaults to 10000 ms. Control route timeout rejects the corresponding Promise; WebSocket route timeout only removes the mapping.

Outbound handling:

1. Host parses the outer JSON.
2. Ignore `UsbConnect` and `UsbConnectAck`.
3. If `data.data.client_id` is non-zero/truthy, rewrite it to `-1` before sending to runtime.
4. Recognize the Customized payload from `data.data.message`, supporting both string and object message forms.
5. Create a pending route only when the payload contains a safe integer `id`.
6. Host allocates `globalMessageId`, rewrites the original ID to the global ID, and writes the mapping into `PendingRouteTable`.
7. Select the real runtime by target client id and call `WebSocketClient.sendMessage()` for WiFi or `UsbClient.sendMessage()` for USB.

Inbound handling:

1. Host receives a runtime message and parses the Customized payload.
2. If the payload has a safe integer ID, `take()` the route from `PendingRouteTable` by global ID.
3. On route hit, restore the frontend original ID and restore sender/client_id to the real runtime client ID.
4. If a control route has `resolve`, it came from `sendMessageWithReply()`; resolve with the complete restored `ResponseMessageType`. The Connector-side mirror extracts the inner message only when implementing its public `sendCustomizedMessage()` helper. Otherwise, send a targeted `client-message` event back to the specified control, with source `usb-runtime` or `websocket-runtime`.
5. WebSocket routes use `sendMessageToWebClient(webClientId, message)` to send only to the original Driver frontend.
6. If a message has a response ID but no route matches, drop it to avoid leaking one frontend's response to other frontends.
7. If a message has no response ID, treat it as an SDK-initiated event: rewrite runtime client ID, broadcast to WebSocket Driver frontends, and broadcast a `client-message` event with the matching runtime source.

Route cleanup:

- When a control socket disconnects, call `clearByControlId(controlId)` and reject control routes.
- When a WebSocket frontend disconnects, call `clearByWebClientId(webClientId)`.
- When Host physical discovery resets or legacy owner is lost, clear all routes.

### 11.2 ID-less Query/Notification Memoization

#### 11.2.1 Problem and Message Scope

Some frontend requests do not contain `data.data.message`, so there is no `message.id` for `PendingRouteTable` to rewrite and target. After `ListSession` reaches the SDK, the SDK separately emits a `SessionList` notification:

```text
frontend -- ListSession --> SDK runtime
frontend <-- SessionList -- SDK runtime
```

`SessionList` is an independent notification rather than a response carrying the same id. Under the normal SDK-initiated broadcast rule, one notification is delivered to every WebSocket Driver frontend and control client. If 30 frontends send `ListSession` concurrently, the SDK produces 30 `SessionList` notifications and each is broadcast to 30 frontends, resulting in 900 subscription deliveries; message volume grows quadratically. In real-device stress testing, 20 connectors sending `ListSession` concurrently caused the phone to crash under memory pressure.

The solution is to memoize this query pattern: Host records the latest `SessionList` emitted by the SDK. When a frontend sends `ListSession` again, a fresh cache entry is returned directly to that requester without accessing the SDK. If no cache exists, only the first query arriving within the short window is forwarded; the remaining queries converge on the same pending state and wait for the SDK notification to follow its original broadcast path. This prevents the broadcast storm without changing the SDK notification format or the initial notification's broadcast semantics.

The current audit of SDK native `Processor::process()` and the `Customized` protocol branches is:

| Request type                                     | SDK-side result                                                                                        | Memoized                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `ListSession`                                    | Immediately calls `FlushSessionList()` and separately emits a `SessionList` notification.              | Yes.                                                          |
| `CDP` / extension                                | The message body contains a request-response ID, or the message itself is an unsolicited notification. | No; continue through `PendingRouteTable` or normal broadcast. |
| `App`                                            | Protocol parsing explicitly requires an inner `message.id`, and the SDK response reuses that ID.       | No; continue through `PendingRouteTable`.                     |
| `OpenCard`                                       | One-way call to the SDK global handler with no paired notification.                                    | No.                                                           |
| `D2RStopAtEntry` / `D2RStopLepusAtEntry`         | One-way delivery to the SDK message handler; this branch emits no paired notification.                 | No.                                                           |
| `Registered` / `RoomJoined` / `ChangeRoomServer` | Connection-handshake and room protocols, not frontend-to-runtime notification-query paths.             | No.                                                           |

Therefore, the current declarative mapping contains only:

```text
ListSession -> SessionList
```

If another message gains the same semantics, only a request/notification mapping needs to be added to the `MemoizedNotificationQueryTable` definition; the Host state machine does not need another message-specific branch.

#### 11.2.2 Module Responsibility and State

`MemoizedNotificationQueryTable` independently handles:

1. Determining whether a request is memoizable from the outer `Customized` `data.type`.
2. Storing the latest notification and receive time by runtime client id and notification type.
3. Storing an SDK query and send time by runtime client id and request type while it is pending.
4. Returning a `not-memoized`, `forward`, `pending`, or `cached` decision.
5. Refreshing the cache and releasing the matching pending state when an SDK notification arrives.
6. Cleaning pending/cache state after runtime send failure, runtime disconnect, or Host reset.

Core state is isolated by runtime client:

```ts
notifications: Map<clientId, Map<notificationType, {
  message: string;
  receivedAt: number;
}>>;

pendingQueries: Map<clientId, Map<requestType, sentAt>>;
```

A global cache keyed only by message type would be incorrect because runtime A's `SessionList` could be returned to a frontend querying runtime B. The cache stores the complete notification string after Host rewrites the real runtime client id, so a cache hit can be sent directly through the original control or WebSocket frontend channel. An empty `SessionList` is valid and is memoized in the same way as a non-empty list.

The default TTL is 1000 ms, shared by cached notifications and pending queries:

- `now - receivedAt <= TTL`: the cache is fresh, return `cached`.
- `now - sentAt <= TTL`: an SDK query is already pending, return `pending`.
- Age greater than TTL: the state is stale, allow a new request to return `forward`.

A missing, negative, or non-finite TTL falls back to the default; `0` is valid. An entry whose age equals the TTL remains fresh and becomes stale only when `age > TTL`.

Pending state must also recover on timeout. If the SDK never emits the expected notification, or the notification is lost in transit, permanent pending state would suppress every later `ListSession`.

#### 11.2.3 Host Integration Flow

Before a frontend message is sent to a runtime:

1. Host parses JSON and normalizes `client_id`.
2. Host calls `MemoizedNotificationQueryTable.query(clientId, data)` to decide whether this request should be memoized.
3. `not-memoized`: this request is outside the memoization scope, so normal message-id rewriting and runtime delivery continue. Valid outer JSON that is unrelated, has no recognized `Customized` type, or uses an unconfigured type enters this branch; invalid outer JSON is rejected before reaching the table.
4. `forward`: the request is memoizable, but there is no fresh cache or valid pending state; record pending and forward only this request to the SDK runtime.
5. `pending`: there is no cache, but an earlier request of the same type was already sent to the SDK through `forward`; do not send a duplicate, and wait for the SDK notification to reach all current requesters through the original broadcast path.
6. `cached`: a memoized, unexpired entry exists; do not access the SDK, and send the cached notification only to the current control client or WebSocket frontend.
7. If synchronous delivery to the real USB/WiFi runtime throws, Host calls `handleSendFailure()` to release pending immediately so the next request can retry.

When an SDK runtime message enters Host:

1. A message with a valid response id still uses `PendingRouteTable` first; this module does not participate.
2. A message without a response id has its runtime client id rewritten.
3. Host calls `recordNotification(clientId, message)` to decide whether the message should be memoized; matching the currently declared `SessionList` refreshes the cache and releases the `ListSession` pending state.
4. The current SDK notification still follows the unified broadcast rule: every Driver frontend receives it, while controls receive `client-message` with the matching runtime source. This satisfies the initial requester and all requesters coalesced while pending.
5. A later cache hit is targeted only to its current requester and is not broadcast again.

The corresponding sequence is:

```mermaid
sequenceDiagram
    participant A as Frontend A
    participant B as Frontend B
    participant H as MultiplexerHost
    participant T as MemoizedNotificationQueryTable
    participant S as SDK runtime

    A->>H: ListSession
    H->>T: query(clientId, data)
    T-->>H: forward
    H->>S: ListSession

    B->>H: ListSession
    H->>T: query(clientId, data)
    T-->>H: pending
    Note over B,H: Do not send a duplicate SDK query; wait for the notification fanout

    S-->>H: SessionList
    H->>T: recordNotification(clientId, message)
    T-->>H: Refresh cache and clear pending
    H-->>A: broadcast SessionList
    H-->>B: broadcast SessionList

    A->>H: ListSession again within TTL
    H->>T: query(clientId, data)
    T-->>H: cached SessionList
    H-->>A: targeted SessionList
```

#### 11.2.4 Lifecycle Cleanup

Memoized state belongs to the real runtime connections currently held by Host and cannot be reused across runtime lifecycles:

- `client-disconnected`: call `clearClient(clientId)` to clear that runtime's cache and pending state.
- Physical discovery reset, legacy owner loss, or Host stop: call `clear()`.
- Control client or WebSocket frontend disconnect: keep runtime cache because it belongs to the runtime, not to one frontend.
- A single runtime send failure: release only that client/request type's pending state without clearing other runtime caches.

This reduces 30 concurrent `ListSession` requests to one SDK query and one notification fanout to 30 frontends, or 30 subscription deliveries. Later individual queries within the TTL each receive one targeted cached result instead of creating a 30 x 30 broadcast storm.

## 12. Legacy Multi-open Owner Compatibility

Multiplexer no longer lets each connector process compete for the legacy `LatestDriverProcess`. The legacy owner file is maintained only by daemon-side `LegacyOwnershipGuard`, for compatibility with physical-layer logic that still depends on the old multi-open owner.

Current `LegacyOwnershipGuard.start()` behavior:

1. If `DriverCloseMultiOpen=true`, enter attached state directly and emit `daemon-started`.
2. Otherwise, create the legacy driver dir and remove the old `lockfile` directory.
3. Write daemon pid into `LatestDriverProcess`.
4. Check the owner file every 500 ms.

Monitor logic:

- Owner pid is the current daemon: remain attached.
- Owner file is missing or invalid: rewrite current daemon pid.
- Owner pid is not alive: rewrite current daemon pid.
- Owner pid is another live process: daemon becomes unattached and Host calls `handleLegacyOwnershipLost()`.

When Host loses legacy owner, it:

1. Sets `legacyOwnershipAttached = false`.
2. Rejects and clears all pending routes.
3. Stops physical discovery and device client watchers, then removes all devices because Host no longer controls them.
4. Closes and removes all USB runtime clients, and clears the selected runtime.
5. Actively closes and removes all WebSocket app/WiFi runtime clients, while retaining live WebSocket Driver frontend connections.
6. Publishes a snapshot from those authoritative Maps and refreshes WebSocket `ClientList` / `DeviceList`: only live Driver clients remain; devices and USB/WiFi runtimes are absent.
7. Broadcasts `legacy-ownership-changed`, and the connector facade converts it into a `MultiOpenStatus.unattached` callback.

There is no synthetic empty snapshot and no ownership-loss-only mirror reset. Host first removes devices and runtimes from their authoritative daemon-side Maps, then serializes those Maps together with the retained Driver Map. WebSocket `ClientList` reads the same USB and WiFi runtime Maps, and the facade reconciles all mirrors from that snapshot. Therefore `ClientList`, Host snapshot, and facade mirrors converge on one real state even when a WiFi runtime and Driver frontend use the same numeric client id.

Later `connectDevices()`, `startAllDeviceClientWatchers()`, and desired-state recovery reacquire ownership inside the Host before restoring physical discovery. This does not return to the old connector implementation; it only lets the daemon regain the owner file required by the legacy physical layer.

## 13. Fault Recovery and Shutdown

### 13.1 Daemon Crash or Control Socket Disconnect

After daemon crash, the connector's control socket closes. `MultiplexerDaemonClient.closeSocket()` rejects pending RPCs and notifies connection-state listeners. `DebugRouterConnector` receives disconnected state, clears local mirrors, then schedules desired-state recovery.

Recovery flow:

1. `daemonClient.connect()` ensures the daemon again.
2. If device discovery was previously requested, run `connectDevices(-1, null, isAutoListenClients)` again.
3. If `startAllDeviceClientWatchers()` was previously requested, start all runtime watchers again.
4. If the WebSocket server was previously started, run `startWSServer()` again.

State recovery converges on daemon snapshot. Even if incremental events were lost, the full snapshot after reconnect overwrites local mirrors and realigns state.

| State                                                   | Owner                                        | Recovery                                                                                                                                                                                                                          |
| ------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real device connection                                  | Daemon-side `PhysicalConnector`              | Daemon scans again and broadcasts snapshot.                                                                                                                                                                                       |
| Local device, USB runtime, and WebSocket client mirrors | Connector facade                             | Rebuilt from snapshot; the WebSocket portion is restored only for a facade that requests `startWSServer()` again.                                                                                                                 |
| Connector pending RPC                                   | Connector-side `MultiplexerDaemonClient`     | Rejected when control socket disconnects; caller retries through existing logic.                                                                                                                                                  |
| pending route                                           | Daemon-side `PendingRouteTable`              | Created for request lifecycle; cleared on control/WebSocket disconnect, Host reset, or timeout.                                                                                                                                   |
| memoized notification query                             | Daemon-side `MemoizedNotificationQueryTable` | Starts empty after daemon recovery and is repopulated opportunistically by matching runtime notifications; isolated by runtime client; cleared on runtime disconnect or Host/physical reset; stale entries are ignored after TTL. |
| WiFi runtime / WebSocket frontend connection            | Daemon-side `WebSocketController`            | The app/frontend reconnects after WebSocket disconnect; Driver count is used for daemon idle detection, while requester-scoped snapshots/events restore facade mirrors.                                                           |

### 13.2 Daemon Idle Auto-shutdown

The public facade passes this default:

```text
multiplexerDaemonIdleTimeout = 600000ms
```

Host idle detection only counts two upper-layer consumers:

1. Control WebSocket connections, meaning connector API users.
2. WebSocket frontends whose type is `Driver`.

When both counts are 0, Host starts the idle timer. When the timer expires, Host calls the daemon idle handler. The daemon runs `stop()` and the entry process exits. If a new control connection or Driver frontend connects during the idle window, the timer is cancelled.

WiFi runtime/app connections are not consumers for idle ownership. Connecting, disconnecting, or continuing to use a phone over WiFi does not cancel or restart the idle timer; without a Connector control client or Driver frontend, the daemon exits after the configured timeout and closes the shared WebSocket server as part of `stop()`.

If `multiplexerDaemonIdleTimeout` is negative, non-finite, or not configured in an embedded scenario, Host does not enable idle auto-shutdown.

### 13.3 Daemon Replacement/Yield

When a connector finds an outdated or unhealthy daemon that must be replaced, Manager first requests graceful daemon shutdown through the `shutdownDaemon` RPC. Host calls its shutdown handler, and the daemon runs `stop()` to clean heartbeat, discovery, lock, control server, WebSocket server, and physical connector. Manager only tries SIGTERM/SIGKILL if the daemon does not exit in time.

### 13.4 Unknown Response ID

When Host receives a runtime response with a valid response ID but no matching route, it drops the message and does not broadcast it. This avoids leaking one frontend's request-response reply to other frontends.

## 14. Configuration and Compatibility

Current Multiplexer-related `DebugRouterConnectorOption` fields:

| Option                         | Purpose                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `multiplexerDaemonIdleTimeout` | Daemon idle shutdown timeout. Facade default is 600000 ms.                   |
| `multiplexerStartupTimeout`    | Timeout for waiting for daemon readiness. Default is 5000 ms.                |
| `multiplexerStaleTimeout`      | Timeout for judging discovery heartbeat as stale. Facade default is 5000 ms. |
| `multiplexerRpcTimeout`        | Default control RPC timeout. Default is 5000 ms.                             |
| `multiplexerRootDir`           | Multiplexer root directory. Default is `~/.DebugRouterConnector`.            |
| `multiplexerDataDir`           | Multiplexer data directory. Takes precedence over root dir.                  |
| `multiplexerDaemonEntry`       | Daemon entry js path, used by tests or special packaging scenarios.          |
| `multiplexerLegacyDriverDir`   | Directory containing the legacy `LatestDriverProcess`.                       |
| `websocketOption.port`         | Desired daemon WebSocket server port. Default is 19783.                      |
| `websocketOption.roomId`       | Room id returned by WebSocket `RoomJoined`.                                  |

`MultiplexerHostOption.memoizedNotificationTtlMs` controls the daemon-side pending and cache TTL and defaults to 1000 ms. It is currently an internal Host option used for embedding and deterministic tests, not a public `DebugRouterConnectorOption` propagated through daemon startup.

Original physical options are passed to the daemon-side `PhysicalConnector`, including `manualConnect`, `enableWebSocket`, `enableAndroid`, `enableIOS`, `enableHarmony`, `enableDesktop`, `enableNetworkDevice`, `adbHostPort`, `hdcHostPort`, `usbConnectOpt`, `networkDeviceOpt`, and serializable `connectionTrace` fields. The daemon entry validates `connectionTrace.enabled` as boolean, `connectionTrace.output` as a string path, and `connectionTrace.bufferSize` as a non-negative finite number; recorder instances are rejected. `reportService` is not passed to the daemon-side physical connector; the facade still initializes report service.

The public facade no longer treats `enableMultiplexer`, `enableProxy`, `proxyDaemonIdleTimeout`, or `DEBUG_ROUTER_PROXY*` as compatibility entries. Callers should use the `multiplexer*` naming.

Protocol compatibility rules:

1. `daemon.protocolVersion === connector.protocolVersion`: reuse directly.
2. `daemon.protocolVersion > connector.protocolVersion` and `connector.protocolVersion >= daemon.minSupportedProtocolVersion`: reuse the newer daemon; old connector only calls RPCs and events it knows.
3. `connector.protocolVersion < daemon.minSupportedProtocolVersion`: connector rejects connection and asks for upgrade. It does not clean up the newer daemon.
4. `daemon.protocolVersion < connector.protocolVersion`: connector treats daemon as outdated and runs replacement.

## 15. Typical Flows

### 15.1 First Connector Startup

1. Facade creates discovery, manager, and daemon client.
2. `connectDevices()` triggers `daemonClient.connect()`.
3. Manager finds no available daemon and acquires `spawn.lock`.
4. Manager spawns detached daemon entry.
5. Daemon acquires `daemon.lock`, starts Host/control server, and writes `daemon.json`.
6. Connector connects to the control WebSocket and receives the initial `snapshot`.
7. Facade uses the `connectDevices` RPC to ask Host to start physical device discovery.

### 15.2 Later Connector Startup

1. Facade reads existing `daemon.json`.
2. Discovery is fresh and health is OK, so it connects to the existing control server.
3. The new control connection receives current snapshot.
4. Later physical-device and USB-runtime lifecycle changes are broadcast as snapshots to all control clients. USB/WiFi runtime routing shares one processing strategy and emits `client-message` with the matching source. WebSocket lifecycle state remains visible only to facades that requested `startWSServer()`.

### 15.3 Driver Frontend Requests a Runtime

1. A facade calls `startWSServer()`, and the daemon starts or reuses the shared WebSocket server.
2. The Driver frontend registers with type `Driver` and enters `webClients`; facades that requested the WebSocket service synchronize the corresponding Driver mirror.
3. The Driver frontend sends `Customized` with the target runtime `client_id`.
4. Host selects the USB or WiFi runtime by client id, allocates a global CDP/App id, and records `webClientId + originalId + clientId`.
5. When the runtime response enters the unified inbound path, Host matches the route and restores the original id and real runtime client id.
6. Host sends the response only to the originating Driver frontend; it does not leak to other Drivers or control clients.

### 15.4 SDK-initiated Event

1. A USB or WiFi runtime sends a CDP/App notification without request ID.
2. Host recognizes it as an SDK-initiated event and rewrites runtime client ID.
3. If WebSocket is enabled, Host broadcasts it to all Driver frontends.
4. Host applies the same broadcast logic for both transports, using `client-message` with source `usb-runtime` or `websocket-runtime`.
5. Connector facades dispatch USB events into the corresponding `MultiplexerUsbClient` local event system and expose WiFi events through the WebSocket event surface after requester-state filtering.

### 15.5 Concurrent `ListSession` Queries

1. The first frontend sends `ListSession` for a runtime client. Host records a pending query and forwards it to the SDK runtime.
2. Other frontends send `ListSession` for the same runtime within 1000 ms. Host coalesces these queries and does not send duplicate runtime messages.
3. The runtime sends `SessionList`. Host records the complete rewritten notification, clears the pending marker, and broadcasts the notification through the original WebSocket and control event paths.
4. A frontend sends another `ListSession` while the recorded notification is fresh. Host sends the cached `SessionList` only to that frontend.
5. After the TTL expires, the next `ListSession` is forwarded to the runtime again so the cached session state is refreshed.

## 16. Validation Coverage

The current test layers cover the main behavior introduced by this design:

| Layer                             | Current coverage                                                                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                              | Host routing, WebSocket parsing/error containment, requester-scoped mirrors, `MultiplexerWebSocketClient`, connection trace ownership, overlapping client ids, and ownership-loss state cleanup.                           |
| Integration                       | Concurrent daemon startup, version replacement, reconnect/snapshot convergence, routing isolation, daemon idle lifecycle, daemon-owned connection trace, WiFi runtime behavior, and legacy ownership preemption/reacquire. |
| Package-entry E2E without devices | Shared daemon/facade behavior, WebSocket routing, WiFi runtime registration and proxy APIs, Driver preservation during ownership loss, and snapshot/`ClientList` convergence.                                              |
| Real-device USB E2E               | Android/iOS discovery, runtime watcher recovery, request-response routing, legacy ownership preemption, and stress/churn flows through `real_device.js` and `real_device_stress.js`.                                       |
| Real-device WiFi E2E              | Android WiFi registration, public lifecycle/mirrors, Driver and Connector round trips, proxy calls, and disconnect cleanup through `real_device_wifi.js`.                                                                  |

Primary commands are:

```bash
cd debug_router_connector
npm run test:multiplexer
npm run test:integration:multiplexer

cd ../test/e2e_test/connector_test
npm run test:multiplexer:without-device
npm run test:multiplexer:with-device
npm run test:multiplexer:with-device:wifi:android
```
