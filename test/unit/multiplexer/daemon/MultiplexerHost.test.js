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
      if (overrides.sendMessageError) {
        throw overrides.sendMessageError;
      }
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
    this.disableAllClientsCalls = 0;
    this.nextClientId = option.nextClientId ?? 1;
    this.createClientIdCalls = 0;
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

  createClientId() {
    this.createClientIdCalls++;
    return this.nextClientId++;
  }

  async startWatchClient(device, shouldStart = () => true) {
    if (!shouldStart()) {
      return;
    }
    this.startWatchClientCalls.push(device.serial);
    if (this.option.startWatchClientImpl) {
      await this.option.startWatchClientImpl(device, shouldStart);
      return;
    }
    if (!shouldStart()) {
      return;
    }
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

  disableAllClients() {
    this.disableAllClientsCalls++;
    this.devices.forEach((device) => device.stopWatchClient());
    this.getAllUsbClients().forEach((client) => client.close());
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
  static stopError = null;

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
    if (FakeStartControlServer.stopError) {
      throw FakeStartControlServer.stopError;
    }
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

class FakeLegacyOwnershipGuard {
  static instances = [];

  constructor(option = {}) {
    this.option = option;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.reacquireCalls = 0;
    FakeLegacyOwnershipGuard.instances.push(this);
  }

  start() {
    this.startCalls++;
    this.emitStatus("attached", "daemon-started");
  }

  stop() {
    this.stopCalls++;
  }

  reacquire() {
    this.reacquireCalls++;
    this.emitStatus("attached", "reacquire-requested");
    return true;
  }

  emitStatus(status, reason, previousOwnerPid) {
    this.option.onStatusChanged?.({
      status,
      ownerPid: 100,
      previousOwnerPid,
      reason,
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
    websocketOption: options.websocketOption,
    now: options.now ?? (() => 1000),
  });
  if (options.legacyOwnershipAttached !== false) {
    host.legacyOwnershipAttached = true;
  }

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

function createWebSocketControllerProbe() {
  return {
    sendDeviceListCalls: 0,
    sendClientListCalls: 0,
    sendMessageToWeb() {},
    sendMessageToWebClient() {},
    close() {},
    sendDeviceList() {
      this.sendDeviceListCalls++;
    },
    sendClientList() {
      this.sendClientListCalls++;
    },
  };
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

function replaceWebSocketStartDependencies({
  detectPortImpl = async (port) => port,
  addressImpl = () => "127.0.0.1",
  WebSocketControllerCtor,
}) {
  const detectPortImport = hostModule.__get__("detect_port_1");
  const ipImport = hostModule.__get__("ip_1");
  const webSocketServerImport = hostModule.__get__("WebSocketServer_1");
  const originalDetectPort = detectPortImport.default;
  const originalAddress = ipImport.address;
  const originalWebSocketController = webSocketServerImport.WebSocketController;

  detectPortImport.default = detectPortImpl;
  ipImport.address = addressImpl;
  webSocketServerImport.WebSocketController = WebSocketControllerCtor;

  return () => {
    detectPortImport.default = originalDetectPort;
    ipImport.address = originalAddress;
    webSocketServerImport.WebSocketController = originalWebSocketController;
  };
}

function createCustomizedEnvelope({
  id,
  method = "Runtime.evaluate",
  result,
  params = {},
  clientId = -1,
  sender = 0,
  sessionId = -1,
  type = "CDP",
  messageAsString = false,
}) {
  const inner =
    result === undefined
      ? {
          id,
          method,
          params,
        }
      : {
          id,
          result,
        };
  return {
    event: "Customized",
    data: {
      type,
      data: {
        client_id: clientId,
        session_id: sessionId,
        message: messageAsString ? JSON.stringify(inner) : inner,
      },
      sender,
    },
  };
}

function readCustomizedInner(message) {
  const data = typeof message === "string" ? JSON.parse(message) : message;
  const raw = data.data.data.message;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

describe("MultiplexerHost", function () {
  let restoreLegacyOwnershipGuard;

  before(function () {
    const legacyOwnershipImport = hostModule.__get__("LegacyOwnershipGuard_1");
    const originalLegacyOwnershipGuard =
      legacyOwnershipImport.LegacyOwnershipGuard;
    legacyOwnershipImport.LegacyOwnershipGuard = FakeLegacyOwnershipGuard;
    restoreLegacyOwnershipGuard = () => {
      legacyOwnershipImport.LegacyOwnershipGuard = originalLegacyOwnershipGuard;
    };
  });

  after(function () {
    restoreLegacyOwnershipGuard?.();
  });

  beforeEach(function () {
    FakeLegacyOwnershipGuard.instances = [];
  });

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
    assert.strictEqual("webSocketServerStarted" in snapshot, false);
    assert.strictEqual("webSocketServerInfo" in snapshot, false);
    assert.strictEqual("wss" in snapshot, false);
  });

  it("starts once, reports the listening port, and stops idempotently", async function () {
    FakeStartControlServer.instances = [];
    FakeStartControlServer.startError = null;
    FakeStartControlServer.stopError = null;
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
      FakeStartControlServer.stopError = null;
      resetControlServer();
    }
  });

  it("continues closing physical resources when the control server stop fails", async function () {
    FakeStartControlServer.instances = [];
    FakeStartControlServer.startError = null;
    FakeStartControlServer.stopError = new Error("control stop failed");
    const resetControlServer = replaceControlServerForStart();
    const { host, physical } = createHost();

    try {
      await host.start();

      await assert.rejects(() => host.stop(), /control stop failed/);

      assert.strictEqual(FakeStartControlServer.instances[0].stopCalls, 1);
      assert.strictEqual(physical.closeCalls, 1);
      assert.strictEqual(physical.listenerCount("device-connected"), 0);
    } finally {
      FakeStartControlServer.stopError = null;
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

  it("handles legacy ownership loss by stopping physical state and publishing an empty snapshot", async function () {
    const { host, physical } = createHost({
      now: () => 3000,
    });
    const controlServer = attachControlServer(host);
    bindHostEvents(host);
    const device = createDevice("device-1");
    const client = createClient(7, {
      deviceId: "device-1",
    });
    const webSocketController = createWebSocketControllerProbe();
    physical.devices.set(device.serial, device);
    physical.usbClients.set(client.clientId(), client);
    host.webSocketController = webSocketController;

    host.legacyOwnershipGuard.emitStatus(
      "unattached",
      "legacy-preempted",
      200
    );

    assert.strictEqual(host.legacyOwnershipAttached, false);
    assert.strictEqual(physical.disableAllClientsCalls, 1);
    assert.strictEqual(device.state.stopWatchCalls, 1);
    assert.strictEqual(client.state.closeCalls, 1);
    assert.strictEqual(physical.devices.size, 0);
    assert.strictEqual(physical.usbClients.size, 0);
    assert.deepStrictEqual(await host.getDevices(), []);
    assert.deepStrictEqual(host.getAllUsbClients(), []);
    assert.deepStrictEqual(
      controlServer.broadcasts.map((event) => event.event),
      ["snapshot", "legacy-ownership-changed"]
    );
    assert.deepStrictEqual(controlServer.broadcasts[0].data, {
      protocolVersion: 1,
      generatedAt: 3000,
      devices: [],
      clients: [],
      daemonVersion: undefined,
      capabilities: undefined,
    });
    assert.deepStrictEqual(controlServer.broadcasts[1].data, {
      status: "unattached",
      ownerPid: 100,
      previousOwnerPid: 200,
      reason: "legacy-preempted",
    });
    assert.strictEqual(webSocketController.sendDeviceListCalls, 1);
    assert.strictEqual(webSocketController.sendClientListCalls, 1);

    physical.emit("device-connected", createDevice("late-device"));
    physical.emit("client-connected", createClient(8));
    physical.emit("usb-client-message", {
      id: 8,
      message: "late",
    });
    assert.deepStrictEqual(
      controlServer.broadcasts.map((event) => event.event),
      ["snapshot", "legacy-ownership-changed"]
    );
  });

  it("invalidates in-flight device discovery when legacy ownership is lost", async function () {
    const deferred = createDeferred();
    const physical = new FakePhysicalConnector({
      connectDevicesImpl: () => deferred.promise,
    });
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);
    const { host } = createHost({
      physical,
    });
    attachControlServer(host);

    const discovery = host.handleControlRpc(
      1,
      createRpcRequest("connectDevices", {
        isAutoListenClients: true,
      })
    );
    await nextTick();

    host.legacyOwnershipGuard.emitStatus(
      "unattached",
      "legacy-preempted",
      200
    );
    deferred.resolve([device]);

    await assert.rejects(discovery, /legacy owner is not attached/);
    assert.strictEqual(host.deviceDiscoveryStarted, false);
    assert.strictEqual(host.deviceDiscoveryStarting, null);
    assert.deepStrictEqual(host.clientDiscoveryStartingByDeviceId.size, 0);
    assert.deepStrictEqual(host.clientDiscoveryStartedDeviceIds.size, 0);
    assert.deepStrictEqual(physical.startWatchClientCalls, []);
  });

  it("invalidates in-flight client watcher startup when legacy ownership is lost", async function () {
    const startDeferred = createDeferred();
    const { host, physical } = createHost({
      startWatchClientImpl: async (device, shouldStart) => {
        await startDeferred.promise;
        if (shouldStart()) {
          device.startWatchClient();
        }
      },
    });
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);
    attachControlServer(host);

    const discovery = host.handleControlRpc(
      1,
      createRpcRequest("connectUsbClients", {
        deviceId: "device-1",
      })
    );
    await nextTick();
    assert.deepStrictEqual(physical.startWatchClientCalls, ["device-1"]);

    host.legacyOwnershipGuard.emitStatus(
      "unattached",
      "legacy-preempted",
      200
    );
    startDeferred.resolve();

    await assert.rejects(discovery, /legacy owner is not attached/);
    assert.strictEqual(device.state.startWatchCalls, 0);
    assert.strictEqual(host.clientDiscoveryStartingByDeviceId.size, 0);
    assert.strictEqual(host.clientDiscoveryStartedDeviceIds.size, 0);
    assert.deepStrictEqual(physical.getDeviceUsbClientsCalls, []);
  });

  it("reacquireLegacyOwnership reattaches the host and allows watcher recovery", async function () {
    const { host, physical } = createHost();
    const controlServer = attachControlServer(host);
    const device = createDevice("device-1");
    const webSocketController = createWebSocketControllerProbe();
    host.webSocketController = webSocketController;
    physical.devices.set(device.serial, device);

    host.legacyOwnershipGuard.emitStatus(
      "unattached",
      "legacy-preempted",
      200
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("reacquireLegacyOwnership", {})
    );
    physical.devices.set(device.serial, device);
    await host.handleControlRpc(
      1,
      createRpcRequest("startWatchAllClients", {
        force: true,
      })
    );

    assert.strictEqual(host.legacyOwnershipAttached, true);
    assert.strictEqual(host.legacyOwnershipGuard.reacquireCalls, 1);
    assert.deepStrictEqual(
      controlServer.broadcasts.map((event) => event.event),
      [
        "snapshot",
        "legacy-ownership-changed",
        "legacy-ownership-changed",
        "snapshot",
      ]
    );
    assert.deepStrictEqual(physical.startWatchClientCalls, ["device-1"]);
    assert.strictEqual(device.state.startWatchCalls, 1);
    assert.strictEqual(webSocketController.sendDeviceListCalls, 1);
    assert.strictEqual(webSocketController.sendClientListCalls, 2);
  });

  it("shutdownDaemon schedules the explicit daemon shutdown handler", async function () {
    const { host } = createHost();
    let idleCalls = 0;
    let shutdownCalls = 0;
    host.setIdleTimeoutHandler(() => {
      idleCalls++;
    });
    host.setShutdownHandler(() => {
      shutdownCalls++;
    });

    const result = await host.handleControlRpc(
      1,
      createRpcRequest("shutdownDaemon", { reason: "stale-daemon" })
    );

    assert.strictEqual(result, undefined);
    assert.strictEqual(idleCalls, 0);
    assert.strictEqual(shutdownCalls, 0);
    await nextTick();
    assert.strictEqual(idleCalls, 0);
    assert.strictEqual(shutdownCalls, 1);

    await host.handleControlRpc(
      1,
      createRpcRequest("shutdownDaemon", { reason: "stale-daemon" })
    );
    await nextTick();
    assert.strictEqual(shutdownCalls, 1);
  });

  it("rejects shutdownDaemon when no daemon shutdown handler is configured", async function () {
    const { host } = createHost();

    await assert.rejects(
      () =>
        host.handleControlRpc(
          1,
          createRpcRequest("shutdownDaemon", { reason: "stale-daemon" })
        ),
      (error) =>
        error.code === "daemon-shutdown-unavailable" &&
        error.message ===
          "Multiplexer daemon shutdown handler is not configured"
    );
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
    const { host } = createHost({
      physical,
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

  it("connectUsbClients refreshes WebSocket ClientList after client discovery", async function () {
    const { host, physical } = createHost();
    const webSocketController = createWebSocketControllerProbe();
    const device = createDevice("device-1");
    const client = createClient(8, {
      deviceId: "device-1",
    });
    host.webSocketController = webSocketController;
    physical.devices.set(device.serial, device);
    physical.usbClients.set(client.clientId(), client);

    const result = await host.handleControlRpc(
      1,
      createRpcRequest("connectUsbClients", {
        deviceId: "device-1",
      })
    );

    assert.deepStrictEqual(
      result.map((item) => item.id),
      [8]
    );
    assert.strictEqual(webSocketController.sendClientListCalls, 1);
    assert.strictEqual(webSocketController.sendDeviceListCalls, 0);
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

  it("routes sendCustomizedMessage through the runtime and resolves from physical responses", async function () {
    const { host, physical } = createHost();
    const client = createClient(11);
    physical.usbClients.set(client.clientId(), client);

    const firstPromise = host.handleControlRpc(
      1,
      createRpcRequest("sendCustomizedMessage", {
        clientId: 11,
        method: "Runtime.evaluate",
      })
    );
    assert.deepStrictEqual(
      readCustomizedInner(client.state.sendMessageCalls[0]),
      {
        id: 1,
        method: "Runtime.evaluate",
        params: "",
      }
    );
    host.handlePhysicalMessage(
      11,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 1,
          result: {
            ok: true,
          },
          messageAsString: true,
        })
      )
    );
    const first = await firstPromise;

    const secondPromise = host.handleControlRpc(
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
    assert.deepStrictEqual(
      readCustomizedInner(client.state.sendMessageCalls[1]),
      {
        id: 2,
        method: "App.call",
        params: {
          ok: true,
        },
      }
    );
    assert.strictEqual(client.state.sendMessageCalls[1].data.type, "App");
    assert.strictEqual(
      client.state.sendMessageCalls[1].data.data.session_id,
      99
    );
    host.handlePhysicalMessage(
      11,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 2,
          result: "second",
          messageAsString: false,
          type: "App",
        })
      )
    );
    const second = await secondPromise;

    const thirdPromise = host.handleControlRpc(
      1,
      createRpcRequest("sendCustomizedMessage", {
        clientId: 11,
        method: "String.params",
        params: "raw",
      })
    );
    assert.deepStrictEqual(
      readCustomizedInner(client.state.sendMessageCalls[2]),
      {
        id: 3,
        method: "String.params",
        params: "raw",
      }
    );
    host.handlePhysicalMessage(
      11,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 3,
          result: null,
          messageAsString: true,
        })
      )
    );
    const third = await thirdPromise;

    assert.strictEqual(first, '{"id":1,"result":{"ok":true}}');
    assert.strictEqual(second, '{"id":2,"result":"second"}');
    assert.strictEqual(third, '{"id":3,"result":null}');
    assert.deepStrictEqual(client.state.sendCustomizedCalls, []);
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

  it("sendMessageToApp rejects missing clients before attempting control or websocket routing", async function () {
    const disabled = createHost({
      enableWebSocket: false,
    });
    const enabled = createHost({
      enableWebSocket: true,
    });

    await assert.rejects(
      () =>
        disabled.host.handleControlRpc(
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
          /Multiplexer USB client was not found: 404/
        );
        return true;
      }
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
          /Multiplexer USB client was not found: 404/
        );
        return true;
      }
    );
  });

  it("startWSServer returns when websocket is disabled", async function () {
    const disabled = createHost({
      enableWebSocket: false,
    });

    await disabled.host.handleControlRpc(
      1,
      createRpcRequest("startWSServer", {})
    );
  });

  it("startWSServer creates a WebSocketController with detected port and configured room", async function () {
    const instances = [];
    class FakeWebSocketController {
      constructor(controllerHost, option) {
        this.controllerHost = controllerHost;
        this.option = option;
        this.closeCalls = 0;
        instances.push(this);
        option.callback();
      }

      close() {
        this.closeCalls++;
      }

      sendMessageToWeb() {}

      sendMessageToWebClient() {}
    }
    const reset = replaceWebSocketStartDependencies({
      detectPortImpl: async (port) => {
        assert.strictEqual(port, 19000);
        return 19001;
      },
      addressImpl: () => "10.0.0.5",
      WebSocketControllerCtor: FakeWebSocketController,
    });
    const { host, physical } = createHost({
      enableWebSocket: true,
      websocketOption: {
        port: 19000,
        roomId: "room-a",
      },
    });

    try {
      const first = await host.handleControlRpc(
        1,
        createRpcRequest("startWSServer", {})
      );
      const second = await host.handleControlRpc(
        1,
        createRpcRequest("startWSServer", {})
      );

      assert.strictEqual(instances.length, 1);
      assert.deepStrictEqual(first, {
        port: 19001,
        host: "10.0.0.5:19001",
        roomId: "room-a",
      });
      assert.deepStrictEqual(second, first);
      assert.strictEqual(instances[0].controllerHost, host);
      assert.deepStrictEqual(instances[0].option, {
        port: 19001,
        host: "10.0.0.5:19001",
        roomId: "room-a",
        callback: instances[0].option.callback,
      });
      assert.strictEqual(host.createClientId(), 1);
      assert.strictEqual(physical.createClientIdCalls, 1);
    } finally {
      reset();
    }
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

    const serverInfo = {
      port: 19783,
      host: "127.0.0.1:19783",
      roomId: "room-a",
    };
    deferred.resolve(serverInfo);
    assert.deepStrictEqual(await Promise.all([first, second]), [
      serverInfo,
      serverInfo,
    ]);
    assert.deepStrictEqual(
      await host.handleControlRpc(1, createRpcRequest("startWSServer", {})),
      serverInfo
    );

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

  it("sendMessageToWeb returns when websocket is disabled or the server has not started", async function () {
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
    await enabled.host.handleControlRpc(
      1,
      createRpcRequest("sendMessageToWeb", {
        message: "hello",
      })
    );
  });

  it("routes concurrent websocket messages with duplicate original ids back to the originating web clients", function () {
    const { host, physical } = createHost({
      enableWebSocket: true,
    });
    const client = createClient(21);
    const webMessages = [];
    physical.usbClients.set(client.clientId(), client);
    host.webSocketController = {
      sendMessageToWeb(message) {
        webMessages.push({
          kind: "broadcast",
          message,
        });
      },
      sendMessageToWebClient(webClientId, message) {
        webMessages.push({
          kind: "targeted",
          webClientId,
          message,
        });
      },
      close() {},
    };

    host.handleWebSocketMessage(
      100,
      21,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 5,
          clientId: 21,
          method: "Runtime.evaluate",
          params: {
            expression: "first",
          },
          messageAsString: true,
        })
      )
    );
    host.handleWebSocketMessage(
      101,
      21,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 5,
          clientId: 21,
          method: "Runtime.evaluate",
          params: {
            expression: "second",
          },
          messageAsString: true,
        })
      )
    );

    assert.strictEqual(client.state.sendMessageCalls.length, 2);
    assert.strictEqual(
      readCustomizedInner(client.state.sendMessageCalls[0]).id,
      1
    );
    assert.strictEqual(
      readCustomizedInner(client.state.sendMessageCalls[1]).id,
      2
    );
    assert.strictEqual(
      client.state.sendMessageCalls[0].data.data.client_id,
      -1
    );
    assert.strictEqual(
      client.state.sendMessageCalls[1].data.data.client_id,
      -1
    );

    host.handlePhysicalMessage(
      21,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 2,
          result: {
            value: "second",
          },
          messageAsString: true,
        })
      )
    );
    host.handlePhysicalMessage(
      21,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 1,
          result: {
            value: "first",
          },
          messageAsString: true,
        })
      )
    );

    assert.deepStrictEqual(
      webMessages.map((item) => ({
        kind: item.kind,
        webClientId: item.webClientId,
        inner: readCustomizedInner(item.message),
        clientId: JSON.parse(item.message).data.data.client_id,
      })),
      [
        {
          kind: "targeted",
          webClientId: 101,
          inner: {
            id: 5,
            result: {
              value: "second",
            },
          },
          clientId: 21,
        },
        {
          kind: "targeted",
          webClientId: 100,
          inner: {
            id: 5,
            result: {
              value: "first",
            },
          },
          clientId: 21,
        },
      ]
    );
  });

  it("resolves routed control events without a promise through sendToControl", function () {
    const { host, physical } = createHost();
    const client = createClient(22);
    physical.usbClients.set(client.clientId(), client);
    const controlServer = attachControlServer(host);

    host.sendMessageToApp(
      22,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 9,
          clientId: 22,
          method: "Runtime.evaluate",
          messageAsString: false,
        })
      ),
      undefined,
      55
    );
    assert.strictEqual(
      readCustomizedInner(client.state.sendMessageCalls[0]).id,
      1
    );

    host.handlePhysicalMessage(
      22,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 1,
          result: {
            value: 42,
          },
          messageAsString: false,
        })
      )
    );

    assert.deepStrictEqual(controlServer.targeted, [
      {
        controlId: 55,
        event: {
          kind: "event",
          event: "usb-client-message",
          data: {
            id: 22,
            message: JSON.stringify(
              createCustomizedEnvelope({
                id: 9,
                result: {
                  value: 42,
                },
                clientId: 22,
                sender: 22,
                messageAsString: false,
              })
            ),
          },
        },
      },
    ]);
  });

  it("drops unknown response ids but broadcasts notifications to controls and web clients", function () {
    const { host } = createHost({
      enableWebSocket: true,
    });
    const controlServer = attachControlServer(host);
    const webMessages = [];
    host.webSocketController = {
      sendMessageToWeb(message) {
        webMessages.push(message);
      },
      sendMessageToWebClient(webClientId, message) {
        webMessages.push({
          webClientId,
          message,
        });
      },
      close() {},
    };

    host.handlePhysicalMessage(
      31,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 999,
          result: {
            dropped: true,
          },
          messageAsString: true,
        })
      )
    );
    host.handlePhysicalMessage(
      31,
      JSON.stringify({
        event: "Customized",
        data: {
          type: "CDP",
          data: {
            client_id: -1,
            message: JSON.stringify({
              method: "Runtime.consoleAPICalled",
            }),
          },
          sender: 0,
        },
      })
    );

    assert.deepStrictEqual(webMessages, [
      JSON.stringify({
        event: "Customized",
        data: {
          type: "CDP",
          data: {
            client_id: 31,
            message: JSON.stringify({
              method: "Runtime.consoleAPICalled",
            }),
          },
          sender: 31,
        },
      }),
    ]);
    assert.deepStrictEqual(
      controlServer.broadcasts.map((event) => event.event),
      ["usb-client-message"]
    );
    assert.strictEqual(controlServer.broadcasts[0].data.id, 31);
    assert.strictEqual(
      controlServer.broadcasts[0].data.message,
      webMessages[0]
    );
  });

  it("rejects pending control routes on control disconnect and removes pending websocket routes on web disconnect", async function () {
    const { host, physical } = createHost({
      enableWebSocket: true,
    });
    const controlClient = createClient(41);
    const webClient = createClient(42);
    const webMessages = [];
    physical.usbClients.set(controlClient.clientId(), controlClient);
    physical.usbClients.set(webClient.clientId(), webClient);
    host.webSocketController = {
      sendMessageToWeb() {},
      sendMessageToWebClient(webClientId, message) {
        webMessages.push({
          webClientId,
          message,
        });
      },
      close() {},
    };

    const pendingControl = host.handleControlRpc(
      77,
      createRpcRequest("sendCustomizedMessage", {
        clientId: 41,
        method: "Runtime.evaluate",
      })
    );
    host.handleControlDisconnected(77);

    await assert.rejects(
      () => pendingControl,
      /Multiplexer control 77 disconnected/
    );

    host.handleWebSocketMessage(
      88,
      42,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 50,
          clientId: 42,
          method: "Runtime.evaluate",
          messageAsString: true,
        })
      )
    );
    assert.strictEqual(
      readCustomizedInner(webClient.state.sendMessageCalls[0]).id,
      2
    );
    host.handleWebSocketClientDisconnected(88);
    host.handlePhysicalMessage(
      42,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 2,
          result: {
            late: true,
          },
          messageAsString: true,
        })
      )
    );

    assert.deepStrictEqual(webMessages, []);
  });

  it("removes a pending route if sending to the runtime throws", function () {
    const { host, physical } = createHost({
      enableWebSocket: true,
    });
    const client = createClient(51, {
      sendMessageError: new Error("runtime send failed"),
    });
    const webMessages = [];
    physical.usbClients.set(client.clientId(), client);
    host.webSocketController = {
      sendMessageToWeb() {},
      sendMessageToWebClient(webClientId, message) {
        webMessages.push({
          webClientId,
          message,
        });
      },
      close() {},
    };

    assert.throws(
      () =>
        host.handleWebSocketMessage(
          99,
          51,
          JSON.stringify(
            createCustomizedEnvelope({
              id: 8,
              clientId: 51,
              method: "Runtime.evaluate",
              messageAsString: true,
            })
          )
        ),
      /runtime send failed/
    );
    host.handlePhysicalMessage(
      51,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 1,
          result: {
            shouldDrop: true,
          },
          messageAsString: true,
        })
      )
    );

    assert.deepStrictEqual(webMessages, []);
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

  it("keeps handleControlDisconnected harmless when no routes belong to the control", function () {
    const { host } = createHost();

    assert.doesNotThrow(() => host.handleControlDisconnected(123));
  });
});
