# DebugRouterConnector connection trace

Connection trace records the boundaries needed to locate connection failures:
device discovery, device preparation, port probing, transport connection,
protocol registration, and consumer-visible clients. It does not reconstruct a
session tree or infer a root cause from missing events.

## Usage

```ts
const connector = new DebugRouterConnector({
  connectionTrace: {
    output: "/tmp/debug-router-trace.jsonl",
  },
});
await connector.close();
```

`DriverConnectionTracePath` can supply the output path. `enabled: false` disables
tracing even when the environment variable is set. Output is a file path only.
File output is append-only JSONL and is flushed by `close()`. Without an output
path, tracing stays disabled. File errors are logged without interrupting connections.

History queries (`getConnectionTrace`), subscriptions (`onConnectionTrace`),
custom writable streams, `bufferSize`, and `DriverConnectionTraceBufferSize`
have been removed. Read the JSONL file to inspect records.

## Record format

```ts
type ConnectionTraceNode = {
  sequence: number;
  event: "direct_discovery" | "direct_device" | "direct_watch"
       | "websocket_server" | "connection" | "client";
  reason: string;
  timestamp: string;
  traceSchemaVersion: "0.1";
  deviceId?: string;
  connectionAttemptId?: string;
  metadata?: Record<string, unknown>;
};
```

**Event names changed while the schema version remains `0.1`.** Consumers must
migrate to `event` plus `reason`; the version alone does not distinguish the old
format. Old event names are no longer emitted, and there is no compatibility
conversion or duplicate output. Only file output is supported; see the interface removals above.

- `sequence` orders records within one recorder instance, not across processes
  or instances appending to the same file.
- `reason` is a fixed value from the table below. Error messages belong in
  `metadata.error`, with `metadata.errorCode` when supplied by the source.
- `metadata.step` identifies an operation such as `initialize`, `watch`,
  `prepare`, `forward`, `device_info`, `connect`, `tunnel`, `socket`, or `register`.
- `metadata.transport` is `direct` or `websocket` for connection/client records.
  Direct includes Android/Harmony forwarding, iOS USB tunnels, and TCP connections
  to configured Network/Desktop devices; it does not necessarily mean USB.
- `metadata.role` is `app` or `debugger` for client records.
- Empty metadata is written as `{}`; fields whose values are `undefined` are omitted.
- App, model, and SDK details are recorded at `connection/register_received`.
  Client connected/disconnected records retain only `deviceId`,
  `connectionAttemptId`, and metadata containing `clientId`, `transport`, and
  `role`. Use `connectionAttemptId` to find registration details.
- `deviceId` identifies a connector-visible device. `clientId` is in metadata and
  is local to the connector instance. SDK app/model/version fields are labels,
  not unique identities.
- `connectionAttemptId` identifies the actual socket. Its registration, client,
  and termination records share that ID, including when the same device and port
  have overlapping old and new sockets. WebSocket attempts use IDs too.

## Six event categories

| Event | Reasons | Evidence |
| --- | --- | --- |
| `direct_discovery` | `disabled`, `started`, `snapshot`, `changed`, `failed`, `stopped` | Whether discovery is enabled and working; observed devices and their raw status. |
| `direct_device` | `preparing`, `registered`, `unregistered`, `failed` | Device preparation and membership in the connector device map. |
| `direct_watch` | `started`, `stopped` | When port scanning starts/stops; `started` lists the local ports. |
| `websocket_server` | `disabled`, `starting`, `listening`, `failed`, `closed` | Local WebSocket listener lifecycle and actual listening address. |
| `connection` | `connected`, `register_received`, `failed`, `closed` | WebSocket transport established, valid registration received, failure, or closure. |
| `client` | `connected`, `disconnected` | Application/debugger client becomes available to consumers or is removed. |

### Device discovery and preparation

Android records the first tracker batch as `snapshot` with `metadata.devices`,
including `[]` when no devices are reported. Later non-empty change sets retain
`added`, `changed`, and `removed` entries. Each entry has `deviceId` and `status`,
including `unauthorized` and `offline`; business registration filters do not hide
these states. The batch notification follows the tracker's individual callbacks,
so a device preparation record may precede its batch snapshot.

Harmony records its first raw target list and subsequent changed lists in
`metadata.devices`, including targets the registration code filters out. Unchanged
polls are not recorded. A failed HDC query is recorded as `failed`, not an empty
snapshot, even though the existing business code falls back to an empty list. The
next successful query is recorded again to make recovery visible. iOS records the usbmux listener acknowledgement and actual
attach/detach/error/close notifications. It does not claim an empty device list
when no notification has arrived. Network/Desktop devices come from configuration
and emit device registration records, not physical discovery events.

`direct_device` with `step: "forward"` summarizes successful local `ports` and
final `failures` after the existing forwarding retries. Each failure identifies
the remote port and last error. `reason: "failed"` can mean partial failure;
remaining working ports can still lead to a registered device and usable clients.
A successful forwarding summary uses `reason: "preparing"`: device preparation
has not yet finished at that point.

### Probes, connections, and clients

`direct_watch/started` records the local ports scanned by a controller once when
watching begins. TCP connections to forwarded ports can succeed even when no
application is listening on the device. Such probes, including ordinary errors
and closes before registration, produce no connection records. A direct socket
is recorded as successful only when a valid registration arrives:
`connection/register_received`, followed by `client/connected` when available.
Registered sockets still record one `connection/failed` or `connection/closed`
on termination. Actual protocol decode failures remain visible as
`connection/failed` with their step and error.

WebSocket connections retain `connection/connected` at transport establishment,
so a connection without registration remains visible. Neither transport's retry
or registration behavior changes.

Both WebSocket applications and debugger clients use these same connection and
client events. Their roles are distinguished by metadata. The old internal
`usb_client_connected`, `usb_client_disconnected`, and `usb_connection_closed`
events have been removed. The latter described a call to a wrapper's close method,
not proof that its socket had closed.

## Reading failures

| Evidence | What can be concluded |
| --- | --- |
| `direct_discovery/disabled` | This platform's discovery is disabled. |
| `direct_discovery/failed` | Discovery failed at the reported step; inspect its error. |
| Android/Harmony `snapshot` with `devices: []` | The discovery service returned an empty list at this time. |
| Device status `unauthorized` | A device was detected but is not authorized. |
| `direct_device/failed`, `step: forward` | Some or all forwarding attempts failed; inspect successful ports too. |
| `direct_watch/started` without registration | The listed ports are being scanned; no application has registered yet. |
| WebSocket `connection/connected` without registration | A WebSocket transport was established, but registration has not been observed. This alone does not establish an SDK fault. |
| WebSocket `listening` without a connection | The local server is listening. It cannot tell whether the remote endpoint never tried or the network blocked it. |
| `client/connected` | The registered client is visible to connector consumers. |

Treat traces as potentially partial. Missing later records are not fabricated
errors or timeouts. Disconnects can follow device removal because teardown is
asynchronous. Tracing does not change connection policies, retry timing, or the
registration protocol. It does not add WebSocket registration deadlines.
