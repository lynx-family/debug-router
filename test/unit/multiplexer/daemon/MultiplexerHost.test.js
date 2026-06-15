// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { EventEmitter } = require("events");
const path = require("path");
const rewire = require(require.resolve("rewire", {
  paths: [path.join(__dirname, "../../../../debug_router_connector")],
}));

require("../register_ts");

const hostModule = rewire(
  path.join(
    __dirname,
    "../../../../debug_router_connector/src/multiplexer/daemon/MultiplexerHost"
  )
);
const { MultiplexerHost } = hostModule;
const {
  defaultLogger,
} = require("../../../../debug_router_connector/src/utils/logger");

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function createRpcRequest(method, params, extra = {}) {
  return {
    kind: "rpc",
    id: 1,
    method,
    params,
    ...extra,
  };
}

function createDevice(serial, overrides = {}) {
  const state = {
    startWatchCalls: 0,
    stopWatchCalls: 0,
    disconnectCalls: 0,
    getHostCalls: 0,
  };

  const device = {
    info: {
      os: overrides.os ?? "Android",
      title: overrides.title ?? `Device ${serial}`,
      serial,
    },
    ports: overrides.ports ?? [8901, 8902],
    state,
    get serial() {
      return this.info.serial;
    },
    getHost() {
      state.getHostCalls++;
      if (overrides.throwHost) {
        throw new Error("host unavailable");
      }
      return overrides.host;
    },
    startWatchClient() {
      state.startWatchCalls++;
    },
    stopWatchClient() {
      state.stopWatchCalls++;
    },
    disConnect() {
      state.disconnectCalls++;
    },
  };

  return device;
}

function createClient(id, overrides = {}) {
  const state = {
    sendCustomizedCalls: [],
    sendRawCalls: [],
    sendMessageCalls: [],
    closeCalls: 0,
  };
  const deviceId = overrides.deviceId ?? "device-1";
  const client = {
    info: {
      port: overrides.port ?? 9000 + id,
      id,
      query: {
        app: overrides.app ?? `app-${id}`,
        os: overrides.os ?? "Android",
        device: overrides.device ?? "Pixel",
        device_model: overrides.deviceModel ?? "Pixel",
        device_id: deviceId,
        sdk_version: overrides.sdkVersion,
        raw_info: overrides.rawInfo,
      },
    },
    state,
    clientId() {
      return this.info.id;
    },
    deviceId() {
      return this.info.query.device_id;
    },
    async sendCustomizedMessage(method, params, sessionId, type) {
      state.sendCustomizedCalls.push({
        method,
        params,
        sessionId,
        type,
      });
      if (overrides.sendCustomizedError) {
        throw overrides.sendCustomizedError;
      }
      return overrides.sendCustomizedResult ?? "customized-result";
    },
    async sendRawMessage(message) {
      state.sendRawCalls.push(message);
      if (overrides.sendRawError) {
        throw overrides.sendRawError;
      }
      return (
        overrides.sendRawResult ?? {
          event: "Register",
          data: {
            id,
            info: {},
          },
        }
      );
    },
    sendMessage(message) {
      state.sendMessageCalls.push(message);
    },
    close() {
      state.closeCalls++;
    },
  };

  return client;
}

class FakePhysicalConnector extends EventEmitter {
  constructor(option = {}) {
    super();
    this.option = option;
    this.devices = new Map();
    this.usbClients = new Map();
    this.enableWebSocket = option.enableWebSocket;
    this.connectDevicesCalls = [];
    this.getDevicesCalls = [];
    this.getAllUsbClientsCalls = 0;
    this.getDeviceUsbClientsCalls = [];
    this.waitDeviceUsbClientsCalls = [];
    this.startWatchClientCalls = [];
    this.sendRawMessageCalls = [];
    this.sendMessageCalls = [];
    this.closeClientCalls = [];
    this.closeCalls = 0;
    this.connectDevicesImpl = option.connectDevicesImpl;
    this.getDeviceUsbClientsResult = option.getDeviceUsbClientsResult;
    this.waitDeviceUsbClientsResult = option.waitDeviceUsbClientsResult;
    this.sendRawMessageResult = option.sendRawMessageResult;
  }

  async connectDevices(
    timeout = -1,
    serial = null,
    isAutoListenClients = true
  ) {
    this.connectDevicesCalls.push({
      timeout,
      serial,
      isAutoListenClients,
    });
    if (this.connectDevicesImpl) {
      return this.connectDevicesImpl(timeout, serial, isAutoListenClients);
    }
    return this.getDevices(timeout, serial);
  }

  async getDevices(timeout = -1, serial = null) {
    this.getDevicesCalls.push({
      timeout,
      serial,
    });
    const devices = Array.from(this.devices.values());
    if (serial === null) {
      return devices;
    }
    return devices.filter((device) => device.serial === serial);
  }

  getAllUsbClients() {
    this.getAllUsbClientsCalls++;
    return Array.from(this.usbClients.values());
  }

  startWatchClient(device) {
    this.startWatchClientCalls.push(device.serial);
    device.startWatchClient();
  }

  async getDeviceUsbClients(deviceId, timeout = -1, clientName = null) {
    this.getDeviceUsbClientsCalls.push({
      deviceId,
      timeout,
      clientName,
    });
    if (this.getDeviceUsbClientsResult) {
      return this.getDeviceUsbClientsResult;
    }
    return Array.from(this.usbClients.values()).filter(
      (client) => client.deviceId() === deviceId
    );
  }

  async waitDeviceUsbClients(deviceId, timeout = -1) {
    this.waitDeviceUsbClientsCalls.push({
      deviceId,
      timeout,
    });
    if (this.waitDeviceUsbClientsResult) {
      return this.waitDeviceUsbClientsResult;
    }
    return Array.from(this.usbClients.values()).filter(
      (client) => client.deviceId() === deviceId
    );
  }

  async sendRawMessage(clientId, message) {
    this.sendRawMessageCalls.push({
      clientId,
      message,
    });
    if (this.sendRawMessageResult) {
      return this.sendRawMessageResult;
    }
    const client = this.usbClients.get(clientId);
    if (!client) {
      throw new Error(`client not found:${clientId}`);
    }
    return client.sendRawMessage(message);
  }

  sendMessage(clientId, message) {
    this.sendMessageCalls.push({
      clientId,
      message,
    });
    const client = this.usbClients.get(clientId);
    if (client) {
      client.sendMessage(message);
    }
  }

  closeClient(clientId) {
    this.closeClientCalls.push(clientId);
    const client = this.usbClients.get(clientId);
    if (client) {
      client.close();
    }
  }

  async close() {
    this.closeCalls++;
  }
}

class FakeControlServer {
  constructor(port = 7777) {
    this.controlPort = port;
    this.broadcasts = [];
    this.targeted = [];
    this.stopCalls = 0;
  }

  broadcast(event) {
    this.broadcasts.push(event);
  }

  sendToControl(controlId, event) {
    this.targeted.push({
      controlId,
      event,
    });
  }

  async stop() {
    this.stopCalls++;
  }
}

class FakeStartControlServer {
  static instances = [];
  static startError = null;

  constructor(option) {
    this.option = option;
    this.controlPort = option.controlPort ?? 8899;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.broadcasts = [];
    this.targeted = [];
    FakeStartControlServer.instances.push(this);
  }

  async start() {
    this.startCalls++;
    if (FakeStartControlServer.startError) {
      throw FakeStartControlServer.startError;
    }
  }

  async stop() {
    this.stopCalls++;
  }

  broadcast(event) {
    this.broadcasts.push(event);
  }

  sendToControl(controlId, event) {
    this.targeted.push({
      controlId,
      event,
    });
  }
}

function createHost(options = {}) {
  const physical = options.physical ?? new FakePhysicalConnector(options);
  const host = new MultiplexerHost({
    physicalConnector: physical,
    protocolVersion: options.protocolVersion,
    minSupportedProtocolVersion: options.minSupportedProtocolVersion,
    daemonVersion: options.daemonVersion,
    capabilities: options.capabilities,
    controlPort: options.controlPort,
    manualConnect: options.manualConnect,
    enableWebSocket: options.enableWebSocket,
    now: options.now ?? (() => 1000),
  });

  return {
    host,
    physical,
  };
}

function attachControlServer(host, port = 7777) {
  const controlServer = new FakeControlServer(port);
  host.controlServer = controlServer;
  return controlServer;
}

function assertControlError(error, code, messagePattern) {
  assert.strictEqual(error.code, code);
  assert.match(error.message, messagePattern);
}

function bindHostEvents(host) {
  host.bindPhysicalConnectorEvents();
}

function replaceControlServerForStart() {
  const controlServerImport = hostModule.__get__("MultiplexerControlServer_1");
  const originalControlServer = controlServerImport.MultiplexerControlServer;
  controlServerImport.MultiplexerControlServer = FakeStartControlServer;

  return () => {
    controlServerImport.MultiplexerControlServer = originalControlServer;
  };
}

describe("MultiplexerHost", function () {
  afterEach(function () {
    defaultLogger.setOutput(() => {});
  });

  it("constructs a physical connector when one is not injected", function () {
    const calls = [];
    class PhysicalConnectorCtor extends FakePhysicalConnector {
      constructor(option) {
        calls.push(option);
        super(option);
      }
    }

    const host = new MultiplexerHost({
      PhysicalConnectorCtor,
      protocolVersion: 3,
      manualConnect: true,
    });
    const snapshot = host.createSnapshot();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].protocolVersion, 3);
    assert.strictEqual(calls[0].manualConnect, true);
    assert.deepStrictEqual(snapshot.devices, []);
    assert.deepStrictEqual(snapshot.clients, []);
  });

  it("starts once, reports the listening port, and stops idempotently", async function () {
    FakeStartControlServer.instances = [];
    FakeStartControlServer.startError = null;
    const resetControlServer = replaceControlServerForStart();
    const { host, physical } = createHost();

    try {
      assert.strictEqual(host.getControlPort(), 0);
      await host.start();
      const port = host.getControlPort();
      await host.start();

      assert.strictEqual(port, 8899);
      assert.strictEqual(FakeStartControlServer.instances.length, 1);
      assert.strictEqual(FakeStartControlServer.instances[0].startCalls, 1);
      assert.strictEqual(physical.listenerCount("device-connected"), 1);
      assert.strictEqual(physical.listenerCount("device-disconnected"), 1);
      assert.strictEqual(physical.listenerCount("client-connected"), 1);
      assert.strictEqual(physical.listenerCount("client-disconnected"), 1);
      assert.strictEqual(physical.listenerCount("usb-client-message"), 1);

      await host.stop();
      await host.stop();

      assert.strictEqual(physical.closeCalls, 1);
      assert.strictEqual(FakeStartControlServer.instances[0].stopCalls, 1);
      assert.strictEqual(physical.listenerCount("device-connected"), 0);
      assert.strictEqual(physical.listenerCount("device-disconnected"), 0);
      assert.strictEqual(physical.listenerCount("client-connected"), 0);
      assert.strictEqual(physical.listenerCount("client-disconnected"), 0);
      assert.strictEqual(physical.listenerCount("usb-client-message"), 0);
    } finally {
      resetControlServer();
    }
  });

  it("cleans physical listeners and connector resources when control server start fails", async function () {
    FakeStartControlServer.instances = [];
    FakeStartControlServer.startError = new Error("control start failed");
    const resetControlServer = replaceControlServerForStart();
    const { host, physical } = createHost();

    try {
      await assert.rejects(() => host.start(), /control start failed/);

      assert.strictEqual(physical.closeCalls, 1);
      assert.strictEqual(FakeStartControlServer.instances.length, 1);
      assert.strictEqual(FakeStartControlServer.instances[0].stopCalls, 1);
      assert.strictEqual(physical.listenerCount("device-connected"), 0);
      assert.strictEqual(physical.listenerCount("client-connected"), 0);
    } finally {
      FakeStartControlServer.startError = null;
      resetControlServer();
    }
  });

  it("sends an initial snapshot to newly connected controls", function () {
    const { host, physical } = createHost({
      protocolVersion: 2,
      daemonVersion: "0.0.2",
      capabilities: ["control", "snapshot"],
      now: () => 1234,
    });
    const device = createDevice("device-1", {
      host: "127.0.0.1",
      ports: [9001],
    });
    const client = createClient(10, {
      deviceId: "device-1",
      rawInfo: {
        App: "Demo",
      },
      sdkVersion: "1.2.3",
    });
    physical.devices.set(device.serial, device);
    physical.usbClients.set(client.clientId(), client);
    const controlServer = attachControlServer(host);
    bindHostEvents(host);

    host.handleControlConnected(42);

    assert.deepStrictEqual(controlServer.targeted, [
      {
        controlId: 42,
        event: {
          kind: "event",
          event: "snapshot",
          data: {
            protocolVersion: 2,
            generatedAt: 1234,
            devices: [
              {
                os: "Android",
                title: "Device device-1",
                serial: "device-1",
                ports: [9001],
                host: "127.0.0.1",
              },
            ],
            clients: [
              {
                port: 9010,
                id: 10,
                query: {
                  app: "app-10",
                  os: "Android",
                  device: "Pixel",
                  device_model: "Pixel",
                  device_id: "device-1",
                  sdk_version: "1.2.3",
                  raw_info: {
                    App: "Demo",
                  },
                },
              },
            ],
            daemonVersion: "0.0.2",
            capabilities: ["control", "snapshot"],
          },
        },
      },
    ]);
  });

  it("serializes device host failures and non-json client raw_info without leaking invalid fields", function () {
    const { host, physical } = createHost();
    const circularRawInfo = {};
    circularRawInfo.self = circularRawInfo;
    const hostlessDevice = createDevice("device-hostless", {
      throwHost: true,
    });
    const noSdkClient = createClient(1, {
      rawInfo: undefined,
      sdkVersion: undefined,
    });
    const circularClient = createClient(2, {
      rawInfo: circularRawInfo,
      sdkVersion: "2.0.0",
    });
    const nullRawInfoClient = createClient(3, {
      rawInfo: null,
    });
    physical.devices.set(hostlessDevice.serial, hostlessDevice);
    physical.usbClients.set(noSdkClient.clientId(), noSdkClient);
    physical.usbClients.set(circularClient.clientId(), circularClient);
    physical.usbClients.set(nullRawInfoClient.clientId(), nullRawInfoClient);

    const snapshot = host.createSnapshot();

    assert.deepStrictEqual(snapshot.devices, [
      {
        os: "Android",
        title: "Device device-hostless",
        serial: "device-hostless",
        ports: [8901, 8902],
      },
    ]);
    assert.strictEqual("host" in snapshot.devices[0], false);
    assert.strictEqual("sdk_version" in snapshot.clients[0].query, false);
    assert.strictEqual("raw_info" in snapshot.clients[0].query, false);
    assert.strictEqual("raw_info" in snapshot.clients[1].query, false);
    assert.strictEqual(snapshot.clients[1].query.sdk_version, "2.0.0");
    assert.strictEqual(snapshot.clients[2].query.raw_info, null);
  });

  it("broadcasts physical device, client, and USB message events with snapshots", async function () {
    const { host, physical } = createHost({
      now: () => 2000,
    });
    const controlServer = attachControlServer(host);
    bindHostEvents(host);
    const device = createDevice("device-1", {
      host: "localhost",
    });
    const client = createClient(7, {
      deviceId: "device-1",
      rawInfo: {
        App: "Demo",
      },
    });
    physical.devices.set(device.serial, device);
    physical.usbClients.set(client.clientId(), client);

    physical.emit("device-connected", device);
    await nextTick();
    physical.emit("client-connected", client);
    physical.emit("usb-client-message", {
      id: client.clientId(),
      message: '{"event":"Customized"}',
    });
    physical.emit("client-disconnected", client.clientId());
    physical.emit("device-disconnected", device);

    assert.deepStrictEqual(
      controlServer.broadcasts.map((event) => event.event),
      [
        "device-connected",
        "snapshot",
        "client-connected",
        "snapshot",
        "usb-client-message",
        "client-disconnected",
        "snapshot",
        "device-disconnected",
        "snapshot",
      ]
    );
    assert.deepStrictEqual(controlServer.broadcasts[0].data, {
      os: "Android",
      title: "Device device-1",
      serial: "device-1",
      ports: [8901, 8902],
      host: "localhost",
    });
    assert.deepStrictEqual(controlServer.broadcasts[4].data, {
      id: 7,
      message: '{"event":"Customized"}',
    });
    assert.deepStrictEqual(controlServer.broadcasts[5].data, {
      id: 7,
    });
    assert.deepStrictEqual(controlServer.broadcasts[7].data, {
      serial: "device-1",
    });
  });

  it("connectDevices starts device discovery once and auto-starts client discovery", async function () {
    const { host, physical } = createHost();
    const device = createDevice("device-1");
    const nextDevice = createDevice("device-2");
    physical.devices.set(device.serial, device);
    attachControlServer(host);
    bindHostEvents(host);

    const first = await host.handleControlRpc(
      1,
      createRpcRequest("connectDevices", {
        timeout: 10,
        serial: "device-1",
        isAutoListenClients: true,
      })
    );
    const second = await host.handleControlRpc(
      1,
      createRpcRequest("connectDevices", {
        timeout: 20,
        serial: null,
        isAutoListenClients: true,
      })
    );

    physical.devices.set(nextDevice.serial, nextDevice);
    physical.emit("device-connected", nextDevice);
    await nextTick();

    assert.deepStrictEqual(physical.connectDevicesCalls, [
      {
        timeout: -1,
        serial: null,
        isAutoListenClients: false,
      },
    ]);
    assert.deepStrictEqual(physical.getDevicesCalls, [
      {
        timeout: -1,
        serial: null,
      },
      {
        timeout: 10,
        serial: "device-1",
      },
      {
        timeout: 20,
        serial: null,
      },
    ]);
    assert.deepStrictEqual(physical.startWatchClientCalls, [
      "device-1",
      "device-2",
    ]);
    assert.strictEqual(device.state.startWatchCalls, 1);
    assert.strictEqual(nextDevice.state.startWatchCalls, 1);
    assert.deepStrictEqual(
      first.map((item) => item.serial),
      ["device-1"]
    );
    assert.deepStrictEqual(
      second.map((item) => item.serial),
      ["device-1"]
    );
  });

  it("connectDevices skips auto client discovery for manualConnect and explicit false", async function () {
    const manual = createHost({
      manualConnect: true,
    });
    const autoDisabled = createHost();
    const manualDevice = createDevice("manual-device");
    const disabledDevice = createDevice("disabled-device");
    manual.physical.devices.set(manualDevice.serial, manualDevice);
    autoDisabled.physical.devices.set(disabledDevice.serial, disabledDevice);

    await manual.host.handleControlRpc(
      1,
      createRpcRequest("connectDevices", {
        isAutoListenClients: true,
      })
    );
    await autoDisabled.host.handleControlRpc(
      1,
      createRpcRequest("connectDevices", {
        isAutoListenClients: false,
      })
    );

    assert.deepStrictEqual(manual.physical.startWatchClientCalls, []);
    assert.deepStrictEqual(autoDisabled.physical.startWatchClientCalls, []);
  });

  it("shares an in-flight device discovery attempt", async function () {
    const deferred = createDeferred();
    const physical = new FakePhysicalConnector({
      connectDevicesImpl: () => deferred.promise,
    });
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);
    const host = new MultiplexerHost({
      physicalConnector: physical,
    });

    const first = host.handleControlRpc(
      1,
      createRpcRequest("connectDevices", {
        isAutoListenClients: false,
      })
    );
    const second = host.handleControlRpc(
      1,
      createRpcRequest("connectDevices", {
        isAutoListenClients: true,
      })
    );
    deferred.resolve([device]);
    await Promise.all([first, second]);

    assert.strictEqual(physical.connectDevicesCalls.length, 1);
  });

  it("getDevices directly serializes the physical query result", async function () {
    const { host, physical } = createHost();
    const firstDevice = createDevice("device-1");
    const secondDevice = createDevice("device-2");
    physical.devices.set(firstDevice.serial, firstDevice);
    physical.devices.set(secondDevice.serial, secondDevice);

    const result = await host.handleControlRpc(
      1,
      createRpcRequest("getDevices", {
        timeout: 30,
        serial: "device-2",
      })
    );

    assert.deepStrictEqual(physical.connectDevicesCalls, []);
    assert.deepStrictEqual(physical.getDevicesCalls, [
      {
        timeout: 30,
        serial: "device-2",
      },
    ]);
    assert.deepStrictEqual(
      result.map((item) => item.serial),
      ["device-2"]
    );
  });

  it("connectUsbClients starts discovery, watches target device once, and uses getDeviceUsbClients by default", async function () {
    const { host, physical } = createHost();
    const device = createDevice("device-1");
    const client = createClient(8, {
      deviceId: "device-1",
      rawInfo: {
        App: "Demo",
      },
    });
    physical.devices.set(device.serial, device);
    physical.usbClients.set(client.clientId(), client);

    const first = await host.handleControlRpc(
      1,
      createRpcRequest("connectUsbClients", {
        deviceId: "device-1",
        timeout: 55,
        clientName: "Demo",
      })
    );
    const second = await host.handleControlRpc(
      1,
      createRpcRequest("connectUsbClients", {
        deviceId: "device-1",
        timeout: 66,
      })
    );

    assert.deepStrictEqual(physical.connectDevicesCalls, [
      {
        timeout: -1,
        serial: null,
        isAutoListenClients: false,
      },
    ]);
    assert.deepStrictEqual(physical.startWatchClientCalls, ["device-1"]);
    assert.deepStrictEqual(physical.getDeviceUsbClientsCalls, [
      {
        deviceId: "device-1",
        timeout: 55,
        clientName: "Demo",
      },
      {
        deviceId: "device-1",
        timeout: 66,
        clientName: null,
      },
    ]);
    assert.deepStrictEqual(physical.waitDeviceUsbClientsCalls, []);
    assert.deepStrictEqual(first[0], {
      port: 9008,
      id: 8,
      query: {
        app: "app-8",
        os: "Android",
        device: "Pixel",
        device_model: "Pixel",
        device_id: "device-1",
        raw_info: {
          App: "Demo",
        },
      },
    });
    assert.deepStrictEqual(
      second.map((item) => item.id),
      [8]
    );
  });

  it("connectUsbClients uses waitDeviceUsbClients when waitTimeout is false", async function () {
    const { host, physical } = createHost();
    const device = createDevice("device-1");
    const client = createClient(9, {
      deviceId: "device-1",
    });
    physical.devices.set(device.serial, device);
    physical.usbClients.set(client.clientId(), client);

    const result = await host.handleControlRpc(
      1,
      createRpcRequest("connectUsbClients", {
        deviceId: "device-1",
        timeout: 77,
        waitTimeout: false,
      })
    );

    assert.deepStrictEqual(physical.getDeviceUsbClientsCalls, []);
    assert.deepStrictEqual(physical.waitDeviceUsbClientsCalls, [
      {
        deviceId: "device-1",
        timeout: 77,
      },
    ]);
    assert.deepStrictEqual(
      result.map((item) => item.id),
      [9]
    );
  });

  it("connectUsbClients waits for an existing client discovery promise without starting a duplicate watcher", async function () {
    const { host, physical } = createHost();
    const deferred = createDeferred();
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);
    host.clientDiscoveryStartingByDeviceId.set("device-1", deferred.promise);

    const promise = host.handleControlRpc(
      1,
      createRpcRequest("connectUsbClients", {
        deviceId: "device-1",
      })
    );
    await nextTick();
    assert.deepStrictEqual(physical.startWatchClientCalls, []);

    deferred.resolve();
    await promise;

    assert.deepStrictEqual(physical.startWatchClientCalls, []);
    assert.deepStrictEqual(physical.getDeviceUsbClientsCalls, [
      {
        deviceId: "device-1",
        timeout: -1,
        clientName: null,
      },
    ]);
  });

  it("connectUsbClients handles missing devices without starting client discovery", async function () {
    const { host, physical } = createHost();

    const result = await host.handleControlRpc(
      1,
      createRpcRequest("connectUsbClients", {
        deviceId: "missing-device",
      })
    );

    assert.deepStrictEqual(physical.startWatchClientCalls, []);
    assert.deepStrictEqual(physical.getDeviceUsbClientsCalls, [
      {
        deviceId: "missing-device",
        timeout: -1,
        clientName: null,
      },
    ]);
    assert.deepStrictEqual(result, []);
  });

  it("device disconnect clears client discovery state so a later connect can watch again", async function () {
    const { host, physical } = createHost();
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);
    attachControlServer(host);
    bindHostEvents(host);

    await host.handleControlRpc(
      1,
      createRpcRequest("connectUsbClients", {
        deviceId: "device-1",
      })
    );
    physical.emit("device-disconnected", device);
    await host.handleControlRpc(
      1,
      createRpcRequest("connectUsbClients", {
        deviceId: "device-1",
      })
    );

    assert.deepStrictEqual(physical.startWatchClientCalls, [
      "device-1",
      "device-1",
    ]);
  });

  it("startWatchClient starts device discovery and watches each device only once", async function () {
    const { host, physical } = createHost();
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);

    await host.handleControlRpc(
      1,
      createRpcRequest("startWatchClient", {
        deviceId: "device-1",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("startWatchClient", {
        deviceId: "device-1",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("startWatchClient", {
        deviceId: "missing-device",
      })
    );

    assert.deepStrictEqual(physical.connectDevicesCalls, [
      {
        timeout: -1,
        serial: null,
        isAutoListenClients: false,
      },
    ]);
    assert.deepStrictEqual(physical.startWatchClientCalls, ["device-1"]);
    assert.strictEqual(device.state.startWatchCalls, 1);
  });

  it("stopWatchClient stops existing device watchers, ignores missing devices, and allows later restart", async function () {
    const { host, physical } = createHost();
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);

    await host.handleControlRpc(
      1,
      createRpcRequest("startWatchClient", {
        deviceId: "device-1",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("stopWatchClient", {
        deviceId: "device-1",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("stopWatchClient", {
        deviceId: "missing-device",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("startWatchClient", {
        deviceId: "device-1",
      })
    );

    assert.deepStrictEqual(physical.startWatchClientCalls, [
      "device-1",
      "device-1",
    ]);
    assert.strictEqual(device.state.stopWatchCalls, 1);
  });

  it("disconnectDevice clears watcher state, delegates device disconnect, and ignores missing devices", async function () {
    const { host, physical } = createHost();
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);

    await host.handleControlRpc(
      1,
      createRpcRequest("startWatchClient", {
        deviceId: "device-1",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("disconnectDevice", {
        deviceId: "device-1",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("disconnectDevice", {
        deviceId: "missing-device",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("startWatchClient", {
        deviceId: "device-1",
      })
    );

    assert.strictEqual(device.state.disconnectCalls, 1);
    assert.deepStrictEqual(physical.startWatchClientCalls, [
      "device-1",
      "device-1",
    ]);
  });

  it("startWatchAllClients watches current and future devices", async function () {
    const { host, physical } = createHost();
    const firstDevice = createDevice("device-1");
    const secondDevice = createDevice("device-2");
    physical.devices.set(firstDevice.serial, firstDevice);
    attachControlServer(host);
    bindHostEvents(host);

    await host.handleControlRpc(
      1,
      createRpcRequest("startWatchAllClients", {
        force: false,
      })
    );
    physical.devices.set(secondDevice.serial, secondDevice);
    physical.emit("device-connected", secondDevice);
    await nextTick();

    assert.deepStrictEqual(physical.startWatchClientCalls, [
      "device-1",
      "device-2",
    ]);
  });

  it("delegates sendCustomizedMessage with defaults and explicit arguments", async function () {
    const { host, physical } = createHost();
    const client = createClient(11);
    physical.usbClients.set(client.clientId(), client);

    const first = await host.handleControlRpc(
      1,
      createRpcRequest("sendCustomizedMessage", {
        clientId: 11,
        method: "Runtime.evaluate",
      })
    );
    const second = await host.handleControlRpc(
      1,
      createRpcRequest("sendCustomizedMessage", {
        clientId: 11,
        method: "App.call",
        params: {
          ok: true,
        },
        sessionId: 99,
        type: "App",
      })
    );
    const third = await host.handleControlRpc(
      1,
      createRpcRequest("sendCustomizedMessage", {
        clientId: 11,
        method: "String.params",
        params: "raw",
      })
    );

    assert.strictEqual(first, "customized-result");
    assert.strictEqual(second, "customized-result");
    assert.strictEqual(third, "customized-result");
    assert.deepStrictEqual(client.state.sendCustomizedCalls, [
      {
        method: "Runtime.evaluate",
        params: "",
        sessionId: -1,
        type: "CDP",
      },
      {
        method: "App.call",
        params: {
          ok: true,
        },
        sessionId: 99,
        type: "App",
      },
      {
        method: "String.params",
        params: "raw",
        sessionId: -1,
        type: "CDP",
      },
    ]);
  });

  it("throws a control error when sendCustomizedMessage targets a missing client", async function () {
    const { host } = createHost();

    await assert.rejects(
      () =>
        host.handleControlRpc(
          1,
          createRpcRequest("sendCustomizedMessage", {
            clientId: 404,
            method: "Runtime.evaluate",
          })
        ),
      (error) => {
        assertControlError(
          error,
          "multiplexer-client-not-found",
          /Multiplexer USB client was not found: 404/
        );
        return true;
      }
    );
  });

  it("delegates sendRawMessage, sendMessage, and closeClient RPCs", async function () {
    const { host, physical } = createHost();
    const client = createClient(12, {
      sendRawResult: {
        event: "Customized",
        data: {
          ok: true,
        },
      },
    });
    const rawMessage = {
      event: "Initialize",
      data: 12,
    };
    physical.usbClients.set(client.clientId(), client);

    const rawResult = await host.handleControlRpc(
      1,
      createRpcRequest("sendRawMessage", {
        clientId: 12,
        message: rawMessage,
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessage", {
        clientId: 12,
        message: {
          event: "Ping",
        },
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("closeClient", {
        clientId: 12,
      })
    );

    assert.deepStrictEqual(rawResult, {
      event: "Customized",
      data: {
        ok: true,
      },
    });
    assert.deepStrictEqual(physical.sendRawMessageCalls, [
      {
        clientId: 12,
        message: rawMessage,
      },
    ]);
    assert.deepStrictEqual(physical.sendMessageCalls, [
      {
        clientId: 12,
        message: {
          event: "Ping",
        },
      },
    ]);
    assert.deepStrictEqual(client.state.sendMessageCalls, [
      {
        event: "Ping",
      },
    ]);
    assert.deepStrictEqual(physical.closeClientCalls, [12]);
    assert.strictEqual(client.state.closeCalls, 1);
  });

  it("sendRawMessage rejects when the physical layer reports a missing client", async function () {
    const { host } = createHost();

    await assert.rejects(
      () =>
        host.handleControlRpc(
          1,
          createRpcRequest("sendRawMessage", {
            clientId: 500,
            message: {
              event: "Initialize",
              data: 500,
            },
          })
        ),
      /client not found:500/
    );
  });

  it("sendMessageToApp rewrites USB messages, filters USB connect handshakes, and rejects invalid JSON", async function () {
    const { host, physical } = createHost();
    const client = createClient(13);
    physical.usbClients.set(client.clientId(), client);

    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessageToApp", {
        id: 13,
        message: JSON.stringify({
          event: "Customized",
          data: {
            type: "CDP",
            data: {
              client_id: 13,
              message: "payload",
            },
          },
        }),
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessageToApp", {
        id: 13,
        message: JSON.stringify({
          event: "Customized",
          data: {
            type: "UsbConnect",
          },
        }),
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessageToApp", {
        id: 13,
        message: JSON.stringify({
          event: "Customized",
          data: {
            type: "UsbConnectAck",
          },
        }),
      })
    );
    await assert.rejects(
      () =>
        host.handleControlRpc(
          1,
          createRpcRequest("sendMessageToApp", {
            id: 13,
            message: "{bad-json",
          })
        ),
      (error) => {
        assertControlError(error, "invalid-json-message", /Invalid JSON/);
        return true;
      }
    );

    assert.deepStrictEqual(client.state.sendMessageCalls, [
      {
        event: "Customized",
        data: {
          type: "CDP",
          data: {
            client_id: -1,
            message: "payload",
          },
        },
      },
    ]);
  });

  it("sendMessageToApp preserves missing and zero client_id values", async function () {
    const { host, physical } = createHost();
    const client = createClient(14);
    physical.usbClients.set(client.clientId(), client);

    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessageToApp", {
        id: 14,
        message: JSON.stringify({
          event: "Customized",
          data: {
            type: "CDP",
            data: {
              message: "without-client-id",
            },
          },
        }),
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessageToApp", {
        id: 14,
        message: JSON.stringify({
          event: "Customized",
          data: {
            type: "CDP",
            data: {
              client_id: 0,
              message: "zero-client-id",
            },
          },
        }),
      })
    );

    assert.deepStrictEqual(client.state.sendMessageCalls, [
      {
        event: "Customized",
        data: {
          type: "CDP",
          data: {
            message: "without-client-id",
          },
        },
      },
      {
        event: "Customized",
        data: {
          type: "CDP",
          data: {
            client_id: 0,
            message: "zero-client-id",
          },
        },
      },
    ]);
  });

  it("sendMessageToApp ignores missing clients when websocket is disabled and throws when it is enabled", async function () {
    const disabled = createHost({
      enableWebSocket: false,
    });
    const enabled = createHost({
      enableWebSocket: true,
    });

    await disabled.host.handleControlRpc(
      1,
      createRpcRequest("sendMessageToApp", {
        id: 404,
        message: "{}",
      })
    );
    await assert.rejects(
      () =>
        enabled.host.handleControlRpc(
          1,
          createRpcRequest("sendMessageToApp", {
            id: 404,
            message: "{}",
          })
        ),
      (error) => {
        assertControlError(
          error,
          "multiplexer-client-not-found",
          /Multiplexer target app client was not found: 404/
        );
        return true;
      }
    );
  });

  it("startWSServer returns when websocket is disabled and rejects when phase 6 routing is not ready", async function () {
    const disabled = createHost({
      enableWebSocket: false,
    });
    const enabled = createHost({
      enableWebSocket: true,
    });

    await disabled.host.handleControlRpc(
      1,
      createRpcRequest("startWSServer", {})
    );
    await assert.rejects(
      () =>
        enabled.host.handleControlRpc(1, createRpcRequest("startWSServer", {})),
      (error) => {
        assertControlError(
          error,
          "multiplexer-websocket-not-ready",
          /phase 6/i
        );
        return true;
      }
    );
  });

  it("startWSServer shares in-flight starts and is idempotent after success", async function () {
    const { host } = createHost({
      enableWebSocket: true,
    });
    const deferred = createDeferred();
    let calls = 0;
    host.startWebSocketServerInternal = () => {
      calls++;
      return deferred.promise;
    };

    const first = host.handleControlRpc(
      1,
      createRpcRequest("startWSServer", {})
    );
    const second = host.handleControlRpc(
      1,
      createRpcRequest("startWSServer", {})
    );
    await nextTick();
    assert.strictEqual(calls, 1);

    deferred.resolve();
    await Promise.all([first, second]);
    await host.handleControlRpc(1, createRpcRequest("startWSServer", {}));

    assert.strictEqual(calls, 1);
  });

  it("startWSServer clears the in-flight state after failure so it can retry", async function () {
    const { host } = createHost({
      enableWebSocket: true,
    });
    let calls = 0;
    host.startWebSocketServerInternal = async () => {
      calls++;
      throw {
        code: "custom-start-failed",
        message: "custom start failed",
      };
    };

    await assert.rejects(() =>
      host.handleControlRpc(1, createRpcRequest("startWSServer", {}))
    );
    await assert.rejects(() =>
      host.handleControlRpc(1, createRpcRequest("startWSServer", {}))
    );

    assert.strictEqual(calls, 2);
  });

  it("sendMessageToWeb returns when websocket is disabled and throws when websocket is enabled before phase 6", async function () {
    const disabled = createHost({
      enableWebSocket: false,
    });
    const enabled = createHost({
      enableWebSocket: true,
    });

    await disabled.host.handleControlRpc(
      1,
      createRpcRequest("sendMessageToWeb", {
        message: "hello",
      })
    );
    await assert.rejects(
      () =>
        enabled.host.handleControlRpc(
          1,
          createRpcRequest("sendMessageToWeb", {
            message: "hello",
          })
        ),
      (error) => {
        assertControlError(
          error,
          "multiplexer-websocket-not-ready",
          /cannot send message to Web/
        );
        return true;
      }
    );
  });

  it("throws a control error for unknown RPC methods", async function () {
    const { host } = createHost();

    await assert.rejects(
      () =>
        host.handleControlRpc(
          1,
          createRpcRequest("unknownMethod", {
            value: true,
          })
        ),
      (error) => {
        assertControlError(
          error,
          "unknown-control-rpc",
          /Unknown multiplexer control RPC: unknownMethod/
        );
        return true;
      }
    );
  });

  it("keeps handleControlDisconnected as a no-op until phase 6 route cleanup", function () {
    const { host } = createHost();

    assert.doesNotThrow(() => host.handleControlDisconnected(123));
  });
});
