# DebugRouterConnector connection trace

## Overview

DebugRouterConnector can emit an append-only JSONL trace for connection
lifecycle events. The trace is intended for maintainers to restore the actual scene.

The recorder writes flat facts. These facts can be reconstructed into tree, grouped session, or diagnostic view by a trace analyzer tool.

Use the trace to answer questions such as:

- Was a device detected and registered by the connector?
- Which socket attempt actually received an SDK register message?

## Enabling trace output

Trace output can be enabled through the connector constructor:

```ts
import { DebugRouterConnector } from "@lynx-js/debug-router-connector";

const connector = new DebugRouterConnector({
  connectionTrace: {
    enabled: true,
    output: "/tmp/debug-router-trace.jsonl",
    bufferSize: 5000,
  },
});
```

It can also be enabled with the `DriverConnectionTracePath` environment
variable:

```sh
DriverConnectionTracePath=/tmp/debug-router-trace.jsonl node app.js
```

Recent in-memory records are available from the connector:

```ts
const records = connector.getConnectionTrace(2000);
```

Live records can be consumed with a listener:

```ts
const unsubscribe = connector.onConnectionTrace((record) => {
  traceQueue.push(record);
});

unsubscribe();
```

When a connector instance is no longer needed, close it so file trace output is
flushed and the owned trace sink is released:

```ts
await connector.close();
```

## JSONL record schema

Each output line is one complete JSON object. The current trace schema version is
`0.1`.

```ts
type ConnectionTraceRecord = {
  sequence: number;
  deviceId?: string;
  event: string;
  timestamp: string;
  traceSchemaVersion: "0.1";
  connectionAttemptId?: string;
  metadata?: Record<string, unknown>;
};
```

Common fields:

- `sequence`: Monotonically increasing number assigned by one recorder instance.
  Use it as the primary ordering field inside one trace file.
- `timestamp`: ISO timestamp captured when the record is emitted.
- `event`: Event name.
- `traceSchemaVersion`: Schema version for the record.
- `deviceId`: Connector-local device identifier when known. For Android this is
  usually the adb serial. Treat it as a correlation field, not as a globally
  stable identity.
- `connectionAttemptId`: UUID generated for one socket or transport attempt.
  It is created when `socket_connected` is recorded and reused by later events
  on the same attempt.
- `metadata`: Event-specific details such as `port`, `clientId`, `app`, `os`,
  `device`, `deviceModel`, and `sdkVersion`.

Compatibility note: schema `0.1` does not emit recorder-managed tree or session
fields such as `id`, `parentId`, `logicalSessionKey`, `traceSource`, or
`appSignature`.

## Event reference

| Event | Meaning |
| --- | --- |
| `device_plugged` | The platform device watcher observed a physical or daemon-level device attach/change event. |
| `device_unplugged` | The platform device watcher observed a physical or daemon-level device detach/offline event. |
| `device_registered` | The connector added the device to its device map and made it available to connector consumers. |
| `device_unregistered` | The connector removed the device from its device map. Socket and client teardown may still emit records after this event. |
| `client_watch_started` | The connector started watching candidate client ports for one device. |
| `client_watch_stopped` | The connector stopped the current client watch loop for one device. |
| `socket_connected` | A socket probe or transport connection succeeded. This does not mean the mobile SDK has registered. |
| `socket_disconnected` | A socket probe or transport connection closed or errored. |
| `sdk_register_received` | The connector received the SDK `Register` message. This is the first record that proves the socket speaks the debug-router protocol. |
| `usb_client_connected` | The connector created an internal `UsbClient` for a registered SDK connection. |
| `usb_client_disconnected` | The internal `UsbClient` was removed. |
| `usb_connection_closed` | The lower-level USB connection wrapper was closed. |
| `app_client_connected` | The registered USB client was emitted as an app client and is visible to connector consumers. |
| `app_client_disconnected` | The app client was removed from the consumer-visible client set. |
| `websocket_app_client_connected` | A WebSocket app client connected. |
| `websocket_app_client_disconnected` | A WebSocket app client disconnected. |
| `websocket_web_client_connected` | A WebSocket web client connected. |
| `websocket_web_client_disconnected` | A WebSocket web client disconnected. |

## USB connection timeline

Android USB connection normally probes multiple forwarded ports. A successful
socket probe is only a transport-level fact. The effective SDK connection is the
attempt that later emits `sdk_register_received`.

Compact example:

```jsonl
{"sequence":1,"deviceId":"android-serial-01","event":"device_plugged","timestamp":"2026-05-06T08:47:40.903Z","traceSchemaVersion":"0.1","metadata":{"os":"Android","event":"change","deviceType":"device"}}
{"sequence":2,"deviceId":"android-serial-01","event":"device_registered","timestamp":"2026-05-06T08:47:40.965Z","traceSchemaVersion":"0.1","metadata":{"os":"Android","title":"Pixel-7"}}
{"sequence":3,"deviceId":"android-serial-01","event":"client_watch_started","timestamp":"2026-05-06T08:48:04.825Z","traceSchemaVersion":"0.1","metadata":{"os":"Android","title":"Pixel-7"}}
{"sequence":4,"deviceId":"android-serial-01","event":"socket_connected","timestamp":"2026-05-06T08:48:04.826Z","traceSchemaVersion":"0.1","connectionAttemptId":"0d7d5964-9d20-4df1-bbb9-00f815818111","metadata":{"port":13001,"device":"Pixel-7","os":"Android"}}
{"sequence":5,"deviceId":"android-serial-01","event":"socket_connected","timestamp":"2026-05-06T08:48:04.827Z","traceSchemaVersion":"0.1","connectionAttemptId":"1cb52755-33a2-4f49-9059-af601f98c222","metadata":{"port":13101,"device":"Pixel-7","os":"Android"}}
{"sequence":6,"deviceId":"android-serial-01","event":"socket_connected","timestamp":"2026-05-06T08:48:04.828Z","traceSchemaVersion":"0.1","connectionAttemptId":"2fba8226-5b1e-4b55-88c8-e6f21bb91333","metadata":{"port":13201,"device":"Pixel-7","os":"Android"}}
{"sequence":7,"deviceId":"android-serial-01","event":"socket_disconnected","timestamp":"2026-05-06T08:48:04.835Z","traceSchemaVersion":"0.1","connectionAttemptId":"0d7d5964-9d20-4df1-bbb9-00f815818111","metadata":{"port":13001,"device":"Pixel-7","os":"Android"}}
{"sequence":8,"deviceId":"android-serial-01","event":"sdk_register_received","timestamp":"2026-05-06T08:48:04.857Z","traceSchemaVersion":"0.1","connectionAttemptId":"2fba8226-5b1e-4b55-88c8-e6f21bb91333","metadata":{"port":13201,"app":"com.example.demo","os":"Android","device":"Pixel-7","deviceModel":"Pixel 7","sdkVersion":"1.0.0"}}
{"sequence":9,"deviceId":"android-serial-01","event":"usb_client_connected","timestamp":"2026-05-06T08:48:04.857Z","traceSchemaVersion":"0.1","connectionAttemptId":"2fba8226-5b1e-4b55-88c8-e6f21bb91333","metadata":{"clientId":3,"port":13201,"app":"com.example.demo","os":"Android","device":"Pixel-7","deviceModel":"Pixel 7","sdkVersion":"1.0.0"}}
{"sequence":10,"deviceId":"android-serial-01","event":"app_client_connected","timestamp":"2026-05-06T08:48:04.857Z","traceSchemaVersion":"0.1","connectionAttemptId":"2fba8226-5b1e-4b55-88c8-e6f21bb91333","metadata":{"clientId":3,"port":13201,"app":"com.example.demo","os":"Android","device":"Pixel-7","deviceModel":"Pixel 7","sdkVersion":"1.0.0"}}
{"sequence":11,"deviceId":"android-serial-01","event":"client_watch_stopped","timestamp":"2026-05-06T08:48:04.857Z","traceSchemaVersion":"0.1","metadata":{"os":"Android","title":"Pixel-7"}}
```

In this example, three socket attempts were opened. Attempt
`0d7d5964-9d20-4df1-bbb9-00f815818111` disconnected without SDK
registration. Attempt `2fba8226-5b1e-4b55-88c8-e6f21bb91333` received
`sdk_register_received` and became the effective app client connection. Attempt
`1cb52755-33a2-4f49-9059-af601f98c222` is a transport-level probe that did not
register within the example window.

## How to correlate records

- Use `sequence` to reconstruct the recorder-local timeline.
- Use `deviceId` to group records for one connector-visible device.
- Use `connectionAttemptId` to group the records for one socket or transport
  attempt.
- Treat `sdk_register_received` as the boundary between a generic socket probe
  and a protocol-valid mobile SDK connection.
- Use `clientId` only after `usb_client_connected` or `app_client_connected`.
  It is assigned by the connector and is not stable across connector processes.
- Use `app`, `deviceModel`, `sdkVersion`, and other SDK-provided metadata as
  diagnostic labels. They are useful for display and filtering, but they are not
  guaranteed unique.
- Expect disconnect records to arrive after `device_unplugged` or
  `device_unregistered`. Device detection and socket/client teardown are
  asynchronous.

## Analyzer responsibilities

A trace analyzer should build diagnostic views from the flat JSONL records
without requiring the recorder to maintain derived structure. Useful views
include:

- Timeline view sorted by `sequence`.
- Device view grouped by `deviceId`.
- Connection-attempt view grouped by `connectionAttemptId`.
- Client view grouped by `clientId` after client creation.
- Protocol-success view that highlights attempts with
  `sdk_register_received`.
- Merged connector and SDK view once SDK-side tracing reports the same
  connection attempt identity.

Analyzers should tolerate partial traces. A file may end while sockets are still
open, while a device is still attached, or before async disconnect events have
arrived.

## Implementation notes

- `connectionAttemptId` is generated in the connector with
  `crypto.randomUUID()` when `socket_connected` is recorded.
- The recorder keeps only minimal runtime caches needed to fill later disconnect
  records with `deviceId`, `port`, and `connectionAttemptId`.
- Android devices normally have multiple candidate remote ports starting at
  `8901`. The connector forwards them to available local ports and probes each
  local port during client discovery.
- iOS uses usbmux tunneling instead of adb forwarding, but the trace still uses
  the same flat record model and connection-attempt correlation.
- WebSocket events are recorded in the same stream, but they do not normally
  carry USB-specific fields such as `deviceId`, `port`, or
  `connectionAttemptId`.

## Automated checks

The connector trace checks live under `test/e2e_test/connector_test`. They are
integration-level smoke tests for `DebugRouterConnector`; they intentionally use
public connector APIs instead of unit-level assertions over private recorder
classes.

Install the local package dependency before running them:

```sh
cd test/e2e_test/connector_test
npm install
```

Run the no-device checks with:

```sh
npm run test:without-device
```

This mode verifies:

- Device-manager-disabled behavior: `connectDevices()` and
  `connectUsbClients()` return empty results without throwing.
- A local fake app server through `NetworkDevice`: the connector discovers the
  network device, opens a socket, receives `Register`, creates a `UsbClient`,
  sends one public client message, and records connection trace events.

Run real-device checks with one of:

```sh
npm run test:with-device
npm run test:with-device:android
npm run test:with-device:ios
npm run test:with-device:harmony
```

`test:with-device` enables all supported mobile device managers. The platform
specific scripts restrict discovery to one platform. Real-device mode requires a
phone with the DebugRouter test app available. The Android script launches
`com.lynx.debugrouter.testapp/.MainActivity` by default; pass
`-- --no-launch-app` if the app is already running or a different app is being
used.

The real-device check verifies physical discovery, USB client registration,
public connector events, and trace integration. It does not duplicate the
existing large-message or frontend WebSocket routing scripts.
