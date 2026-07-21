// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("node:assert/strict");
const net = require("node:net");
const { afterEach, test } = require("node:test");

const { BaseDevice } = require("../dist/cjs/src/device/BaseDevice.js");
const {
  DebugRouterConnector,
} = require("../dist/cjs/src/connector/DebugRouterConnector.js");
const ClientAdapter = require("../dist/cjs/src/usb/ClientAdapter.js").default;
const { ClientController } = require("../dist/cjs/src/usb/ClientController.js");
const usbmux = require("../dist/cjs/third_party/usbmux/lib/usbmux.js");

const originalAutoFind = process.env.DriverAutoFindClientsEnv;
const originalAdapterConnect = ClientAdapter.prototype.connect;
const originalGetTunnel = usbmux.getTunnel;
const originalSocket = net.Socket;

afterEach(() => {
  ClientAdapter.prototype.connect = originalAdapterConnect;
  net.Socket = originalSocket;
  usbmux.getTunnel = originalGetTunnel;
  if (originalAutoFind === undefined) {
    delete process.env.DriverAutoFindClientsEnv;
  } else {
    process.env.DriverAutoFindClientsEnv = originalAutoFind;
  }
});

test("reuses an idle/active attempt and replaces it only after close", () => {
  const driver = createDriver();
  const controller = new ClientController(driver, createDevice());
  const adapter = createAdapter("idle");
  const replacement = createAdapter("idle");
  let createCount = 0;

  controller.sockets = new Map([[8901, adapter]]);
  controller.ports = new Map([[8901, false]]);
  controller.createAdapter = () => {
    createCount++;
    return replacement;
  };

  controller.watchClient();
  assert.equal(createCount, 0);
  assert.equal(adapter.connectCount, 1);
  assert.equal(adapter.destroyCount, 0);
  controller.watchClient();
  assert.equal(createCount, 0);
  assert.equal(adapter.destroyCount, 0);

  adapter.setState("closed");
  controller.watchClient();
  controller.watchClient();
  assert.equal(createCount, 1);
  assert.equal(adapter.destroyCount, 1);
  assert.equal(replacement.connectCount, 1);
  assert.equal(replacement.destroyCount, 0);
  assert.equal(controller.sockets.get(8901), replacement);
});

test("marks an Android attempt closed when connect throws synchronously", () => {
  const adapter = createClientAdapter("Android");
  net.Socket = class {
    on() {
      return this;
    }
    connect() {
      throw new Error("connect failed");
    }
    destroy() {}
  };

  adapter.connect();

  assert.equal(adapter.isAttemptActive(), false);
  assert.equal(adapter.isClosed(), true);
});

test("marks an iOS attempt closed when tunnel creation rejects", async () => {
  const adapter = createClientAdapter("iOS");
  usbmux.getTunnel = () => Promise.reject(new Error("tunnel failed"));

  adapter.connect();
  assert.equal(adapter.isAttemptActive(), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(adapter.isAttemptActive(), false);
  assert.equal(adapter.isClosed(), true);
});

test("a late iOS tunnel is destroyed after its controller attempt closes", async () => {
  const tunnelResult = deferred();
  const tunnel = {
    destroyCount: 0,
    writeCount: 0,
    destroy() {
      this.destroyCount++;
    },
    write() {
      this.writeCount++;
    },
  };
  let registered = 0;
  const adapter = new ClientAdapter(
    createDriver(),
    {
      onConnectionCreated() {
        registered++;
        return 7;
      },
      onConnectionDeleted() {},
    },
    8901,
    "device",
    "serial",
    "iOS",
    "127.0.0.1",
  );
  usbmux.getTunnel = () => tunnelResult.promise;

  adapter.connect();
  adapter.destroy();
  tunnelResult.resolve(tunnel);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(tunnel.destroyCount, 1);
  assert.equal(tunnel.writeCount, 0);
  assert.equal(registered, 0);
  assert.equal(adapter.isClosed(), true);
});

test("Initialize failure closes the attempt instead of leaving it active", () => {
  for (const socket of [
    {
      destroyed: false,
      writable: false,
      destroy() {},
      write() {
        throw new Error("must not write");
      },
    },
    {
      destroyed: false,
      writable: true,
      destroy() {},
      write() {
        throw new Error("write failed");
      },
    },
  ]) {
    const deleted = [];
    const adapter = createClientAdapter("Android", deleted);
    adapter.state = "active";
    adapter.tcpClient = socket;

    adapter.onConnect();

    assert.equal(adapter.isAttemptActive(), false);
    assert.equal(adapter.isClosed(), true);
    assert.deepEqual(deleted, [0]);
  }
});

test("close destroys every adapter and unregisters each route exactly once", () => {
  const driver = createDriver();
  const controller = new ClientController(driver, createDevice([8901, 8902]));
  const firstAdapter = createAdapter("active");
  const secondAdapter = createAdapter("active");

  controller.sockets = new Map([
    [8901, firstAdapter],
    [8902, secondAdapter],
  ]);
  controller.connections = new Map([[7, {}]]);
  controller.clientInfos = new Map([[7, 8901]]);
  controller.ports = new Map([
    [8901, true],
    [8902, false],
  ]);

  controller.close();
  controller.close();
  controller.onConnectionDeleted(7);

  assert.deepEqual(driver.unregistered, [7]);
  assert.equal(firstAdapter.destroyCount, 1);
  assert.equal(secondAdapter.destroyCount, 1);
  assert.equal(controller.sockets.size, 0);
  assert.equal(controller.connections.size, 0);
  assert.equal(controller.clientInfos.size, 0);
  assert.equal(controller.ports.size, 0);
});

test("a late Register cannot publish a route after controller close", () => {
  const driver = createDriver();
  const controller = new ClientController(driver, createDevice());
  let connectionCloseCount = 0;
  const connection = {
    close() {
      connectionCloseCount++;
    },
  };

  controller.close();
  const id = controller.onConnectionCreated(connection, 8901, {});

  assert.equal(id, 0);
  assert.equal(connectionCloseCount, 1);
  assert.equal(controller.connections.size, 0);
  assert.equal(driver.registered.length, 0);
});

test("Android error then close cannot unregister a replacement route", async () => {
  class FakeSocket extends require("node:events") {
    connecting = false;
    destroyed = false;
    writable = true;
    connect() {}
    destroy() {
      this.destroyed = true;
    }
    end() {}
    write() {
      return true;
    }
  }
  net.Socket = FakeSocket;
  const driver = createDriver();
  let nextId = 6;
  driver.createClientId = () => ++nextId;
  const controller = new ClientController(driver, createDevice());
  const register = JSON.stringify({
    data: { info: { App: "app", sdkVersion: "1.0" } },
    event: "Register",
  });

  controller.watchClient();
  const oldAdapter = controller.sockets.get(8901);
  const oldSocket = oldAdapter.tcpClient;
  await oldAdapter.handleConnection(register);
  assert.equal(oldAdapter.id, 7);

  oldSocket.emit("error", new Error("old connection failed"));
  controller.watchClient();
  const newAdapter = controller.sockets.get(8901);
  await newAdapter.handleConnection(register);
  assert.equal(newAdapter.id, 8);

  oldSocket.emit("close", true);

  assert.deepEqual(driver.unregistered, [7]);
  assert.equal(controller.connections.has(7), false);
  assert.equal(controller.connections.has(8), true);
  assert.equal(controller.sockets.get(8901), newAdapter);
  controller.close();
});

test("same ports reuse the controller; changed ports close it before reconnect", () => {
  process.env.DriverAutoFindClientsEnv = "false";
  const driver = createDriver();
  const connectedPorts = [];
  let oldAdapter;
  ClientAdapter.prototype.connect = function () {
    if (this.port === 8902) {
      assert.equal(oldAdapter.isClosed(), true);
      assert.deepEqual(driver.unregistered, [7]);
    }
    connectedPorts.push(this.port);
    this.state = "active";
  };
  const device = new TestDevice(driver, [8901]);

  device.startWatchClient();
  const oldController = device.controller;
  oldAdapter = oldController.sockets.get(8901);
  device.startWatchClient();
  assert.equal(device.controller, oldController);
  oldController.connections.set(7, {});
  oldController.clientInfos.set(7, 8901);
  oldController.ports.set(8901, true);

  device.setPorts([8902]);
  device.startWatchClient();

  assert.notEqual(device.controller, oldController);
  assert.deepEqual(connectedPorts, [8901, 8902]);
  assert.equal(oldAdapter.isClosed(), true);
  assert.deepEqual(driver.unregistered, [7]);
  assert.equal(oldController.sockets.size, 0);
  assert.equal(oldController.connections.size, 0);
  assert.equal(device.controller.matchesPorts([8902]), true);
  device.disConnect();
});

test("driver takeover destroys a pending adapter before ownership resumes", () => {
  process.env.DriverAutoFindClientsEnv = "false";
  const connectedPorts = [];
  ClientAdapter.prototype.connect = function () {
    connectedPorts.push(this.port);
    this.state = "active";
  };
  const device = new TestDevice(createDriver(), [8901]);
  const connector = {
    devices: new Map([[device.serial, device]]),
    getAllAppClients: () => [],
  };

  device.startWatchClient();
  const oldController = device.controller;
  const pendingAdapter = oldController.sockets.get(8901);
  DebugRouterConnector.prototype.disableAllClients.call(connector);

  assert.equal(pendingAdapter.isClosed(), true);
  assert.equal(device.controller, undefined);

  device.startWatchClient();
  assert.notEqual(device.controller, oldController);
  assert.deepEqual(connectedPorts, [8901, 8901]);
  assert.equal(device.controller.sockets.size, 1);
  device.disConnect();
});

function createAdapter(initialState) {
  let state = initialState;
  return {
    connectCount: 0,
    destroyCount: 0,
    connect() {
      this.connectCount++;
      state = "active";
    },
    destroy() {
      this.destroyCount++;
      state = "closed";
    },
    isAttemptActive() {
      return state === "active";
    },
    isClosed() {
      return state === "closed";
    },
    setState(nextState) {
      state = nextState;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createDevice(ports = [8901]) {
  return {
    getHost: () => "127.0.0.1",
    info: { os: "Android", serial: "serial", title: "device" },
    ports,
  };
}

function createDriver() {
  return {
    createClientId: () => 7,
    registered: [],
    regiserUsbClient(client) {
      this.registered.push(client);
    },
    unregistered: [],
    unregiserUsbClient(id) {
      this.unregistered.push(id);
    },
    usbConnectOpt: { retryTime: 1_000 },
  };
}

function createClientAdapter(type, deleted = []) {
  return new ClientAdapter(
    createDriver(),
    {
      onConnectionCreated: () => 7,
      onConnectionDeleted(id) {
        deleted.push(id);
      },
    },
    8901,
    "device",
    "serial",
    type,
    "127.0.0.1",
  );
}

class TestDevice extends BaseDevice {
  constructor(driver, ports = []) {
    super(driver, { os: "Android", serial: "serial", title: "device" });
    this.port = ports;
  }

  get controller() {
    return this.clientController;
  }

  getHost() {
    return "127.0.0.1";
  }

  setPorts(ports) {
    this.port = ports;
  }
}
