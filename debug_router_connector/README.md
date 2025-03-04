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
import { DebugRouterConnector } from '@lynx-dev/debug-router-connector';

const connector = new DebugRouterConnector({
  manualConnect: true,
// When manualConnect is true, you need to call connectDevices to connect to the device
// and use connectUsbClients to connect USB clients.
// When manualConnect is false, DebugRouterConnector will automatically connect to devices and USB clients.
  enableWebSocket: false, // deprecated
  enableAndroid: true,
  enableIOS: true,
  enableDesktop: true,
  enableNetworkDevice: true,
  networkDeviceOpt: {
    ip: xx;
    port:[port];
  };
});
```

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

## Security

If you discover a potential security issue in this project, or believe you have found one, we kindly ask that you notify TikTok Security through our [security center](https://hackerone.com/tiktok) or via email at [vulnerability reporting email](security@tiktok.com). Your contributiong in ensuring the security of this project is greatly appreciated.

Please do **not** create a public GitHub issue.

## License

This project is licensed under the [Apache-2.0 License](LICENSE).
