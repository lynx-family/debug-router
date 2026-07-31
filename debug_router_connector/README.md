# DebugRouterConnector

## Background

DebugRouterConnector is an npm package implemented in TypeScript

- Provides the function of connecting to DebugRouter
- An interface for sending and receiving messages.

## DebugRouterConnector

### 1. Connect USB Device, Desktop Device, Network Device

- USB Device: android phone, iphone connected by USB
- Desktop Device: local device (mac, windows, linux)
- Network Device: a remote device (ip, port)

#### Connect to App

```js
import { DebugRouterConnector } from '@lynx-js/debug-router-connector';

const connector = new DebugRouterConnector({
  manualConnect: true,
// When manualConnect is true, you need to call connectDevices to connect to the device
// and use connectUsbClients to connect USB clients.
// When manualConnect is false, DebugRouterConnector will automatically connect to devices and USB clients.
  enableWebSocket: false, // deprecated
  enableAndroid: true,
  enableIOS: true,
  enableHarmony: true,
  enableDesktop: true,
  enableNetworkDevice: true,
  networkDeviceOpt: {
    ip: xx,
    port: [port],
  },
  connectionTrace: {
    enabled: true,
    output: "/tmp/debug-router-connection-trace.jsonl",
  },
});
```

#### Connection trace (optional)
Use `connectionTrace` to enable flat JSON-line connection logging, or set `DriverConnectionTracePath` to a file path. Each record includes a monotonically increasing `sequence`; socket-backed records also include `connectionAttemptId` for later trace analysis.

#### Get Connected Clients
You have two ways to get the connected clients.
##### The first way:
When you set the parameter `manualConnect` to true, you can call the connectDevices method to get a list of devices connected by DebugRouterConnector. 
Then, you can use the connectUsbClients method to get the clients of a specified device.

```js
// The connectDevices method requires a timeout parameter to wait for devices to connect.
// Once the timeout period expires, connectDevices will return all connected devices.
const devices = await connector.connectDevices(5000);

// The connectUsbClients method requires a timeout parameter to wait for clients to connect and a deviceId parameter to specify which device to connect to.
// Once the timeout period expires, connectUsbClients will return all connected clients of the specified device.
const clients = await connector.connectUsbClients(devices[0].serial, 5000);
```
##### The second way:
Regardless of whether manualConnect is true or false, you can listen to these events to get the status of devices and clients.
```js
connector.on('device-connected', (device) => {});
connector.on('device-disconnected', (device) => {});
connector.on('client-connected', (client) => {});
connector.on('client-disconnected', (clientId)=>{});
```

#### Send Message

```js
  // send sendCustomizedMessage
  // sessionId: -1 : This message is a global message.
  // sessionId > 0: This message is sent to a view.
  sendCustomizedMessage(method: string, params: Object = '', sessionId: number = -1, type: string = 'CDP'): Promise<string>

  // send ClientMessageHandler's message
  sendClientMessage(method: string, params: Object = {}): Promise<string>

```

#### RegisterEvent handler

```js
// This event is sent by DebugRouterEventSender.send in the app or as a CDP event sent by LynxDevTool.
client.on(event, (args...) => {});

```

## Debug Router CLI

The package installs a `debug-router` executable for machine-readable access to Android, iOS, Harmony, and Desktop targets. The CLI intentionally does not expose Network devices.

From a source checkout, install the CLI and shared Agent Skill with one command
from the repository root:

```bash
npm --prefix debug_router_connector run install:agents
```

The bootstrap installs dependencies, builds the package, installs the CLI
globally, installs the Skill, and verifies that the executable is available on
`PATH`. It never invokes `sudo`.

For a published package, keep CLI and Skill installation explicit:

```bash
npm install -g @lynx-js/debug-router-connector
debug-router install-skill
```

The package intentionally has no `postinstall` hook that writes to the user's
home directory.

```bash
debug-router list --platform android
debug-router send --client-id 'emulator-5554:8901' --type cdp --method Runtime.enable --params '{}'
debug-router listen --client-id 'emulator-5554:8901' --timeout 10000
debug-router install-skill
```

`list` and `send` write one JSON object to stdout. `listen` writes one JSON object per line. Logs and terminal errors are written to stderr. A stable CLI client ID combines the encoded device ID and Debug Router port; run `list` and copy exact IDs rather than using the Connector's process-local numeric ID.

CLI invocations serialize through a local lease and wait up to 60 seconds by default. Configure the bound with `--wait-timeout`. A listener without `--timeout` keeps the lease until interrupted. If another DebugRouterConnector takes ownership, the command fails with `CONNECTOR_PREEMPTED`. After explicit user approval, re-run the original command once with `--takeover`; this disrupts the other Connector and is never automatic.

`send --timeout` defaults to 5000 milliseconds. `send --session-id` is valid only for CDP and defaults to `-1`. App requests always use session ID `-1`.

`debug-router install-skill` installs Skill files but does not install the CLI
itself. It defaults to the shared Agents directory and supports these targets:

| Target | Destination |
| --- | --- |
| `agents` | `~/.agents/skills/debug-router` |
| `codex` | `${CODEX_HOME:-~/.codex}/skills/debug-router` |
| `claude` | `~/.claude/skills/debug-router` |
| `all` | All three destinations |

Use `--force` only to replace modified or unmanaged Skill files. A legacy
Claude Skill is preserved and reported when the default shared target is
installed; use `--target all` to update every destination explicitly.

## Security

If you discover a potential security issue in this project, or believe you have found one, we kindly ask that you notify TikTok Security through our [security center](https://hackerone.com/tiktok) or via email at [vulnerability reporting email](security@tiktok.com). Your contributiong in ensuring the security of this project is greatly appreciated.

Please do **not** create a public GitHub issue.

## License

This project is licensed under the [Apache-2.0 License](LICENSE).
