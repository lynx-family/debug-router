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
| Multiplexer daemon          | A local detached shared process composed of the process entry and `MultiplexerDaemonHost`. It is a deployment role rather than a standalone lifecycle class.                                                                                   |
| memoized notification query | An ID-less `Customized` query whose runtime reply is an SDK-initiated notification. The daemon can coalesce duplicate queries and briefly reuse the latest notification for the same runtime client.                                           |
| control client              | A daemon client created after a normal connector process registers over the local `node:net` control endpoint.                                                                                                                                 |
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
- `debug_router_connector/src/multiplexer/daemon/MultiplexerDaemonHost.ts`
- `debug_router_connector/src/multiplexer/daemon/MemoizedNotificationQueryTable.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerControlServer.ts`
- `debug_router_connector/src/multiplexer/daemon/MultiplexerControlConnection.ts`
- `debug_router_connector/src/multiplexer/daemon/PendingRouteTable.ts`
- `debug_router_connector/src/multiplexer/daemon/LegacyOwnershipGuard.ts`

Protocol and utilities:

- `debug_router_connector/src/multiplexer/protocol/control.ts`
- `debug_router_connector/src/multiplexer/protocol/debuginfo.ts`
- `debug_router_connector/src/multiplexer/protocol/event.ts`
- `debug_router_connector/src/multiplexer/protocol/index.ts`
- `debug_router_connector/src/multiplexer/protocol/snapshot.ts`
- `debug_router_connector/src/multiplexer/protocol/validation.ts`
- `debug_router_connector/src/multiplexer/transport/MultiplexerControlTransport.ts`
- `debug_router_connector/src/multiplexer/utils/paths.ts`
- `debug_router_connector/src/multiplexer/utils/FileLock.ts`

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
    MultiplexerDaemonManager ── starts / replaces ──────> daemon/entry.ts
    MultiplexerDaemonClient  ── fixed endpoint ─────────> MultiplexerControlServer

Multiplexer daemon process
  daemon/entry.ts
    MultiplexerDaemonHost
      MultiplexerControlServer
      PhysicalConnector ── USB ── SDK runtime / device
      WebSocketController ── WiFi / Driver frontend
```

The Multiplexer daemon is a process boundary, not an additional object layer. `entry.ts` adapts process startup and termination to one `MultiplexerDaemonHost`; Host composes and owns the control, physical, WebSocket, routing, and compatibility resources used by that process.

Connector processes no longer directly own real device watchers or SDK runtime/WebSocket connections. USB physical connections exist only in daemon-side `MultiplexerDaemonHost -> PhysicalConnector`, while daemon-side `WebSocketController` owns WiFi runtime and Driver frontend connections. Connector processes maintain local `MultiplexerDevice`, `MultiplexerUsbClient`, and `MultiplexerWebSocketClient` mirrors; WebSocket mirrors and events are exposed only to control clients that called `startWSServer()`.

### 4.2 Local State Directory

Default directory:

```text
~/.DebugRouterConnector/multiplexer/
  control.sock       # Unix-like only; Windows uses a named pipe
  spawn.lock/
    owner.json
```

`multiplexerRootDir` or `multiplexerDataDir` can override the path, mainly for tests, isolated runs, or special packaging scenarios.

The control endpoint is derived directly from the data directory. Unix-like platforms use `<dataDir>/control.sock`; Windows uses `\\.\pipe\<dataDir>` without hashing or path normalization. Custom Windows data directories are a debug/embedding responsibility and must already be valid for the intended named-pipe environment.

`spawn.lock` serializes daemon replacement, cleanup, and startup and is held only during the manager's ensure window. The daemon does not hold a runtime lock. Instead, Manager gives every spawned daemon an `argv0` marker derived from `dataDir`, then locates stale daemon pids through `find-process` when cleanup is required. Process identity is not part of normal health or control messages. There is no discovery file, heartbeat file, control port, daemon lock, or instance token.

## 5. Public `DebugRouterConnector` Facade

The `DebugRouterConnector` constructor creates:

1. `MultiplexerDiscovery`, which probes the fixed endpoint and classifies health/protocol compatibility.
2. `MultiplexerDaemonManager`, which handles ensure, spawn, replacement, health checks, and stale cleanup.
3. `MultiplexerDaemonClient`, which registers over the local control socket, sends RPCs, and receives events.
4. Local `DriverClient` and device, USB runtime, WiFi runtime, and WebSocket frontend mirror Maps. Connection trace is not created or owned by the facade.

If `manualConnect` is false, the constructor automatically calls `connectDevices()`. The Host reacquires the legacy `LatestDriverProcess` ownership inside `connectDevices()` and `startAllDeviceClientWatchers()`, so desired-state recovery restores ownership and physical watchers with one control RPC.

Current public facade behavior:

- `connectDevices()` sends a control RPC to let the daemon start physical device discovery, then upserts returned snapshots into local `MultiplexerDevice` objects.
- `connectUsbClients()` asks the daemon to start the runtime client watcher for a device, then upserts returned snapshots into local `MultiplexerUsbClient` objects.
- `getDevices()`, `getDeviceUsbClients()`, and `getAllUsbClients()` read from the local mirrors and wait for local events when necessary.
- `startWSServer()` asks the daemon to start the WebSocket server and mirrors returned `WebSocketServerInfo` into compatibility fields: `wssPort`, `wssHost`, `roomId`, and `wss.wssPath`.
- After a facade calls `startWSServer()`, it becomes a WebSocket-state requester. Host immediately sends it a targeted current snapshot, then targets later WebSocket lifecycle snapshots to the requester set. Physical lifecycle snapshots are broadcast to every control and may also contain WebSocket fields, but facades that did not request the WebSocket service ignore those fields and do not expose WebSocket messages or lifecycle events.
- `getAllWebsocketAppClients()` and `getAllAppClients()` continue to expose WiFi runtimes through `MultiplexerWebSocketClient` proxies. Proxy send and close operations become daemon RPCs.
- `sendMessageToWeb()` and `sendMessageToApp()` keep the original public call shape, but both forward through the daemon's unified `sendMessageWithoutReply` RPC.
- `disableAllClients()` and `addDeviceManager()` no longer operate on physical objects in the Multiplexer-only facade; they only log warnings.
- In the normal path, `close()` only closes the current Connector's control socket, removes subscriptions, and clears its WebSocket-server mirror. It does not directly close the shared daemon; daemon shutdown is controlled by idle timeout or shutdown/replacement flow. `forceRespawnDaemon` is a debug/test-only exception: closing such a Connector force-stops the current daemon and cleans its artifacts.

When the daemon control socket disconnects, the facade clears local mirrors, rejects pending RPCs, and schedules desired-state recovery after 100 ms: reconnect the daemon, restore device discovery, restore `startAllDeviceClientWatchers()`, and restore a previously requested WebSocket server.

## 6. Daemon Discovery, Startup, and Replacement

When `DebugRouterConnector` forwards some behavior to the daemon, it calls `MultiplexerDaemonClient.call()`. This method validates the method-specific RPC parameters and ensures an available daemon by default. Daemon replacement passes `ensureDaemon: false` to send the shutdown RPC without starting another daemon, while `sendRpc()` is the private send path after registration.

`MultiplexerDaemonClient.connect()` owns connection idempotency through its in-flight `connecting` Promise. Manager does not keep a second `ensureDaemon()` Promise; one production facade constructs one DaemonClient and one Manager, while different facades coordinate daemon startup through `spawn.lock`.

`MultiplexerDiscovery.probeHealth()` opens the fixed endpoint, sends a framed `{ kind: "health" }` first message, validates the framed `health-response`, and compares protocol versions. A normal health response contains `kind`, `ok`, `protocolVersion`, and `isInUse`; optional `debugInfo` remains diagnostic and is not used for cleanup or feature detection. `isInUse` follows the daemon idle-consumer definition: it is true when at least one registered Connector control client or Driver WebSocket frontend is connected. The temporary Health socket and WiFi runtime/app connections do not count.

Current default protocol constants:

```text
MULTIPLEXER_PROTOCOL_VERSION = 1
```

`MultiplexerDaemonManager` handles validation results as follows:

- `usable`: reuse immediately.
- `replace-required`: the daemon protocol is older and `isInUse` is false. Acquire `spawn.lock`, locate the marked daemon process, and request graceful shutdown through `shutdownDaemon`; if that same process does not exit, try SIGTERM/SIGKILL; then clean the stale Unix socket and start a new daemon.
- `daemon-upgrade-blocked-by-active-connections`: the daemon protocol is older but `isInUse` is true. Throw an error without acquiring `spawn.lock`, stopping the daemon, or replacing it.
- `unreachable`, `timeout`, `invalid-frame`, or `invalid-response`: acquire `spawn.lock`, locate the first process carrying the current data directory's daemon marker, stop it when still alive, clean the Unix socket, and spawn.

The initial health check is followed by up to three delayed retries for all four transient/unusable health outcomes. `usable`, `replace-required`, and `daemon-upgrade-blocked-by-active-connections` return immediately. In the normal ensure path, once `spawn.lock` is acquired, the manager does not probe again; the window after the initial probe is deliberately kept simple.

If the current Manager acquires `spawn.lock`, it owns the cleanup and spawn attempt. A subsequent `waitUntilReady()` failure therefore means the daemon it spawned did not become reusable, so the detailed error, including the last validation and last health error, is propagated to the caller.

If another Connector owns `spawn.lock`, the current Manager immediately returns to the outer `ensureDaemon()` loop without calling `waitUntilReady()`. The next `probeDaemonHealthWithRetry()` observes the other Manager's startup and already provides a short bounded retry window before another lock attempt. This keeps readiness polling in one place. An active older daemon remains a terminal result and is reported without replacement.

Important defaults:

```text
startupTimeout = 5000ms
readyPollInterval = 50ms
replacementTimeout = 1000ms
healthCheckTimeout = 500ms
spawnLockStaleTimeout = startupTimeout + replacementTimeout + 1000ms
```

Manager starts `multiplexer/daemon/entry.js` as a detached child process. A process marker derived from the Multiplexer data directory lets Manager identify the daemon during replacement or stale cleanup, but it is not part of the daemon's runtime protocol or Host configuration. Entry receives only the configuration required to construct Host, such as the control endpoint, protocol version, physical connection options, WebSocket settings, trace settings, and idle policy.

## 7. Daemon Process and Host

`entry.ts` is the adapter between process lifecycle and the daemon runtime. It parses Manager-provided configuration, installs daemon-local dependencies, constructs one `MultiplexerDaemonHost`, starts it, and coordinates process termination when Host or the operating environment requests shutdown.

The responsibility boundary is:

1. `MultiplexerDaemonManager` decides whether a daemon must be reused, started, replaced, or force-stopped.
2. `entry.ts` owns process construction and termination, and translates process-level configuration into one Host configuration.
3. `MultiplexerDaemonHost` owns startup, shutdown, and all runtime resources inside the daemon process.

There is no separate `MultiplexerDaemon` lifecycle wrapper. Host options are provided once at construction, and `host.start()` only activates the resources represented by that configuration. Host-requested idle or explicit shutdown is routed back to entry, which stops Host before ending the process.

Host composes its control server and WebSocket controller through small structural contracts. These contracts keep the subcomponents independently testable without making the core Host inherit from or explicitly implement server-side wrapper interfaces.

`MultiplexerDaemonHost` is the core daemon object. It is responsible for:

- Owning the real `PhysicalConnector`.
- Starting the fixed local control server and handling health/register first-message handshakes.
- Starting the WebSocket server that continues to use `/mdevices/page/android`.
- Managing device watchers, runtime client watchers, and WebSocket clients.
- Serializing snapshots and broadcasting control events.
- Rewriting message IDs, managing pending routes, and routing responses.
- Coalescing configured ID-less queries and briefly memoizing their notification replies per runtime client.
- Maintaining legacy `LatestDriverProcess` owner state.
- Managing idle timeout and shutdown handlers.

## 8. Control Protocol

### 8.1 Transport and First-message Handshake

The internal control plane uses Node.js `node:net`. Because a socket is a byte stream rather than a message transport, every JSON message is framed as the four ASCII bytes `$MUX`, a four-byte unsigned big-endian payload length, and that many UTF-8 JSON bytes. The transport uses `bufferpack` to encode and decode the header. While reading, it advances through interference bytes until it finds `$MUX`, then parses the length and payload; a header split across socket chunks remains buffered for the next read. The default maximum payload is 16 MiB and the maximum accumulated receive buffer is 32 MiB. Zero-length payloads, oversized frames/buffers, invalid JSON, and EOF with an incomplete frame close the transport with a diagnostic error.

`MultiplexerControlTransport.send()` writes one complete frame with `socket.write()`. It intentionally does not add an application-level write queue or a separate pause/resume backpressure state machine; ordering and system buffering are provided by `net.Socket`, while the control protocol enforces bounded frame and receive-buffer sizes.

The first framed message on a newly accepted socket must be one of:

- `health`: daemon replies with `health-response` and closes the short-lived probe connection.
- `register`: daemon replies with `register-response`, allocates a `controlId`, and promotes the socket to a long-lived RPC/event connection.

Any other first message receives `handshake-error-response`. After registration, only valid `ControlRpcRequest` messages are accepted. Socket `end` records an incomplete-frame error when needed and destroys the socket; upper layers receive their single close notification from the later socket `close` event.

### 8.2 RPC

Every request explicitly contains `kind`, `id`, `method`, and `params`. Even an RPC with no business parameters sends `params: {}`:

```ts
type ControlRpcRequest<M extends ControlRpcMethod> = {
  kind: "rpc";
  id: number;
  method: M;
  params: ControlRpcParams[M];
  debugInfo?: MultiplexerDebugInfo;
};
```

A successful response always contains `result`. RPCs without business result data use an explicit empty object rather than omitting the field:

```ts
type ControlRpcResponse<M extends ControlRpcMethod> =
  | {
      kind: "rpc-response";
      id: number;
      ok: true;
      result: ControlRpcResult[M];
      debugInfo?: MultiplexerDebugInfo;
    }
  | {
      kind: "rpc-response";
      id: number;
      ok: false;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
      debugInfo?: MultiplexerDebugInfo;
    };
```

The current method contracts are:

| RPC                            | Parameters                                          | Successful result     | Purpose                                                                      |
| ------------------------------ | --------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `connectDevices`               | `{ timeout?, serial?, isAutoListenClients? }`       | `DeviceSnapshot[]`    | Start physical discovery and return the current matching devices.            |
| `connectUsbClients`            | `{ deviceId, timeout?, waitTimeout?, clientName? }` | `ClientSnapshot[]`    | Start one device's runtime watcher and return the current matching runtimes. |
| `startDeviceClientWatcher`     | `{ deviceId }`                                      | `{}`                  | Start one device's runtime watcher without returning a snapshot.             |
| `stopDeviceClientWatcher`      | `{ deviceId }`                                      | `{}`                  | Stop one device's runtime watcher without disconnecting the device.          |
| `disconnectDevice`             | `{ deviceId }`                                      | `{}`                  | Disconnect one physical device.                                              |
| `shutdownDaemon`               | `{ reason? }`                                       | `{}`                  | Request graceful daemon shutdown for replacement or explicit shutdown.       |
| `startWSServer`                | `{}`                                                | `WebSocketServerInfo` | Start or reuse the WebSocket server and return `{ port, host, roomId? }`.    |
| `startAllDeviceClientWatchers` | `{}`                                                | `{}`                  | Watch all current devices and automatically watch later devices.             |
| `stopAllDeviceClientWatchers`  | `{}`                                                | `{}`                  | Stop all watchers and disable automatic watching for later devices.          |
| `sendMessageWithReply`         | `{ clientId, message: RequireMessageType }`         | `ResponseMessageType` | Send a request-response message to one USB or WiFi runtime.                  |
| `sendMessageWithoutReply`      | `{ target: "app" \| "web", clientId, message }`     | `{}`                  | Send a fire-and-forget message to an App runtime or WebSocket Driver.        |
| `closeClient`                  | `{ clientId }`                                      | `{}`                  | Close one USB or WiFi runtime client.                                        |

Single-device watching uses separate `startDeviceClientWatcher({ deviceId })` and `stopDeviceClientWatcher({ deviceId })` RPCs; `deviceId` must be non-empty and extra fields are rejected at runtime. All-device watching uses `startAllDeviceClientWatchers({})` and `stopAllDeviceClientWatchers({})`; the wire protocol has no `force` field. The public `DebugRouterConnector.startWatchAllClients(_force)` parameter remains only for source compatibility and is intentionally not forwarded. Stopping all watchers also disables `connectDevices()` auto-watch behavior for devices discovered later; either start RPC can enable watching again. `connectUsbClients` remains separate because it returns `ClientSnapshot[]`, while watcher RPCs return `result: {}`.

`startWSServer` never succeeds with an empty or missing result. It returns a concrete `WebSocketServerInfo`; if daemon WebSocket support is disabled, Host returns an RPC error with code `websocket-disabled`. `MultiplexerControlConnection.sendResponse()` is the single transport-level fallback that converts an internal `undefined` from no-result Host methods into the required wire value `result: {}`.

`sendCustomizedMessage` remains a public mirror-client API but is no longer a control RPC. `MultiplexerUsbClient` and `MultiplexerWebSocketClient` allocate the inner message id and assemble the legacy `Customized` envelope locally, send it through the `sendMessageWithReply` RPC, then read `response.data.data.message`. A string is returned directly; another defined JSON value is serialized before it is returned. This keeps one request-response transport RPC while preserving the existing public return types: `sendRawMessage` returns `ResponseMessageType`, while `sendCustomizedMessage` returns a string representation of the inner message.

`sendMessageWithoutReply` always uses the fixed `{ target, clientId, message }` shape. `{ target: "app", clientId, message }` sends to one USB or WiFi Runtime App, `{ target: "web", clientId, message }` sends to one Web Driver, and `{ target: "web", clientId: -1, message }` broadcasts to all Web Drivers. `target: "app"` rejects the `-1` broadcast sentinel because App broadcast is not supported. This explicit target domain prevents equal numeric App and Driver ids from redirecting a message to the wrong client kind.

`MultiplexerDaemonClient` validates the complete request before connecting and sending, and `MultiplexerControlConnection` validates it again on receipt. The client first accepts the common response envelope, then validates a successful `result` against the pending RPC's method. Recognized optional fields and most DTOs allow unknown additional fields for additive protocol evolution; exact no-parameter RPCs and the two single-device watcher parameter objects intentionally reject extra fields.

The default RPC timeout is 5000 ms. RPCs with a positive operation `timeout` use `max(rpcTimeout, timeout + 1000ms)`; RPCs without an operation timeout continue to use the default timeout, with no method-specific exception.

### 8.3 Event

`ControlEvent` currently defines:

```text
snapshot
legacy-ownership-changed
client-message
```

All three events use the same envelope, so transport handling can validate `kind`, `event`, optional diagnostics, and event-specific `data` independently:

```ts
type ControlEventEnvelope<Event extends string, Data> = {
  kind: "event";
  event: Event;
  data: Data;
  debugInfo?: MultiplexerDebugInfo;
};
```

After a control connection is established, Host first sends a `snapshot` to that control id. Every physical-device, USB-runtime, WebSocket-runtime, and WebSocket-Driver lifecycle change is represented by a new snapshot rather than a dedicated lifecycle event. The Connector diffs consecutive snapshots and emits the legacy public lifecycle events locally. Additions are reported in dependency order (device before runtime), while removals are reported in reverse dependency order (runtime and WebSocket clients before device).

`legacy-ownership-changed` is retained as an operational status event rather than a device/client lifecycle delta. Its data contains `status`, `ownerPid`, optional `previousOwnerPid`, and a reason. `client-message` carries transient traffic that cannot be reconstructed from state:

```ts
type LegacyOwnershipChangedEventData = {
  status: "attached" | "unattached";
  ownerPid: number;
  previousOwnerPid?: number;
  reason:
    | "daemon-started"
    | "legacy-preempted"
    | "reacquire-requested"
    | "stale-owner"
    | "invalid-owner";
};

type ClientMessageEventData = {
  source: "usb-runtime" | "websocket-runtime" | "websocket-driver";
  id: number;
  message: string;
};
```

Runtime routing is transport-independent: USB and WiFi share ID restoration, route lookup, targeted replies, unknown-response dropping, and notification fanout. WebSocket lifecycle changes trigger snapshots only for controls that requested `startWSServer()`. Physical lifecycle snapshots are broadcast and can include WebSocket arrays, and unsolicited WiFi runtime notifications can also traverse the shared control broadcast; non-requesting facades deliberately ignore WebSocket state and message sources. When an already-connected control requests the shared server, Host sends it a fresh targeted snapshot so existing WiFi runtimes and Drivers are mirrored immediately.

`DebugRouterConnector.applyHostEvent()` synchronizes snapshots into local mirrors and maps unified `client-message` sources back to compatibility event names such as `usb-client-message`, `ws-client-message`, and `ws-web-message`. The public Connector event surface therefore remains unchanged.

### 8.4 Snapshot

`snapshot` is the daemon's authoritative full state at one point in time, not an incremental change list:

```ts
type Snapshot = {
  protocolVersion: number;
  generatedAt: number;
  devices: DeviceSnapshot[];
  clients: ClientSnapshot[];
  websocketAppClients?: WebSocketClientSnapshot[];
  websocketWebClients?: WebSocketClientSnapshot[];
  debugInfo?: MultiplexerDebugInfo;
};

type DeviceSnapshot = DeviceDescription & {
  ports?: number[];
  host?: string;
};

type ClientSnapshot = ClientDescription;

type WebSocketClientSnapshot = {
  id: number;
  app: string;
  debugRouterVersion: string;
  deviceModel: string;
  network: "WiFi";
  osVersion: string;
  sdkVersion: string;
  type: string;
  raw_info: unknown;
};
```

`devices` and `clients` are always present. The two WebSocket arrays are optional because they are unavailable before the daemon-side WebSocket controller exists. Once present, each snapshot contains the complete current arrays; an empty array therefore means “the authoritative current set is empty,” not “there was no update.” `raw_info` is required on every `WebSocketClientSnapshot` and is preserved as opaque data.

The full-state model handles initial connection, late WebSocket requesters, reconnect, missed-event correction, and lifecycle ordering with one representation. Connector mirrors calculate additions and removals by comparing the new snapshot with their current Maps; no device/client connected or disconnected event is sent over the control protocol.

### 8.5 Diagnostic Context and Version Arbitration

`MultiplexerDebugInfo` may be attached to health/register handshakes, snapshots, RPC requests, RPC responses, and events:

```ts
type MultiplexerDebugInfo = {
  protocolVersion?: number;
  clientVersion?: string;
  daemonVersion?: string;
  processId?: number;
  timestamp?: number;
};
```

Every field is optional and diagnostic only. `processId` identifies the process that generated the context, and `timestamp` is its Unix timestamp in milliseconds. Ordinary `DebugRouterConnector` construction does not configure this context, so normal protocol messages omit `debugInfo`; internal embedding and tests can opt in, after which producers add current process and timestamp information. Consumers must not use `debugInfo` for feature detection or compatibility decisions.

Actual compatibility arbitration uses the required top-level `protocolVersion` in `health-response`. A normal health response carries no pid or instance token. Version strings used only for troubleshooting remain inside `MultiplexerDebugInfo` rather than appearing as standalone protocol fields.

### 8.6 Connection Trace Is Not a Control Protocol

Connection trace is daemon-owned and is not part of `snapshot` or the control protocol. `MultiplexerDaemonHost` is the only owner that constructs `ConnectionTraceRecorder` from `connectionTrace`, passes that same instance to the `PhysicalConnector` it creates, records whole-chain connection facts, and closes the recorder. It does not reuse a recorder from an injected `PhysicalConnector` or an incoming `traceRecorder` option. In addition to the legacy device, runtime, and WebSocket-client connection facts, Host records daemon lifecycle and stop triggers, control-socket connections, shared WebSocket-server lifecycle, and legacy-ownership acquisition or loss. Control-socket events include the `controlId` and the resulting active-connection count; server and ownership events carry their endpoint or owner metadata. The Connector facade no longer exposes `getConnectionTrace()` or `onConnectionTrace()`, and the daemon exposes no trace query/subscription RPC or trace control event. The recorder's existing buffer, listener, and query capabilities remain available internally for now but are not exposed across processes.

Trace configuration is daemon-startup-global. The first Connector that actually starts the daemon determines `connectionTrace`; later Connectors reuse that daemon and cannot replace its recorder configuration until the daemon restarts. The daemon constructs the recorder using the original `ConnectionTraceOptions` rules and `process.env.DriverConnectionTracePath`, so the default remains disabled when neither provides an output. A string `connectionTrace.output` is converted to an absolute path and serialized to the daemon. A `WritableStream` remains valid for an in-process `PhysicalConnector`, but cannot cross the Multiplexer process boundary, so the facade ignores that output and logs a warning while forwarding the other trace options. `MultiplexerDaemonManager` explicitly removes `traceRecorder` from daemon startup serialization; the daemon entry also rejects a manually supplied recorder instance.

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

`WebSocketController` has been decoupled from the concrete `DebugRouterConnector` class and depends on the structural `WebSocketControllerHost`. In the current Multiplexer implementation, that host is the daemon-side `MultiplexerDaemonHost`.

`startWSServer` RPC runs inside the daemon:

1. Start from the legacy default port `19783` and use `detect-port` to avoid conflicts. The public `websocketOption.port` field is retained but ignored, matching the legacy Connector behavior.
2. Use `ip.address()` to build the host and return `WebSocketServerInfo`.
3. Create `WebSocketController` and listen on `/mdevices/page/android`.

After startup, the shared WebSocket server remains running even when every control that requested it disconnects. Requester removal stops requester-targeted WebSocket snapshots and prevents that facade from exposing shared WebSocket state or messages; the server is closed together with the daemon during idle shutdown, explicit shutdown, or replacement.

WebSocket client handshake:

1. The server allocates a client id and sends `Initialize`.
2. The client replies with `Register`, including type and info.
3. Connections whose type is `Driver` are stored in `webClients`, representing WebSocket Driver frontends.
4. Other types are stored in `websocketAppClients`, representing WiFi app clients.
5. Host maintains `activeWebSocketDriverIds` on connect/disconnect for idle detection, and sends the latest WebSocket snapshot only to control clients that requested `startWSServer`.

Message paths:

- Driver frontend sends `Customized` to a target runtime: `WebSocketClient` extracts the target `client_id`, calls `WebSocketController.sendMessageToApp(id, message, fromWebClientId)`, and enters `MultiplexerDaemonHost.handleWebSocketMessage()`. Host selects either a WebSocket app client (WiFi) or `PhysicalConnector.usbClients` (USB) by client id.
- WebSocket app client sends a message to frontend: `WebSocketClient` calls `handleWebSocketAppMessage()`. Host passes it to the transport-independent `handleRuntimeMessage(appClientId, message, "websocket-runtime")`, so WiFi and USB share routing while retaining an explicit message source.
- `ClientList` is triggered by Driver frontends and returns current WebSocket app clients and USB runtime clients. USB runtime clients use `network: "USB"`; WebSocket app clients use `network: "WiFi"`.

`sendMessageToWebClient(webClientId, message)` sends a matched request-response reply only to the original Driver frontend. `sendMessageToWeb(message)` is used for SDK-initiated event broadcast.

Current implementation boundaries:

- `WebSocketController` still keeps a compatibility branch that sends directly to `websocketAppClients` when `fromWebClientId` is missing.
- In the current daemon path, Driver frontend `Customized` messages carry `fromWebClientId`, so they enter Host unified routing.
- Host unified outbound routing supports both `PhysicalConnector.usbClients` and `WebSocketController.websocketAppClients`; both runtime types share message-ID rewriting, pending routes, and targeted response delivery.
- `sendMessageWithReply` and `closeClient` remain Runtime-only RPC operations. The public `sendCustomizedMessage` helper reuses `sendMessageWithReply`. `sendMessageWithoutReply` selects the client identity domain first: `target: "app"` checks only WebSocket App and USB clients, while `target: "web"` routes only through the Web Driver controller, so overlapping numeric ids cannot redirect a message across domains.
- Runtime `Customized` messages are associated with the registered WebSocket app client id, so they still enter unified routing when the payload omits `sender`. `WebSocketClient` does not emit an eager duplicate message for this branch; Host emits the routed or broadcast result exactly once. Non-`Customized` runtime messages and Driver messages continue to use `client-message` with distinct sources; the facade's WebSocket requester state determines whether those messages are exposed publicly.
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
3. If `data.data.client_id` is non-zero/truthy, rewrite it according to the selected transport: USB receives `-1`, while a WiFi runtime receives its actual daemon-assigned `clientId`.
4. Recognize the Customized payload from `data.data.message`, supporting both string and object message forms.
5. Create a pending route only when the payload contains a safe integer `id`.
6. Host allocates `globalMessageId`, rewrites the original ID to the global ID, and writes the mapping into `PendingRouteTable`.
7. Select the real runtime by target client id and call `WebSocketClient.sendMessage()` for WiFi or `UsbClient.sendMessage()` for USB.

Inbound handling:

1. Host receives a runtime message and parses the Customized payload.
2. If the payload has a safe integer ID, `take()` the route from `PendingRouteTable` by global ID.
3. On route hit, restore the original request ID and produce two representations. The Web routing representation also rewrites `sender`/`client_id` to the real daemon-assigned runtime ID. The Connector compatibility representation preserves the restored request ID without exposing that Web identity rewrite.
4. If a control route has `resolve`, it came from `sendMessageWithReply()`; parse the Connector representation into a complete `ResponseMessageType` and restore its `client_id`. The Connector-side mirror extracts the inner message only when implementing its public `sendCustomizedMessage()` helper. Otherwise, send the Connector representation in a targeted `client-message` event, with source `usb-runtime` or `websocket-runtime`.
5. WebSocket routes use the Web representation with `sendMessageToWebClient(webClientId, message)`, so only the original Driver frontend receives it.
6. If a message has a response ID but no route matches, drop it to avoid leaking one frontend's response to other frontends.
7. If a message has no response ID, treat it as an SDK-initiated event. WebSocket Driver frontends and the notification cache use a representation rewritten with the real runtime ID; Connector controls receive the runtime's original message string byte-for-byte, while `client-message` separately carries the matching source and runtime ID.

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
    participant H as MultiplexerDaemonHost
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
3. Invalidates Host physical-discovery state and stops every device client watcher. `PhysicalConnector.devices` is preserved internally so an already-known device can be watched again after ownership is reacquired, but Host snapshots and getters hide all physical devices while ownership is unattached.
4. Closes and removes all USB runtime clients, and clears the selected runtime.
5. Actively closes and removes all WebSocket app/WiFi runtime clients, while retaining live WebSocket Driver frontend connections.
6. Publishes a snapshot from those authoritative Maps and refreshes WebSocket `ClientList` / `DeviceList`: only live Driver clients remain; devices and USB/WiFi runtimes are absent.
7. Broadcasts `legacy-ownership-changed`, and the connector facade converts it into a `MultiOpenStatus.unattached` callback.

There is no synthetic empty snapshot and no ownership-loss-only mirror reset. Host preserves the internal physical device table for later reacquisition, but serializes no physical devices or USB runtimes while unattached; it clears the USB/WiFi runtime Maps and serializes the retained Driver Map. WebSocket `ClientList` observes the same ownership-filtered USB state and WiFi runtime Map, and the facade reconciles all mirrors from that snapshot. Therefore `ClientList`, Host snapshot, and facade mirrors converge on one visible state even when a WiFi runtime and Driver frontend use the same numeric client id.

Later `connectDevices()`, `startAllDeviceClientWatchers()`, and desired-state recovery reacquire ownership inside the Host before restoring physical discovery. This does not return to the old connector implementation; it only lets the daemon regain the owner file required by the legacy physical layer.

## 13. Fault Recovery and Shutdown

### 13.1 Daemon Crash or Control Socket Disconnect

After daemon crash, the connector's control socket closes. `MultiplexerDaemonClient.closeSocket()` rejects pending RPCs and notifies connection-state listeners. `DebugRouterConnector` receives disconnected state, clears local mirrors, then schedules desired-state recovery.

Recovery flow:

1. `daemonClient.connect()` ensures the daemon again.
2. If device discovery was previously requested, run `connectDevices(-1, null, isAutoListenClients)` again.
3. If `startAllDeviceClientWatchers()` was previously requested, start all runtime watchers again.
4. If the WebSocket server was previously started, run `startWSServer()` again.

State recovery converges on daemon snapshot. Even if an earlier control message or snapshot was lost, the full snapshot after reconnect overwrites local mirrors and realigns state.

| State                                                   | Owner                                        | Recovery                                                                                                                                                                                                                          |
| ------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real device connection                                  | Daemon-side `PhysicalConnector`              | Daemon scans again and broadcasts snapshot.                                                                                                                                                                                       |
| Local device, USB runtime, and WebSocket client mirrors | Connector facade                             | Rebuilt from snapshot; the WebSocket portion is restored only for a facade that requests `startWSServer()` again.                                                                                                                 |
| Connector pending RPC                                   | Connector-side `MultiplexerDaemonClient`     | Rejected when control socket disconnects; caller retries through existing logic.                                                                                                                                                  |
| pending route                                           | Daemon-side `PendingRouteTable`              | Created for request lifecycle; cleared on control/WebSocket disconnect, Host reset, or timeout.                                                                                                                                   |
| memoized notification query                             | Daemon-side `MemoizedNotificationQueryTable` | Starts empty after daemon recovery and is repopulated opportunistically by matching runtime notifications; isolated by runtime client; cleared on runtime disconnect or Host/physical reset; stale entries are ignored after TTL. |
| WiFi runtime / WebSocket frontend connection            | Daemon-side `WebSocketController`            | The app/frontend reconnects after WebSocket disconnect; Driver count is used for daemon idle detection, while requester-targeted snapshots and facade-side filtering restore the WebSocket mirrors.                               |

### 13.2 Daemon Idle Auto-shutdown

The public facade passes this default:

```text
multiplexerDaemonIdleTimeout = 600000ms
```

Host idle detection only counts two upper-layer consumers:

1. Registered local control socket connections, meaning connector API users.
2. WebSocket frontends whose type is `Driver`.

When both counts are 0, Host starts the idle timer. When the timer expires, Host requests process shutdown through the handler installed by entry. Entry stops Host and then exits the daemon process. If a new control connection or Driver frontend connects during the idle window, the timer is cancelled.

WiFi runtime/app connections are not consumers for idle ownership. Connecting, disconnecting, or continuing to use a phone over WiFi does not cancel or restart the idle timer; without a Connector control client or Driver frontend, the daemon exits after the configured timeout and closes the shared WebSocket server as part of `stop()`.

If `multiplexerDaemonIdleTimeout` is negative, non-finite, or not configured in an embedded scenario, Host does not enable idle auto-shutdown.

### 13.3 Daemon Replacement/Yield

When a connector finds an idle outdated daemon or an unhealthy daemon that must be replaced, Manager identifies the process through the data directory's daemon marker and requests graceful shutdown through the control protocol when possible. Host forwards that request to entry; entry stops Host-owned resources and exits the process. If graceful shutdown cannot complete, Manager falls back to process-level termination and stale endpoint cleanup. An outdated daemon with an active Connector or Driver frontend is not stopped automatically. This flow does not rely on a daemon-owned discovery or lock file.

### 13.4 Unknown Response ID

When Host receives a runtime response with a valid response ID but no matching route, it drops the message and does not broadcast it. This avoids leaking one frontend's request-response reply to other frontends.

## 14. Configuration and Compatibility

Current Multiplexer-related `DebugRouterConnectorOption` fields:

| Option                         | Purpose                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `multiplexerDaemonIdleTimeout` | Daemon idle shutdown timeout. Facade default is 600000 ms.                                           |
| `multiplexerStartupTimeout`    | Timeout for waiting for daemon readiness. Default is 5000 ms.                                        |
| `multiplexerRpcTimeout`        | Default control RPC timeout. Default is 5000 ms.                                                     |
| `multiplexerRootDir`           | Multiplexer root directory. Default is `~/.DebugRouterConnector`.                                    |
| `multiplexerDataDir`           | Multiplexer data directory. Takes precedence over root dir.                                          |
| `multiplexerDaemonEntry`       | Daemon entry js path, used by tests or special packaging scenarios.                                  |
| `multiplexerLegacyDriverDir`   | Directory containing the legacy `LatestDriverProcess`.                                               |
| `enableWebSocket`              | Enables WebSocket exposure for this facade; daemon startup behavior is shared.                       |
| `connectionTrace`              | Daemon-global trace configuration; only serializable string output paths cross the process boundary. |
| `forceRespawnDaemon`           | Debug/test-only one-shot replacement using this Connector's exact options.                           |
| `websocketOption.port`         | Retained for the legacy option shape but ignored; selection starts at 19783.                         |
| `websocketOption.roomId`       | Room id returned by WebSocket `RoomJoined`.                                                          |

`MultiplexerDaemonHostOption.memoizedNotificationTtlMs` controls the daemon-side pending and cache TTL and defaults to 1000 ms. It is currently an internal Host option used for embedding and deterministic tests, not a public `DebugRouterConnectorOption` propagated through daemon startup.

The daemon-side `PhysicalConnector` receives transport endpoints and serializable options such as `adbHostPort`, `hdcHostPort`, `usbConnectOpt`, `networkDeviceOpt`, and `connectionTrace`. In the normal shared-daemon path, generally available platform options are enabled in the daemon and each Connector filters the devices, clients, snapshots, and events it exposes according to its own option flags. Only `forceRespawnDaemon` makes the replacement daemon use that Connector's `manualConnect`, WebSocket, and platform enable flags exactly. The daemon entry validates `connectionTrace.enabled` as boolean, `connectionTrace.output` as a string path, and `connectionTrace.bufferSize` as a non-negative finite number; recorder instances are rejected. `reportService` is not serialized across the process boundary; the daemon creates its own local report service.

The public facade no longer treats `enableMultiplexer`, `enableProxy`, `proxyDaemonIdleTimeout`, or `DEBUG_ROUTER_PROXY*` as compatibility entries. Callers should use the `multiplexer*` naming.

Protocol compatibility rules:

1. `daemon.protocolVersion === connector.protocolVersion`: reuse directly.
2. `daemon.protocolVersion > connector.protocolVersion`: reuse the newer daemon; the Connector only calls RPCs and events it knows.
3. `daemon.protocolVersion < connector.protocolVersion` and `daemon.isInUse === false`: connector treats the daemon as outdated and runs replacement.
4. `daemon.protocolVersion < connector.protocolVersion` and `daemon.isInUse === true`: connector reports that active connections block the upgrade and leaves the daemon running.

## 15. Typical Flows

### 15.1 First Connector Startup

1. Facade creates discovery, manager, and daemon client.
2. `connectDevices()` triggers `daemonClient.connect()`.
3. Health probe cannot reach the fixed endpoint, so Manager acquires `spawn.lock`.
4. Manager spawns detached daemon entry.
5. Entry constructs and starts Host; Host starts the control server at the fixed endpoint without holding a runtime lock.
6. Connector sends `register`, receives `register-response`, and then receives the initial `snapshot`.
7. Facade uses the `connectDevices` RPC to ask Host to start physical device discovery.

### 15.2 Later Connector Startup

1. Facade probes the fixed local endpoint with a framed `health` request.
2. Health and protocol arbitration succeed, so it registers with the existing control server.
3. The new control connection receives current snapshot.
4. Later physical-device and USB-runtime lifecycle changes are broadcast as snapshots to all control clients. USB/WiFi runtime routing shares one processing strategy and emits `client-message` with the matching source. Connector facades expose WebSocket lifecycle and message state only after requesting `startWSServer()`.

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

| Layer                             | Current coverage                                                                                                                                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                              | Control framing/limits/invalid input, first-message handshake, health classification/retry, Host routing, WebSocket parsing/error containment, requester-scoped mirrors, `MultiplexerWebSocketClient`, connection trace ownership, overlapping client ids, and ownership-loss state cleanup. |
| Integration                       | Fixed-endpoint daemon discovery, concurrent daemon startup, version replacement, reconnect/snapshot convergence, routing isolation, daemon idle lifecycle, daemon-owned connection trace, WiFi runtime behavior, and legacy ownership preemption/reacquire.                                  |
| Package-entry E2E without devices | Shared daemon/facade behavior, WebSocket routing, WiFi runtime registration and proxy APIs, Driver preservation during ownership loss, and snapshot/`ClientList` convergence.                                                                                                                |
| Real-device USB E2E               | Android/iOS discovery, runtime watcher recovery, request-response routing, legacy ownership preemption, and stress/churn flows through `real_device.js` and `real_device_stress.js`.                                                                                                         |
| Real-device WiFi E2E              | Android WiFi registration, public lifecycle/mirrors, Driver and Connector round trips, proxy calls, and disconnect cleanup through `real_device_wifi.js`.                                                                                                                                    |

Protocol validator unit tests cover every RPC method's parameter and method-aware result branch, all three control event variants, snapshot DTOs, optional diagnostic fields, malformed envelopes, and the exact empty-object contracts. This keeps the MR1 protocol foundation independently reviewable before the later daemon and facade implementation slices.

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
