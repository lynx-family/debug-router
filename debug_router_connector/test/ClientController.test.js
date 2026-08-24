// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const rewire = require("rewire");
const { packMessage } = require("../dist/cjs/src/usb/utils.js");
const {
  WebSocketClient,
} = require("../dist/cjs/src/websocket/WebSocketConnection.js");
const stableId = "stable-debug-router-id";
const register = packMessage({
  event: "Register",
  data: { info: { debugRouterId: stableId } },
});
class FakeSocket extends EventEmitter {
  constructor(all) {
    super();
    this.destroyed = false;
    all.push(this);
  }
  connect() {}
  connected() {
    this.writable = true;
    this.emit("connect");
  }
  destroy() {
    this.destroyed = true;
  }
  write() {}
}
test("keeps one device-port owner through Register and restores ClientList", (t) => {
  const sockets = [];
  const controllerModule = rewire("../dist/cjs/src/usb/ClientController.js");
  controllerModule.__set__("ClientAdapter_1", {
    default: adapterClass(sockets),
  });
  const deviceModule = rewire("../dist/cjs/src/device/BaseDevice.js");
  deviceModule.__set__("ClientController_1", {
    ClientController: controllerModule.ClientController,
  });
  const clients = new Map();
  let deleted = 0;
  let id = 0;
  const driver = {
    createClientId: () => ++id,
    regiserUsbClient: (client) => clients.set(client.clientId(), client),
    usbConnectOpt: { retryTime: 60_000 },
    unregiserUsbClient(clientId) {
      if (clients.delete(clientId)) deleted += 1;
    },
  };
  class Device extends deviceModule.BaseDevice {
    getHost() {
      return "";
    }
  }
  const device = new Device(driver, {
    os: "Android",
    serial: "device",
    title: "Android",
  });
  device.port = [8901];
  t.after(() => device.disConnect());
  device.startWatchClient();
  const controller = device.clientController;
  const first = sockets.at(-1);
  first.connected();
  device.startWatchClient();
  assert.equal(sockets.at(-1), first);
  first.emit("data", register);
  first.emit("error", new Error("closed"));
  first.emit("close", true);
  first.emit("data", register);
  assert.equal(clients.size, 0);
  assert.equal(deleted, 1);
  device.startWatchClient();
  const second = sockets.at(-1);
  second.connected();
  device.startWatchClient();
  assert.equal(sockets.at(-1), second);
  first.emit("data", register);
  first.emit("close", true);
  assert.equal(deleted, 1);
  assert.equal(second.destroyed, false);
  second.emit("data", register);
  const sent = [];
  WebSocketClient.prototype.handleListClients.call({
    clientId: () => 999,
    info: { id: 999, type: "Driver" },
    server: {
      getAllUsbClients: () => [...clients.values()],
      getAllWebsocketAppClients: () => [],
    },
    socket: { send: (message) => sent.push(message) },
  });
  const listed = JSON.parse(sent[0]).data;
  assert.equal(listed[0].info.debugRouterId, stableId);
  device.disConnect();
  assert.equal(second.destroyed, true);
  assert.equal(controller.sockets.size, 0);
});
test("rejects stale socket events and a late iOS tunnel", async () => {
  const sockets = [];
  let resolveTunnel;
  const tunnelPromise = new Promise((resolve) => (resolveTunnel = resolve));
  const Adapter = adapterClass(sockets, () => tunnelPromise);
  const listener = {
    onConnectionCreated: assert.fail,
    onConnectionDeleted() {},
  };
  const adapter = new Adapter({}, listener, 8901, "iOS", "device", "iOS", "");
  adapter.connect();
  adapter.destroy();
  const tunnel = new FakeSocket(sockets);
  resolveTunnel(tunnel);
  await tunnelPromise;
  assert.equal(tunnel.destroyed, true);
  assert.equal(tunnel.listenerCount("data"), 0);
});
function adapterClass(sockets, getTunnel) {
  const module = rewire("../dist/cjs/src/usb/ClientAdapter.js");
  class Socket extends FakeSocket {
    constructor() {
      super(sockets);
    }
  }
  module.__set__("net", { Socket });
  if (getTunnel) module.__set__("usbmux_1", { getTunnel });
  return module.default;
}
