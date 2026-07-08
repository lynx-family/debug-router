# DebugRouter Multiplexer Technical Design

## 1. Background

The `debug_router` SDK still uses an exclusive single-frontend connection model: the native side keeps only one current transceiver or USB client, and a new connection replaces the previous one. When multiple DevTool frontend processes start at the same time, such as HDT, Lynx DevTool MCP, and VSCode extensions, they all connect to the SDK-side DevTool through `debug_router_connector`. The later frontend then takes over the SDK connection and disconnects the existing frontend.

The current Multiplexer implementation moves this multi-frontend concurrency problem into `debug_router_connector`: the local machine keeps one detached daemon that owns the real device and SDK runtime connections, and all connector processes and WebSocket frontends share the same physical channel through that daemon.

## 2. Terms, Usage, and Goals

### 2.1 Reading Guide

This document helps readers quickly understand the code structure and call flow. Recommended reading order:

1. `4. Overall Architecture`: understand the boundary between connector processes, daemon, WebSocket frontends, and SDK runtime.
2. `5. Public DebugRouterConnector Facade` and `6. Daemon Discovery, Startup, and Replacement`: understand how normal callers automatically reuse the daemon.
3. `10. WebSocket Frontend Path` and `11. Message ID Rewriting and Routing`: understand source isolation and targeted responses for concurrent frontends.
4. `12. Legacy Multi-open Owner Compatibility` and `13. Fault Recovery and Shutdown`: understand `LatestDriverProcess` compatibility, daemon crashes, and idle shutdown.

The most important implementation boundary is: the public `DebugRouterConnector` is now a Multiplexer facade; real physical connections live inside the daemon; the connector side mainly holds device and USB runtime client mirrors; WebSocket app clients currently enter the daemon-side `ClientList`, but they are not synchronized as connector control-client state.

### 2.2 Terms

| Name | Meaning |
|---|---|
| debug_router SDK | The SDK-side DebugRouter component. It receives debugging messages from frontends and returns SDK runtime events and responses. |
| debug_router_connector | The PC-side DebugRouter connection library. It discovers devices, connects to SDK runtimes, and provides a WebSocket debugging entry for HDT/browser DevTool pages. |
| DebugRouter Multiplexer | A local multiplexing mechanism inside the connector. A daemon owns the real device and SDK connections, isolates messages, rewrites IDs, and routes responses for multiple frontends. |
| Multiplexer daemon | A local detached shared process. It owns real physical connections, the control server, the WebSocket server, snapshot/event broadcast, and routing. |
| control client | A daemon client created when a normal connector process connects to the daemon through the control WebSocket. |
| WebSocket Driver frontend | A WebSocket frontend page whose type is `Driver`, such as HDT. |
| runtime client | A debugging target for an SDK runtime. The current connector mirror mainly covers USB runtime clients; WebSocket app clients are tracked by the daemon-side `WebSocketController` and appear in `ClientList`. |

### 2.3 Caller Usage

For HDT, Lynx DevTool MCP, VSCode extensions, and similar callers, Multiplexer is an internal capability of `debug_router_connector`. Callers continue to create and use `DebugRouterConnector` in the original way:

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
2. Multiple `DebugRouterConnector` instances, HDT pages, and other upper-layer tools can coexist and reuse the same local daemon.
3. The public `DebugRouterConnector` API should keep the existing usage shape as much as possible: device and runtime clients are exposed through local mirror objects and events, while the WebSocket server keeps the original path and compatibility fields.
4. CDP/App request-response message IDs are isolated so concurrent frontends using the same ID do not receive each other's responses.
5. The implementation has recovery paths for daemon crashes, protocol upgrades, idle shutdown, and legacy multi-open owner preemption.

### 2.5 Non-goals

1. Do not modify the SDK native single-connection model.

### 2.6 Tradeoffs

Another possible solution is to add multi-frontend connection and message fanout support directly on the SDK side. The current implementation chooses a connector-side Multiplexer because the change boundary is more controlled, caller upgrade cost is lower, and rollout or rollback is easier. The tradeoff is that the local message path adds one connector-to-daemon hop and the daemon discovery, lifecycle, and troubleshooting path must be maintained.

| Solution | Advantages | Disadvantages |
|---|---|---|
| Connector-side Multiplexer | No SDK native change; callers only upgrade the connector; rollout and rollback are more controlled. | Adds one local forwarding hop; daemon lifecycle and debugging add another layer. |
| SDK-side multi-frontend support | Shorter path and a more direct connection model. | Larger native change surface; depends on business SDK releases; rollback is harder; the SDK side still needs fanout, lifecycle, and compatibility logic. |

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

Daemon side:

- `debug_router_connector/src/multiplexer/daemon/entry.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerDaemon.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerHost.ts`
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

HDT and other WebSocket frontends
  ws://<host>:<wssPort>/mdevices/page/android
    daemon-side WebSocketController
      MultiplexerHost
        PhysicalConnector
          USB SDK runtime / device
```

Connector processes no longer directly own real device watchers or SDK runtime connections. Real connections only exist inside `MultiplexerHost -> PhysicalConnector` in the daemon process. Connector processes mainly maintain local `MultiplexerDevice` and `MultiplexerUsbClient` mirrors. WebSocket app/web client snapshot types and facade handling branches exist, but the current Host does not broadcast WebSocket client connection events to control clients.

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

`spawn.lock` serializes daemon startup and is only held during the connector's daemon ensure window. `daemon.lock` is held by the daemon process and marks the current daemon owner. `daemon.json` is written after the daemon starts the control server and is refreshed on each heartbeat. Writes use `writeJsonAtomic()` so other processes do not read partial JSON.

## 5. Public `DebugRouterConnector` Facade

The `DebugRouterConnector` constructor creates:

1. `MultiplexerDiscovery`, which reads and validates `daemon.json`.
2. `MultiplexerDaemonManager`, which handles ensure, spawn, replacement, health checks, and stale cleanup.
3. `MultiplexerDaemonClient`, which connects to the daemon control WebSocket, sends RPCs, and receives events.
4. Local `DriverClient`, trace recorder, device mirror Map, and runtime client mirror Map.

If `manualConnect` is false, the constructor automatically calls `connectDevices()`. `connectDevices()`, `startWatchAllClients()`, and desired-state recovery after daemon disconnect all call `reacquireLegacyOwnership` first, so the daemon becomes the legacy `LatestDriverProcess` owner again before physical watchers are restored.

Current public facade behavior:

- `connectDevices()` sends a control RPC to let the daemon start physical device discovery, then upserts returned snapshots into local `MultiplexerDevice` objects.
- `connectUsbClients()` asks the daemon to start the runtime client watcher for a device, then upserts returned snapshots into local `MultiplexerUsbClient` objects.
- `getDevices()`, `getDeviceUsbClients()`, and `getAllUsbClients()` read from the local mirrors and wait for local events when necessary.
- `startWSServer()` asks the daemon to start the WebSocket server and mirrors returned `WebSocketServerInfo` into compatibility fields: `wssPort`, `wssHost`, `roomId`, and `wss.wssPath`.
- `sendMessageToWeb()` and `sendMessageToApp()` keep the original call shape, but forward to the daemon.
- `disableAllClients()` and `addDeviceManager()` no longer operate on physical objects in the Multiplexer-only facade; they only log warnings.
- `close()` only closes the current connector's control socket, removes subscriptions, and clears local mirrors. It does not directly close the daemon. Daemon shutdown is controlled by idle timeout or shutdown/replacement flow.

When the daemon control socket disconnects, the facade clears local mirrors, rejects pending RPCs, and schedules desired-state recovery after 100 ms: reconnect the daemon, restore device discovery, restore `startWatchAllClients()`, and restore a previously requested WebSocket server.

## 6. Daemon Discovery, Startup, and Replacement

When `DebugRouterConnector` forwards some behavior to the daemon, it calls `MultiplexerDaemonClient.call()`. `MultiplexerDaemonClient.call()` first runs `connect()`, and `connect()` obtains an available daemon through `MultiplexerDaemonManager.ensureDaemon()`.

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

Spawn uses the current Node executable to start `multiplexer/daemon/entry.js` as a detached child with `stdio: "ignore"`, then calls `unref()`. Startup arguments include discovery/lock paths, protocol versions, control port, heartbeat, daemonVersion, capabilities, legacy driver dir, idle timeout, WebSocket config, and daemon-side `PhysicalConnectorOption`.

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
- Maintaining legacy `LatestDriverProcess` owner state.
- Managing idle timeout and shutdown handlers.

## 8. Control Protocol

### 8.1 RPC

Control RPC methods are defined by `ControlRpcMethod`:

| RPC | Purpose |
|---|---|
| `connectDevices` | Start physical device discovery and return device snapshots. |
| `getDevices` | Read device snapshots from the daemon's current physical connection state. |
| `connectUsbClients` | Start the runtime client watcher for a device and return client snapshots. |
| `startWatchClient` | Start the runtime client watcher for a single device. |
| `stopWatchClient` | Stop the runtime client watcher for a single device and clear that device's watcher state. |
| `disconnectDevice` | Disconnect a device. |
| `reacquireLegacyOwnership` | Let the daemon claim the legacy `LatestDriverProcess` owner again. |
| `shutdownDaemon` | Request graceful daemon shutdown, used by replacement/yield. |
| `startWSServer` | Start the WebSocket server inside the daemon. |
| `startWatchAllClients` | Start runtime client watchers for all current devices. |
| `sendMessageToWeb` | Broadcast a message to WebSocket Driver frontends. |
| `sendMessageToApp` | Send a message from control or WebSocket frontend to runtime. |
| `sendCustomizedMessage` | Build a Customized CDP/App request and wait for response. |
| `sendRawMessage` | Forward a raw request-response message to `PhysicalConnector.sendRawMessage`. |
| `sendMessage` | Forward a fire-and-forget message to runtime. |
| `closeClient` | Close a runtime client. |

RPC requests and responses both contain `kind` and `id`. Requests can also contain `meta.protocolVersion`, `clientVersion`, and `capabilities`. `MultiplexerDaemonClient` has a default RPC timeout of 5000 ms. If RPC params contain a positive `timeout`, the effective timeout is `max(rpcTimeout, timeout + 1000ms)`.

### 8.2 Event

`ControlEvent` currently defines:

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

After a control connection is established, Host first sends a `snapshot` to that control id. The current Host actually broadcasts these incremental events: `legacy-ownership-changed`, device connected/disconnected, USB runtime client connected/disconnected, and `usb-client-message`. `DebugRouterConnector.applyHostEvent()` also has compatibility branches for WebSocket client events, but daemon-side `WebSocketController` calls the optional `WebSocketControllerHost.emit`, and `MultiplexerHost` currently does not implement that `emit` method. Therefore WebSocket app/web client connection events are only used inside the daemon for active Driver frontend counting and are not synchronized as connector-side WebSocket client mirrors.

`DebugRouterConnector.applyHostEvent()` synchronizes received events into local mirrors and continues to emit old event names, such as `device-connected`, `client-connected`, `app-client-connected`, and `usb-client-message`.

## 9. Connector-side Mirror Objects

`MultiplexerDevice` is a device proxy object in the connector process. It stores daemon snapshots and operates on the real daemon-side device through RPC:

- `startWatchClient()` -> `startWatchClient`
- `stopWatchClient()` -> `stopWatchClient`
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

All sending methods are converted into daemon RPCs. `handleMessage()` only handles `usb-client-message` events from the daemon: CDP/App notifications trigger local events by method, while request-response replies are handled by the daemon-side route table.

Local mirror synchronization rules:

1. On `snapshot`, synchronize device/client Maps from the snapshot and remove local objects that are not in the snapshot.
2. On `device-connected` or `client-connected`, upsert the local object.
3. On disconnect events, remove the local object and emit compatibility events.
4. When the daemon control socket disconnects, clear device, USB client, and cached WebSocket client mirrors, then schedule desired-state recovery.

## 10. WebSocket Frontend Path

`WebSocketController` has been decoupled from the concrete `DebugRouterConnector` class and depends on the structural `WebSocketControllerHost`. In the current Multiplexer implementation, that host is the daemon-side `MultiplexerHost`.

`startWSServer` RPC runs inside the daemon:

1. Select a port from `websocketOption.port` or default `19783`, using `detect-port` to avoid conflicts.
2. Use `ip.address()` to build the host and return `WebSocketServerInfo`.
3. Create `WebSocketController` and listen on `/mdevices/page/android`.

WebSocket client handshake:

1. The server allocates a client id and sends `Initialize`.
2. The client replies with `Register`, including type and info.
3. Connections whose type is `Driver` are stored in `webClients`, representing HDT-style Web frontends.
4. Other types are stored in `websocketAppClients`, representing WiFi app clients.
5. Host maintains `activeWebSocketDriverIds` on connect/disconnect for idle detection. These connection events are not currently broadcast to connector control clients.

Message paths:

- Driver frontend sends `Customized` to USB runtime: `WebSocketClient` extracts the target `client_id`, calls `WebSocketController.sendMessageToApp(id, message, fromWebClientId)`, then enters `MultiplexerHost.handleWebSocketMessage()` and `PhysicalConnector.usbClients`.
- WebSocket app client sends a message to frontend: `WebSocketClient` calls `handleWebSocketAppMessage()`. The current Host passes it to `handlePhysicalMessage(appClientId, message)` to reuse inbound routing/broadcast logic.
- `ClientList` is triggered by Driver frontends and returns current WebSocket app clients and USB runtime clients. USB runtime clients use `network: "USB"`; WebSocket app clients use `network: "WiFi"`.

`sendMessageToWebClient(webClientId, message)` sends a matched request-response reply only to the original Driver frontend. `sendMessageToWeb(message)` is used for SDK-initiated event broadcast.

Current implementation boundaries:

- `WebSocketController` still keeps a compatibility branch that sends directly to `websocketAppClients` when `fromWebClientId` is missing.
- In the current daemon path, Driver frontend `Customized` messages carry `fromWebClientId`, so they enter Host unified routing.
- Host currently routes outbound messages through `PhysicalConnector.usbClients`; the completed local path is Driver frontend to USB runtime request-response isolation.
- WebSocket app clients appear in `ClientList`, but their connection events and independent request-response routing are not synchronized as connector control-client state. Full WiFi runtime bidirectional routing is not part of the currently completed path.

## 11. Message ID Rewriting and Routing

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
7. Call the real `UsbClient.sendMessage()` to send to SDK runtime.

Inbound handling:

1. Host receives a runtime message and parses the Customized payload.
2. If the payload has a safe integer ID, take the route from `PendingRouteTable` by global ID.
3. On route hit, restore the frontend original ID and restore sender/client_id to the real runtime client ID.
4. If a control route has `resolve`, it came from `sendCustomizedMessage()`; resolve with the extracted inner Customized message. Otherwise, send a `usb-client-message` event back to the specified control.
5. WebSocket routes use `sendMessageToWebClient(webClientId, message)` to send only to the original Driver frontend.
6. If a message has a response ID but no route matches, drop it to avoid leaking one frontend's response to other frontends.
7. If a message has no response ID, treat it as an SDK-initiated event: rewrite runtime client ID, then broadcast to WebSocket Driver frontends and control clients.

Route cleanup:

- When a control socket disconnects, call `clearByControlId(controlId)` and reject control routes.
- When a WebSocket frontend disconnects, call `clearByWebClientId(webClientId)`.
- When Host physical discovery resets or legacy owner is lost, clear all routes.

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
3. Stops current physical discovery state and clears devices and usbClients.
4. If `PhysicalConnector` can be recreated, closes the old physical connection and creates a new `PhysicalConnector`.
5. Publishes an empty snapshot and refreshes WebSocket `ClientList` / `DeviceList`.
6. Broadcasts `legacy-ownership-changed`, and the connector facade converts it into a `MultiOpenStatus.unattached` callback.

Before later `connectDevices()`, `startWatchAllClients()`, or desired-state recovery, the connector calls `reacquireLegacyOwnership` so the daemon claims owner again. This does not return to the old connector implementation; it only lets the daemon regain the owner file required by the legacy physical layer.

## 13. Fault Recovery and Shutdown

### 13.1 Daemon Crash or Control Socket Disconnect

After daemon crash, the connector's control socket closes. `MultiplexerDaemonClient.closeSocket()` rejects pending RPCs and notifies connection-state listeners. `DebugRouterConnector` receives disconnected state, clears local mirrors, then schedules desired-state recovery.

Recovery flow:

1. `daemonClient.connect()` ensures the daemon again.
2. If device discovery was previously requested, run `connectDevices(-1, null, isAutoListenClients)` again.
3. If `startWatchAllClients()` was previously requested, start all runtime watchers again.
4. If the WebSocket server was previously started, run `startWSServer()` again.

State recovery converges on daemon snapshot. Even if incremental events were lost, the full snapshot after reconnect overwrites local mirrors and realigns state.

| State | Owner | Recovery |
|---|---|---|
| Real device connection | Daemon-side `PhysicalConnector` | Daemon scans again and broadcasts snapshot. |
| Local `devices` / `usbClients` mirrors | Connector facade | Rebuilt from snapshot. |
| Connector pending RPC | Connector-side `MultiplexerDaemonClient` | Rejected when control socket disconnects; caller retries through existing logic. |
| pending route | Daemon-side `PendingRouteTable` | Created for request lifecycle; cleared on control/WebSocket disconnect, Host reset, or timeout. |
| WebSocket frontend connection | Daemon-side `WebSocketController` | Frontend reconnects after WebSocket disconnect; Driver connection count is only used for daemon idle detection. |

### 13.2 Daemon Idle Auto-shutdown

The public facade passes this default:

```text
multiplexerDaemonIdleTimeout = 600000ms
```

Host idle detection only counts two upper-layer consumers:

1. Control WebSocket connections, meaning connector API users.
2. WebSocket frontends whose type is `Driver`.

When both counts are 0, Host starts the idle timer. When the timer expires, Host calls the daemon idle handler. The daemon runs `stop()` and the entry process exits. If a new control connection or Driver frontend connects during the idle window, the timer is cancelled.

If `multiplexerDaemonIdleTimeout` is negative, non-finite, or not configured in an embedded scenario, Host does not enable idle auto-shutdown.

### 13.3 Daemon Replacement/Yield

When a connector finds an outdated or unhealthy daemon that must be replaced, Manager first requests graceful daemon shutdown through the `shutdownDaemon` RPC. Host calls its shutdown handler, and the daemon runs `stop()` to clean heartbeat, discovery, lock, control server, WebSocket server, and physical connector. Manager only tries SIGTERM/SIGKILL if the daemon does not exit in time.

### 13.4 Unknown Response ID

When Host receives a runtime response with a valid response ID but no matching route, it drops the message and does not broadcast it. This avoids leaking one frontend's request-response reply to other frontends.

## 14. Configuration and Compatibility

Current Multiplexer-related `DebugRouterConnectorOption` fields:

| Option | Purpose |
|---|---|
| `multiplexerDaemonIdleTimeout` | Daemon idle shutdown timeout. Facade default is 600000 ms. |
| `multiplexerStartupTimeout` | Timeout for waiting for daemon readiness. Default is 5000 ms. |
| `multiplexerStaleTimeout` | Timeout for judging discovery heartbeat as stale. Facade default is 5000 ms. |
| `multiplexerRpcTimeout` | Default control RPC timeout. Default is 5000 ms. |
| `multiplexerRootDir` | Multiplexer root directory. Default is `~/.DebugRouterConnector`. |
| `multiplexerDataDir` | Multiplexer data directory. Takes precedence over root dir. |
| `multiplexerDaemonEntry` | Daemon entry js path, used by tests or special packaging scenarios. |
| `multiplexerLegacyDriverDir` | Directory containing the legacy `LatestDriverProcess`. |
| `websocketOption.port` | Desired daemon WebSocket server port. Default is 19783. |
| `websocketOption.roomId` | Room id returned by WebSocket `RoomJoined`. |

Original physical options are passed to the daemon-side `PhysicalConnector`, including `manualConnect`, `enableWebSocket`, `enableAndroid`, `enableIOS`, `enableHarmony`, `enableDesktop`, `enableNetworkDevice`, `adbHostPort`, `hdcHostPort`, `usbConnectOpt`, and `networkDeviceOpt`. `reportService` is not passed to the daemon-side physical connector; the facade still initializes report service.

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
4. Later device, runtime client, and SDK message events are broadcast by the daemon to all control clients; WebSocket frontend connection state currently stays inside the daemon.

### 15.3 HDT Requests Runtime

1. Facade calls `startWSServer()`, and daemon starts the WebSocket server.
2. HDT registers as type `Driver` and enters `webClients`.
3. HDT sends `Customized` with target runtime `client_id`.
4. Host allocates a global ID for the CDP/App ID and records `webClientId + originalId + clientId`.
5. After runtime response, Host matches the route and restores the original ID and runtime client ID.
6. Host sends the response only to the original HDT web client.

### 15.4 SDK-initiated Event

1. Runtime sends a CDP/App notification without request ID.
2. Host recognizes it as an SDK-initiated event and rewrites runtime client ID.
3. If WebSocket is enabled, Host broadcasts it to all Driver frontends.
4. Host also broadcasts it to all control clients through `usb-client-message`.
5. Each connector facade dispatches the event into the corresponding `MultiplexerUsbClient` local event system.
