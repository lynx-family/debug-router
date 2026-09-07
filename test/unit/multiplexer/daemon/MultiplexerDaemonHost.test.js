// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { EventEmitter } = require("events");
const {
  getDriverReportService,
  setDriverReportService,
} = require("../../../../debug_router_connector/dist/cjs/src/report/interface/DriverReportService");

const path = require("path");
const rewire = require(require.resolve("rewire", {
  paths: [path.join(__dirname, "../../../../debug_router_connector")],
}));

const hostModule = rewire(
  path.join(
    __dirname,
    "../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/MultiplexerDaemonHost"
  )
);
const { MultiplexerDaemonHost } = hostModule;
const {
  defaultLogger,
} = require("../../../../debug_router_connector/dist/cjs/src/utils/logger");
const {
  UsbClient,
} = require("../../../../debug_router_connector/dist/cjs/src/usb/Client");
const {
  isControlEvent,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/protocol/validation");
const {
  MULTIPLEXER_PROTOCOL_VERSION,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/protocol");

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, timeoutMs) {
      const timer = {
        callback,
        timeoutMs,
        cleared: false,
      };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
    },
    run(timer) {
      if (!timer.cleared) {
        timer.callback();
      }
    },
  };
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

function sendAppMessageWithoutReply(host, controlId, clientId, message) {
  return host.handleControlRpc(
    controlId,
    createRpcRequest("sendMessageWithoutReply", {
      target: "app",
      clientId,
      message,
    })
  );
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

function createWebSocketClient(id, type = "runtime", overrides = {}) {
  const state = {
    sendMessageCalls: [],
    sendCustomizedCalls: [],
    closeCalls: 0,
  };
  return {
    info: {
      id,
      app: overrides.app ?? `wifi-app-${id}`,
      debugRouterVersion: overrides.debugRouterVersion ?? "1.0.0",
      deviceModel: overrides.deviceModel ?? "Pixel",
      network: "WiFi",
      osVersion: overrides.osVersion ?? "14",
      sdkVersion: overrides.sdkVersion ?? "2.0.0",
      type,
      raw_info: overrides.rawInfo ?? { app: `wifi-app-${id}` },
    },
    state,
    clientId() {
      return id;
    },
    type() {
      return type;
    },
    sendMessage(message) {
      if (overrides.sendMessageError) {
        throw overrides.sendMessageError;
      }
      state.sendMessageCalls.push(message);
    },
    async sendCustomizedMessage(method, params, sessionId, messageType) {
      state.sendCustomizedCalls.push({
        method,
        params,
        sessionId,
        messageType,
      });
      return overrides.sendCustomizedResult ?? "websocket-customized-result";
    },
    close() {
      state.closeCalls++;
    },
  };
}

function createWebSocketControllerState(appClients = [], webClients = []) {
  const appMap = new Map(
    appClients.map((client) => [client.clientId(), client])
  );
  const webMap = new Map(
    webClients.map((client) => [client.clientId(), client])
  );
  const state = {
    appMap,
    webMap,
    webMessages: [],
    sendClientListCalls: 0,
    sendDeviceListCalls: 0,
  };
  return {
    state,
    controller: {
      getAllWebsocketAppClients() {
        return appMap;
      },
      getAllWebsocketWebClients() {
        return webMap;
      },
      sendMessageToWeb(message) {
        state.webMessages.push({ kind: "broadcast", message });
      },
      sendMessageToWebClient(webClientId, message) {
        state.webMessages.push({ kind: "targeted", webClientId, message });
      },
      sendClientList() {
        state.sendClientListCalls++;
      },
      sendDeviceList() {
        state.sendDeviceListCalls++;
      },
      close() {},
    },
  };
}

class FakePhysicalConnector extends EventEmitter {
  constructor(option = {}) {
    super();
    this.option = option;
    this.devices = new Map();
    this.usbClients = new Map();
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

  async connectDevices(timeout = -1, serial = null) {
    this.connectDevicesCalls.push({
      timeout,
      serial,
    });
    if (this.connectDevicesImpl) {
      return this.connectDevicesImpl(timeout, serial);
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
  constructor(endpoint = "/tmp/debug-router-host-attached.sock") {
    this.controlEndpoint = endpoint;
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
    this.controlEndpoint = option.controlEndpoint;
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
    this.currentStatus = "unInit";
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
    this.currentStatus = status;
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
  const host = new MultiplexerDaemonHost({
    physicalConnector: physical,
    protocolVersion: options.protocolVersion ?? MULTIPLEXER_PROTOCOL_VERSION,
    debugInfo: options.debugInfo,
    controlEndpoint:
      options.controlEndpoint ?? "/tmp/debug-router-host-control.sock",
    physicalConnectorOption: {
      manualConnect: options.manualConnect,
    },
    enableWebSocket: options.enableWebSocket,
    websocketOption: options.websocketOption,
    connectionTrace: options.connectionTrace,
    multiplexerDaemonIdleTimeout: options.multiplexerDaemonIdleTimeout ?? -1,
    memoizedNotificationTtlMs: options.memoizedNotificationTtlMs,
    now: options.now ?? (() => 1000),
  });
  host.legacyOwnershipGuard.currentStatus =
    options.legacyOwnershipAttached === false ? "unattached" : "attached";

  return {
    host,
    physical,
  };
}

function attachControlServer(
  host,
  endpoint = "/tmp/debug-router-host-attached.sock"
) {
  const controlServer = new FakeControlServer(endpoint);
  host.controlServer = controlServer;
  return controlServer;
}

function createWebSocketControllerProbe() {
  return {
    sendDeviceListCalls: 0,
    sendClientListCalls: 0,
    getAllWebsocketAppClients() {
      return new Map();
    },
    getAllWebsocketWebClients() {
      return new Map();
    },
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
  detectIPv4Impl = async () => ({ selected: { address: "127.0.0.1" } }),
  WebSocketControllerCtor,
}) {
  const detectPortImport = hostModule.__get__("detect_port_1");
  const detector = hostModule.__get__("InternalIpDetector_1")
    .InternalIpDetector;
  const webSocketServerImport = hostModule.__get__("WebSocketServer_1");
  const originalDetectPort = detectPortImport.default;
  const originalDetectIPv4 = detector.detectInternalIPv4;
  const originalWebSocketController = webSocketServerImport.WebSocketController;

  detectPortImport.default = detectPortImpl;
  detector.detectInternalIPv4 = detectIPv4Impl;
  webSocketServerImport.WebSocketController = WebSocketControllerCtor;

  return () => {
    detectPortImport.default = originalDetectPort;
    detector.detectInternalIPv4 = originalDetectIPv4;
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

function createListSessionMessage(clientId) {
  return JSON.stringify({
    event: "Customized",
    data: {
      type: "ListSession",
      data: [],
      sender: clientId,
    },
    from: clientId,
  });
}

function createSessionListMessage(clientId, sessions) {
  return JSON.stringify({
    event: "Customized",
    data: {
      type: "SessionList",
      data: sessions,
      sender: clientId,
    },
  });
}

describe("MultiplexerDaemonHost", function () {
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
    setDriverReportService(null);
    defaultLogger.setOutput(() => {});
  });

  it("uses an injected physical connector for tests and embedding", async function () {
    const physical = new FakePhysicalConnector();
    const host = new MultiplexerDaemonHost({
      physicalConnector: physical,
      controlEndpoint: "/tmp/debug-router-host-control.sock",
      protocolVersion: 3,
      multiplexerDaemonIdleTimeout: -1,
      connectionTrace: {
        enabled: true,
        output: { write() {} },
      },
    });
    const snapshot = host.createSnapshot();
    const controlServer = attachControlServer(host);

    assert.strictEqual(host.physicalConnector, physical);
    assert.deepStrictEqual(snapshot.devices, []);
    assert.deepStrictEqual(snapshot.clients, []);
    assert.strictEqual("connectionTrace" in snapshot, false);
    assert.deepStrictEqual(controlServer.targeted, []);
    assert.strictEqual("webSocketServerStarted" in snapshot, false);
    assert.strictEqual("webSocketServerInfo" in snapshot, false);
    assert.strictEqual("wss" in snapshot, false);
    await host.stop();
  });

  it("records facade-level USB and WebSocket lifecycle facts only in the daemon", async function () {
    const { host, physical } = createHost({
      connectionTrace: {
        enabled: true,
        output: { write() {} },
      },
    });
    const controlServer = attachControlServer(host);
    bindHostEvents(host);
    const usbClient = new UsbClient(createClient(3).info, {
      close() {},
    });
    physical.emit("client-connected", usbClient);
    physical.emit("client-disconnected", usbClient.clientId());
    const websocketClient = createWebSocketClient(30, "runtime");
    host.emit("websocket-app-client-connected", websocketClient);
    host.emit("websocket-app-client-disconnected", 30);

    const trace = host.connectionTraceRecorder.getRecentNodes();
    assert.deepStrictEqual(
      trace.map((node) => node.event),
      [
        "app_client_connected",
        "app_client_disconnected",
        "websocket_app_client_connected",
        "websocket_app_client_disconnected",
      ]
    );
    assert.deepStrictEqual(controlServer.targeted, []);
    await host.stop();
  });

  it("does not expose physical devices before legacy ownership is attached", async function () {
    const { host, physical } = createHost();
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);
    host.legacyOwnershipGuard.currentStatus = "unInit";

    assert.strictEqual(host.legacyOwnershipAttached, false);
    assert.deepStrictEqual(await host.getDevices(), []);
  });

  it("records daemon and control socket lifecycle facts in order", async function () {
    FakeStartControlServer.instances = [];
    FakeStartControlServer.startError = null;
    FakeStartControlServer.stopError = null;
    const resetControlServer = replaceControlServerForStart();
    const trace = [];
    const { host } = createHost({
      protocolVersion: 3,
      debugInfo: {
        daemonVersion: "0.0.3",
      },
      connectionTrace: {
        enabled: true,
        output: {
          write(line) {
            trace.push(JSON.parse(line));
          },
        },
      },
    });

    try {
      await host.start();
      assert.strictEqual(host.isInUse(), false);
      host.handleControlConnected(7);
      assert.strictEqual(host.isInUse(), true);
      host.handleControlDisconnected(7);
      assert.strictEqual(host.isInUse(), false);
      await host.stop();
      await host.stop();

      assert.deepStrictEqual(
        trace.map((node) => node.event),
        [
          "daemon_started",
          "legacy_ownership_attached",
          "control_socket_connected",
          "control_socket_disconnected",
          "daemon_stopped",
        ]
      );
      assert.deepStrictEqual(trace[0].metadata, {
        pid: process.pid,
        controlEndpoint: "/tmp/debug-router-host-control.sock",
        protocolVersion: 3,
        debugInfo: {
          protocolVersion: 3,
          daemonVersion: "0.0.3",
          processId: process.pid,
          timestamp: 1000,
        },
      });
      assert.deepStrictEqual(trace[1].metadata, {
        ownerPid: 100,
        reason: "daemon-started",
      });
      assert.deepStrictEqual(trace[2].metadata, {
        controlId: 7,
        activeControlCount: 1,
      });
      assert.deepStrictEqual(trace[3].metadata, {
        controlId: 7,
        activeControlCount: 0,
      });
      assert.deepStrictEqual(trace[4].metadata, {
        pid: process.pid,
      });
      assert.deepStrictEqual(
        trace.map((node) => node.sequence),
        [1, 2, 3, 4, 5]
      );
    } finally {
      resetControlServer();
    }
  });

  it("starts the fixed control endpoint once and stops idempotently", async function () {
    FakeStartControlServer.instances = [];
    FakeStartControlServer.startError = null;
    FakeStartControlServer.stopError = null;
    const resetControlServer = replaceControlServerForStart();
    const { host, physical } = createHost();

    try {
      await host.start();
      await host.start();

      assert.strictEqual(FakeStartControlServer.instances.length, 1);
      assert.strictEqual(
        FakeStartControlServer.instances[0].controlEndpoint,
        "/tmp/debug-router-host-control.sock"
      );
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

  it("sends an initial snapshot and attached ownership state to newly connected controls", function () {
    const { host, physical } = createHost({
      protocolVersion: 2,
      debugInfo: {
        daemonVersion: "0.0.2",
      },
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
            debugInfo: {
              protocolVersion: 2,
              daemonVersion: "0.0.2",
              processId: process.pid,
              timestamp: 1234,
            },
          },
        },
      },
      {
        controlId: 42,
        event: {
          kind: "event",
          event: "legacy-ownership-changed",
          data: {
            status: "attached",
            ownerPid: process.pid,
            reason: "daemon-started",
          },
        },
      },
    ]);

    const wifiRuntime = createWebSocketClient(23);
    const { controller } = createWebSocketControllerState([wifiRuntime]);
    host.webSocketController = controller;
    sendAppMessageWithoutReply(
      host,
      56,
      23,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 10,
          clientId: 23,
          method: "Runtime.evaluate",
          messageAsString: false,
        })
      )
    );
    const wifiGlobalId = readCustomizedInner(
      JSON.parse(wifiRuntime.state.sendMessageCalls[0])
    ).id;
    host.handleWebSocketAppMessage(
      23,
      JSON.stringify(
        createCustomizedEnvelope({
          id: wifiGlobalId,
          result: { value: 43 },
          messageAsString: false,
        })
      )
    );

    assert.deepStrictEqual(controlServer.targeted[2], {
      controlId: 56,
      event: {
        kind: "event",
        event: "client-message",
        data: {
          source: "websocket-runtime",
          id: 23,
          message: JSON.stringify(
            createCustomizedEnvelope({
              id: 10,
              result: { value: 43 },
              messageAsString: false,
            })
          ),
        },
      },
    });
    assert.deepStrictEqual(controlServer.broadcasts, []);
  });

  it("serializes device and client snapshots from their public info", function () {
    const { host, physical } = createHost();
    const device = createDevice("device-1", {
      host: "127.0.0.1",
    });
    const client = createClient(2, {
      rawInfo: { App: "Demo" },
      sdkVersion: "2.0.0",
    });
    physical.devices.set(device.serial, device);
    physical.usbClients.set(client.clientId(), client);

    const snapshot = host.createSnapshot();

    assert.deepStrictEqual(snapshot.devices, [
      {
        os: "Android",
        title: "Device device-1",
        serial: "device-1",
        ports: [8901, 8902],
        host: "127.0.0.1",
      },
    ]);
    assert.deepStrictEqual(snapshot.clients, [{ ...client.info }]);
  });

  it("preserves missing WebSocket raw_info in wire snapshots", function () {
    const { host } = createHost({
      enableWebSocket: true,
    });
    const driver = createWebSocketClient(4, "Driver");
    driver.info.raw_info = undefined;
    const { controller } = createWebSocketControllerState([], [driver]);
    host.webSocketController = controller;

    const wireSnapshot = JSON.parse(JSON.stringify(host.createSnapshot()));
    const wireDriver = wireSnapshot.websocketWebClients[0];

    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(wireDriver, "raw_info"),
      true
    );
    assert.strictEqual(wireDriver.raw_info, null);
    assert.strictEqual(
      isControlEvent({
        kind: "event",
        event: "snapshot",
        data: wireSnapshot,
      }),
      true
    );
  });

  it("broadcasts physical lifecycle snapshots and unified USB message events", async function () {
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
      ["snapshot", "snapshot", "client-message", "snapshot", "snapshot"]
    );
    assert.deepStrictEqual(controlServer.broadcasts[0].data.devices, [
      {
        os: "Android",
        title: "Device device-1",
        serial: "device-1",
        ports: [8901, 8902],
        host: "localhost",
      },
    ]);
    assert.deepStrictEqual(controlServer.broadcasts[2].data, {
      source: "usb-runtime",
      id: 7,
      message: '{"event":"Customized"}',
    });
  });

  it("sends the current unattached ownership state to a newly connected control", function () {
    const { host } = createHost({
      legacyOwnershipAttached: false,
    });
    const controlServer = attachControlServer(host);

    host.handleControlConnected(43);

    assert.deepStrictEqual(controlServer.targeted[1], {
      controlId: 43,
      event: {
        kind: "event",
        event: "legacy-ownership-changed",
        data: {
          status: "unattached",
          ownerPid: process.pid,
          reason: "legacy-preempted",
        },
      },
    });
  });

  it("hides devices, removes runtimes, keeps Driver clients, and publishes one real state after ownership loss", async function () {
    const { host, physical } = createHost({
      now: () => 3000,
    });
    const controlServer = attachControlServer(host);
    bindHostEvents(host);
    const device = createDevice("device-1");
    const client = createClient(7, {
      deviceId: "device-1",
    });
    const wifiRuntime = createWebSocketClient(30, "runtime");
    const driver = createWebSocketClient(30, "Driver");
    const {
      controller: webSocketController,
      state: webSocketControllerState,
    } = createWebSocketControllerState([wifiRuntime], [driver]);
    physical.devices.set(device.serial, device);
    physical.usbClients.set(client.clientId(), client);
    host.webSocketController = webSocketController;

    host.legacyOwnershipGuard.emitStatus("unattached", "legacy-preempted", 200);

    assert.strictEqual(host.legacyOwnershipAttached, false);
    assert.strictEqual(physical.disableAllClientsCalls, 1);
    assert.strictEqual(device.state.stopWatchCalls, 1);
    assert.strictEqual(client.state.closeCalls, 1);
    assert.strictEqual(physical.devices.size, 1);
    assert.strictEqual(physical.usbClients.size, 0);
    assert.deepStrictEqual(await host.getDevices(), []);
    assert.deepStrictEqual(host.getAllUsbClients(), []);
    assert.deepStrictEqual(
      controlServer.broadcasts.map((event) => event.event),
      ["snapshot", "legacy-ownership-changed"]
    );
    assert.deepStrictEqual(controlServer.broadcasts[0].data, {
      protocolVersion: MULTIPLEXER_PROTOCOL_VERSION,
      generatedAt: 3000,
      devices: [],
      clients: [],
      websocketAppClients: [],
      websocketWebClients: [
        {
          id: 30,
          type: "Driver",
          app: "wifi-app-30",
          deviceModel: "Pixel",
          osVersion: "14",
          sdkVersion: "2.0.0",
          debugRouterVersion: "1.0.0",
          network: "WiFi",
          raw_info: {
            app: "wifi-app-30",
          },
        },
      ],
    });
    assert.deepStrictEqual(controlServer.broadcasts[1].data, {
      status: "unattached",
      ownerPid: 100,
      previousOwnerPid: 200,
      reason: "legacy-preempted",
    });
    assert.strictEqual(wifiRuntime.state.closeCalls, 1);
    assert.strictEqual(driver.state.closeCalls, 0);
    assert.deepStrictEqual(Array.from(webSocketControllerState.appMap.keys()), [
      30,
    ]);
    assert.deepStrictEqual(Array.from(webSocketControllerState.webMap.keys()), [
      30,
    ]);
    assert.strictEqual(webSocketControllerState.sendDeviceListCalls, 0);
    assert.strictEqual(webSocketControllerState.sendClientListCalls, 1);

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

  it("lets in-flight device connection complete after legacy ownership is lost", async function () {
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

    host.legacyOwnershipGuard.emitStatus("unattached", "legacy-preempted", 200);
    deferred.resolve([device]);

    const result = await discovery;
    assert.deepStrictEqual(
      result.map((snapshot) => snapshot.serial),
      ["device-1"]
    );
    assert.deepStrictEqual(physical.startWatchClientCalls, []);
  });

  it("startAllDeviceClientWatchers reacquires legacy ownership and restores watchers", async function () {
    const { host, physical } = createHost({
      connectionTrace: {
        enabled: true,
        output: { write() {} },
      },
    });
    const controlServer = attachControlServer(host);
    const device = createDevice("device-1");
    const webSocketController = createWebSocketControllerProbe();
    host.webSocketController = webSocketController;
    physical.devices.set(device.serial, device);

    host.legacyOwnershipGuard.emitStatus("unattached", "legacy-preempted", 200);
    await host.handleControlRpc(
      1,
      createRpcRequest("startAllDeviceClientWatchers", {})
    );
    assert.deepStrictEqual(await host.getDevices(), [device]);

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
    assert.strictEqual(webSocketController.sendDeviceListCalls, 0);
    assert.strictEqual(webSocketController.sendClientListCalls, 2);
    assert.deepStrictEqual(
      host.connectionTraceRecorder.getRecentNodes().map((node) => ({
        event: node.event,
        metadata: node.metadata,
      })),
      [
        {
          event: "legacy_ownership_lost",
          metadata: {
            ownerPid: 100,
            previousOwnerPid: 200,
            reason: "legacy-preempted",
          },
        },
        {
          event: "legacy_ownership_attached",
          metadata: {
            ownerPid: 100,
            reason: "reacquire-requested",
          },
        },
      ]
    );
  });

  it("shutdownDaemon schedules the explicit daemon shutdown handler", async function () {
    const { host } = createHost({
      connectionTrace: {
        enabled: true,
        output: { write() {} },
      },
    });
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
    assert.deepStrictEqual(
      host.connectionTraceRecorder.getRecentNodes().map((node) => ({
        event: node.event,
        metadata: node.metadata,
      })),
      [
        {
          event: "daemon_shutdown_requested",
          metadata: {
            reason: "stale-daemon",
          },
        },
      ]
    );
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

  it("connectDevices forwards each device query and watches later device events", async function () {
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
        timeout: 10,
        serial: "device-1",
      },
      {
        timeout: 20,
        serial: null,
      },
    ]);
    assert.deepStrictEqual(physical.getDevicesCalls, [
      {
        timeout: 10,
        serial: "device-1",
      },
      {
        timeout: 20,
        serial: null,
      },
    ]);
    assert.deepStrictEqual(physical.startWatchClientCalls, ["device-2"]);
    assert.strictEqual(device.state.startWatchCalls, 0);
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

  it("manualConnect controls whether connected-device events start watchers", async function () {
    const manual = createHost({
      manualConnect: true,
    });
    const autoDisabled = createHost();
    const manualDevice = createDevice("manual-device");
    const disabledDevice = createDevice("disabled-device");
    bindHostEvents(manual.host);
    bindHostEvents(autoDisabled.host);

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
    manual.physical.devices.set(manualDevice.serial, manualDevice);
    manual.physical.emit("device-connected", manualDevice);
    autoDisabled.physical.devices.set(disabledDevice.serial, disabledDevice);
    autoDisabled.physical.emit("device-connected", disabledDevice);
    await nextTick();

    assert.deepStrictEqual(manual.physical.startWatchClientCalls, []);
    assert.deepStrictEqual(autoDisabled.physical.startWatchClientCalls, [
      "disabled-device",
    ]);
  });

  it("forwards concurrent device connection requests independently", async function () {
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

    assert.strictEqual(physical.connectDevicesCalls.length, 2);
  });

  it("connectUsbClients watches the target device once and uses getDeviceUsbClients by default", async function () {
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

    assert.deepStrictEqual(physical.connectDevicesCalls, []);
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
        sdk_version: undefined,
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
    host.clientWatcherStartingByDeviceId.set("device-1", deferred.promise);

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
    assert.deepStrictEqual(physical.getDeviceUsbClientsCalls, []);
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

  it("startDeviceClientWatcher watches each existing device only once", async function () {
    const { host, physical } = createHost();
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);

    await host.handleControlRpc(
      1,
      createRpcRequest("startDeviceClientWatcher", {
        deviceId: "device-1",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("startDeviceClientWatcher", {
        deviceId: "device-1",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("startDeviceClientWatcher", {
        deviceId: "missing-device",
      })
    );

    assert.deepStrictEqual(physical.connectDevicesCalls, []);
    assert.deepStrictEqual(physical.startWatchClientCalls, ["device-1"]);
    assert.strictEqual(device.state.startWatchCalls, 1);
  });

  it("stopDeviceClientWatcher stops existing device watchers, ignores missing devices, and allows later restart", async function () {
    const { host, physical } = createHost();
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);

    await host.handleControlRpc(
      1,
      createRpcRequest("startDeviceClientWatcher", {
        deviceId: "device-1",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("stopDeviceClientWatcher", {
        deviceId: "device-1",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("stopDeviceClientWatcher", {
        deviceId: "missing-device",
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("startDeviceClientWatcher", {
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
      createRpcRequest("startDeviceClientWatcher", {
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
      createRpcRequest("startDeviceClientWatcher", {
        deviceId: "device-1",
      })
    );

    assert.strictEqual(device.state.disconnectCalls, 1);
    assert.deepStrictEqual(physical.startWatchClientCalls, [
      "device-1",
      "device-1",
    ]);
  });

  it("startAllDeviceClientWatchers watches current and future devices", async function () {
    const { host, physical } = createHost();
    const firstDevice = createDevice("device-1");
    const secondDevice = createDevice("device-2");
    physical.devices.set(firstDevice.serial, firstDevice);
    attachControlServer(host);
    bindHostEvents(host);

    await host.handleControlRpc(
      1,
      createRpcRequest("startAllDeviceClientWatchers", {})
    );
    physical.devices.set(secondDevice.serial, secondDevice);
    physical.emit("device-connected", secondDevice);
    await nextTick();

    assert.deepStrictEqual(physical.startWatchClientCalls, [
      "device-1",
      "device-2",
    ]);
  });

  it("stopAllDeviceClientWatchers force-disables current clients while auto-watching later devices", async function () {
    const { host, physical } = createHost();
    const firstDevice = createDevice("device-1");
    const secondDevice = createDevice("device-2");
    const laterDevice = createDevice("device-3");
    const usbRuntime = createClient(7);
    const wifiRuntime = createWebSocketClient(8, "runtime");
    const driver = createWebSocketClient(9, "Driver");
    const { controller } = createWebSocketControllerState(
      [wifiRuntime],
      [driver]
    );
    physical.devices.set(firstDevice.serial, firstDevice);
    physical.devices.set(secondDevice.serial, secondDevice);
    physical.usbClients.set(usbRuntime.clientId(), usbRuntime);
    host.webSocketController = controller;
    attachControlServer(host);
    bindHostEvents(host);

    await host.handleControlRpc(
      1,
      createRpcRequest("startAllDeviceClientWatchers", {})
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("stopAllDeviceClientWatchers", {})
    );

    physical.devices.set(laterDevice.serial, laterDevice);
    physical.emit("device-connected", laterDevice);
    await nextTick();

    assert.deepStrictEqual(physical.startWatchClientCalls, [
      "device-1",
      "device-2",
      "device-3",
    ]);
    assert.strictEqual(physical.disableAllClientsCalls, 1);
    assert.strictEqual(firstDevice.state.stopWatchCalls, 1);
    assert.strictEqual(secondDevice.state.stopWatchCalls, 1);
    assert.strictEqual(laterDevice.state.startWatchCalls, 1);
    assert.strictEqual(usbRuntime.state.closeCalls, 1);
    assert.strictEqual(wifiRuntime.state.closeCalls, 1);
    assert.strictEqual(driver.state.closeCalls, 0);
  });

  it("stopAllDeviceClientWatchers waits for an in-flight watcher before stopping it", async function () {
    const deferred = createDeferred();
    const { host, physical } = createHost({
      startWatchClientImpl: async (device, shouldStart) => {
        await deferred.promise;
        if (shouldStart()) {
          device.startWatchClient();
        }
      },
    });
    const device = createDevice("device-1");
    physical.devices.set(device.serial, device);

    const starting = host.handleControlRpc(
      1,
      createRpcRequest("startAllDeviceClientWatchers", {})
    );
    await nextTick();
    const stopping = host.handleControlRpc(
      1,
      createRpcRequest("stopAllDeviceClientWatchers", {})
    );

    deferred.resolve();
    await Promise.all([starting, stopping]);

    assert.deepStrictEqual(physical.startWatchClientCalls, ["device-1"]);
    assert.strictEqual(device.state.startWatchCalls, 1);
    assert.strictEqual(device.state.stopWatchCalls, 1);
    assert.deepStrictEqual(Array.from(host.clientWatcherStartedDeviceIds), []);
  });

  it("routes sendMessageWithReply and sendMessageWithoutReply RPCs through Host", async function () {
    const { host, physical } = createHost();
    const controlServer = attachControlServer(host);
    const client = createClient(12);
    const rawMessage = createCustomizedEnvelope({
      id: 66,
      clientId: 12,
      method: "Runtime.getProperties",
      sessionId: 7,
    });
    physical.usbClients.set(client.clientId(), client);

    const rawResultPromise = host.handleControlRpc(
      1,
      createRpcRequest("sendMessageWithReply", {
        clientId: 12,
        message: rawMessage,
      })
    );
    const rawGlobalMessageId = readCustomizedInner(
      client.state.sendMessageCalls[0]
    ).id;
    assert.notStrictEqual(rawGlobalMessageId, 66);
    host.handlePhysicalMessage(
      12,
      JSON.stringify(
        createCustomizedEnvelope({
          id: rawGlobalMessageId,
          result: { raw: true },
          clientId: -1,
          sessionId: 7,
          messageAsString: true,
        })
      )
    );
    const rawResult = await rawResultPromise;

    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessageWithoutReply", {
        target: "app",
        clientId: 12,
        message: createCustomizedEnvelope({
          id: 77,
          clientId: 12,
          method: "Runtime.evaluate",
        }),
      })
    );

    const globalMessageId = readCustomizedInner(
      client.state.sendMessageCalls[1]
    ).id;
    assert.notStrictEqual(globalMessageId, 77);
    assert.notStrictEqual(host.pendingRoutes.get(globalMessageId), null);

    host.handlePhysicalMessage(
      12,
      JSON.stringify(
        createCustomizedEnvelope({
          id: globalMessageId,
          result: { value: 42 },
          messageAsString: true,
        })
      )
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
        type: "CDP",
        data: {
          client_id: 12,
          session_id: 7,
          message: JSON.stringify({
            id: 66,
            result: { raw: true },
          }),
        },
        sender: 0,
      },
    });
    assert.deepStrictEqual(physical.sendRawMessageCalls, []);
    assert.deepStrictEqual(physical.sendMessageCalls, []);
    assert.strictEqual(client.state.sendMessageCalls.length, 2);
    assert.strictEqual(host.pendingRoutes.get(globalMessageId), null);
    assert.strictEqual(controlServer.targeted.length, 1);
    assert.strictEqual(controlServer.targeted[0].controlId, 1);
    assert.deepStrictEqual(
      readCustomizedInner(controlServer.targeted[0].event.data.message),
      {
        id: 77,
        result: { value: 42 },
      }
    );
    assert.deepStrictEqual(physical.closeClientCalls, [12]);
    assert.strictEqual(client.state.closeCalls, 1);
  });

  it("sendMessageWithReply rejects when Host cannot find the runtime client", async function () {
    const { host } = createHost();

    await assert.rejects(
      () =>
        host.handleControlRpc(
          1,
          createRpcRequest("sendMessageWithReply", {
            clientId: 500,
            message: {
              event: "Initialize",
              data: 500,
            },
          })
        ),
      (error) => {
        assertControlError(
          error,
          "multiplexer-client-not-found",
          /Multiplexer client was not found: 500/
        );
        return true;
      }
    );
  });

  it("sendMessageWithoutReply app target rewrites USB messages, filters USB connect handshakes, and rejects invalid JSON", async function () {
    const { host, physical } = createHost();
    const client = createClient(13);
    physical.usbClients.set(client.clientId(), client);

    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessageWithoutReply", {
        target: "app",
        clientId: 13,
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
      createRpcRequest("sendMessageWithoutReply", {
        target: "app",
        clientId: 13,
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
      createRpcRequest("sendMessageWithoutReply", {
        target: "app",
        clientId: 13,
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
          createRpcRequest("sendMessageWithoutReply", {
            target: "app",
            clientId: 13,
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

  it("sendMessageWithoutReply app target preserves missing and zero client_id values", async function () {
    const { host, physical } = createHost();
    const client = createClient(14);
    physical.usbClients.set(client.clientId(), client);

    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessageWithoutReply", {
        target: "app",
        clientId: 14,
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
      createRpcRequest("sendMessageWithoutReply", {
        target: "app",
        clientId: 14,
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

  it("sendMessageWithoutReply app target rejects missing clients before attempting control or websocket routing", async function () {
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
          createRpcRequest("sendMessageWithoutReply", {
            target: "app",
            clientId: 404,
            message: "{}",
          })
        ),
      (error) => {
        assertControlError(
          error,
          "multiplexer-client-not-found",
          /Multiplexer client was not found: 404/
        );
        return true;
      }
    );
    await assert.rejects(
      () =>
        enabled.host.handleControlRpc(
          1,
          createRpcRequest("sendMessageWithoutReply", {
            target: "app",
            clientId: 404,
            message: "{}",
          })
        ),
      (error) => {
        assertControlError(
          error,
          "multiplexer-client-not-found",
          /Multiplexer client was not found: 404/
        );
        return true;
      }
    );
  });

  it("routes Driver requests through WiFi runtimes and restores responses to the originating Driver", function () {
    const { host } = createHost({
      enableWebSocket: true,
    });
    const runtime = createWebSocketClient(90);
    const { controller, state } = createWebSocketControllerState([runtime]);
    const controlServer = attachControlServer(host);
    host.webSocketController = controller;
    host.webSocketRequesterControlIds.add(1);

    host.handleWebSocketDriverMessage(
      800,
      90,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 44,
          clientId: 90,
          method: "Runtime.evaluate",
          messageAsString: true,
        })
      )
    );

    assert.strictEqual(runtime.state.sendMessageCalls.length, 1);
    const routedEnvelope = JSON.parse(runtime.state.sendMessageCalls[0]);
    const routedId = readCustomizedInner(routedEnvelope).id;
    assert.notStrictEqual(routedId, 44);
    assert.strictEqual(
      routedEnvelope.data.data.client_id,
      90,
      "WiFi runtimes must receive the positive id assigned by Initialize"
    );

    host.handleWebSocketAppMessage(
      90,
      JSON.stringify(
        createCustomizedEnvelope({
          id: routedId,
          result: { value: 2 },
          clientId: -1,
          messageAsString: true,
        })
      )
    );

    assert.strictEqual(state.webMessages.length, 1);
    assert.strictEqual(state.webMessages[0].kind, "targeted");
    assert.strictEqual(state.webMessages[0].webClientId, 800);
    assert.strictEqual(
      readCustomizedInner(JSON.parse(state.webMessages[0].message)).id,
      44
    );
    assert.deepStrictEqual(controlServer.broadcasts, []);
    assert.deepStrictEqual(controlServer.targeted, []);
  });

  it("serializes WebSocket lifecycle state without letting WiFi runtimes prevent idle shutdown", async function () {
    const { host } = createHost({
      enableWebSocket: true,
    });
    const runtime = createWebSocketClient(91, "runtime", {
      rawInfo: { app: "wifi-runtime" },
    });
    const driver = createWebSocketClient(92, "Driver");
    const { controller, state } = createWebSocketControllerState(
      [runtime],
      [driver]
    );
    const controlServer = attachControlServer(host);
    host.webSocketController = controller;
    host.webSocketRequesterControlIds.add(1);

    host.emit("websocket-app-client-connected", runtime);
    assert.strictEqual(host.isInUse(), false);
    host.emit("websocket-web-client-connected", driver);

    const snapshot = host.createSnapshot();
    assert.deepStrictEqual(
      snapshot.websocketAppClients.map((client) => client.id),
      [91]
    );
    assert.deepStrictEqual(
      snapshot.websocketWebClients.map((client) => client.id),
      [92]
    );
    assert.strictEqual(host.isInUse(), true);
    assert.deepStrictEqual(controlServer.broadcasts, []);
    assert.deepStrictEqual(
      controlServer.targeted.map(({ controlId, event }) => [
        controlId,
        event.event,
      ]),
      [
        [1, "snapshot"],
        [1, "snapshot"],
      ]
    );

    const pending = host.handleControlRpc(
      77,
      createRpcRequest("sendMessageWithReply", {
        clientId: 91,
        message: createCustomizedEnvelope({
          id: 81,
          clientId: 91,
          method: "Runtime.evaluate",
        }),
      })
    );
    state.appMap.delete(91);
    host.emit("websocket-app-client-disconnected", 91);
    await assert.rejects(
      () => pending,
      /Multiplexer runtime client 91 disconnected/
    );
    state.webMap.delete(92);
    host.emit("websocket-web-client-disconnected", 92);
    assert.strictEqual(host.isInUse(), false);
  });

  it("targets WiFi runtimes when Driver and app client ids collide", async function () {
    const { host } = createHost({ enableWebSocket: true });
    const runtime = createWebSocketClient(93);
    const driver = createWebSocketClient(93, "Driver");
    const { controller } = createWebSocketControllerState([runtime], [driver]);
    host.webSocketController = controller;
    const rawWifiMessage = JSON.stringify({ event: "Ping" });

    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessageWithoutReply", {
        target: "app",
        clientId: 93,
        message: rawWifiMessage,
      })
    );
    const resultPromise = host.handleControlRpc(
      1,
      createRpcRequest("sendMessageWithReply", {
        clientId: 93,
        message: createCustomizedEnvelope({
          id: 82,
          clientId: 93,
          method: "Runtime.call",
          params: { value: true },
          sessionId: 3,
          type: "App",
        }),
      })
    );
    const routedEnvelope = JSON.parse(runtime.state.sendMessageCalls[1]);
    const routedRequest = readCustomizedInner(routedEnvelope);
    assert.strictEqual(routedEnvelope.data.data.client_id, 93);
    host.handleWebSocketAppMessage(
      93,
      JSON.stringify(
        createCustomizedEnvelope({
          id: routedRequest.id,
          result: { value: "runtime-result" },
          clientId: -1,
        })
      )
    );
    const result = await resultPromise;
    await host.handleControlRpc(
      1,
      createRpcRequest("closeClient", { clientId: 93 })
    );

    assert.strictEqual(runtime.state.sendMessageCalls[0], rawWifiMessage);
    assert.strictEqual(runtime.state.sendMessageCalls.length, 2);
    assert.strictEqual(runtime.state.closeCalls, 1);
    assert.deepStrictEqual(JSON.parse(result.data.data.message).result, {
      value: "runtime-result",
    });
    assert.deepStrictEqual(driver.state.sendMessageCalls, []);
    assert.deepStrictEqual(driver.state.sendCustomizedCalls, []);
    assert.strictEqual(driver.state.closeCalls, 0);
  });

  it("startWSServer rejects when websocket is disabled", async function () {
    const disabled = createHost({
      enableWebSocket: false,
    });

    await assert.rejects(
      () =>
        disabled.host.handleControlRpc(
          1,
          createRpcRequest("startWSServer", {})
        ),
      (error) =>
        error.code === "websocket-disabled" &&
        error.message ===
          "The multiplexer daemon does not support WebSocket because enableWebSocket is disabled"
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

      getAllWebsocketAppClients() {
        return new Map();
      }

      getAllWebsocketWebClients() {
        return new Map();
      }

      sendMessageToWeb() {}

      sendMessageToWebClient() {}
    }
    const reset = replaceWebSocketStartDependencies({
      detectPortImpl: async (port) => {
        assert.strictEqual(port, 19783);
        return 19001;
      },
      detectIPv4Impl: async () => ({ selected: { address: "10.0.0.5" } }),
      WebSocketControllerCtor: FakeWebSocketController,
    });
    const { host, physical } = createHost({
      enableWebSocket: true,
      websocketOption: {
        port: 19000,
        roomId: "room-a",
      },
    });
    const controlServer = attachControlServer(host);

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
      assert.deepStrictEqual(
        controlServer.targeted.map(({ controlId, event }) => [
          controlId,
          event.event,
        ]),
        [
          [1, "snapshot"],
          [1, "snapshot"],
        ]
      );
    } finally {
      reset();
    }
  });

  it("keeps the shared websocket server after all requesting controls disconnect", async function () {
    const instances = [];
    class FakeWebSocketController {
      constructor(_controllerHost, option) {
        this.closeCalls = 0;
        instances.push(this);
        option.callback();
      }

      close() {
        this.closeCalls++;
      }

      getAllWebsocketAppClients() {
        return new Map();
      }

      getAllWebsocketWebClients() {
        return new Map();
      }

      sendMessageToWeb() {}

      sendMessageToWebClient() {}
    }
    const reset = replaceWebSocketStartDependencies({
      detectPortImpl: async () => 19001,
      detectIPv4Impl: async () => ({ selected: { address: "127.0.0.1" } }),
      WebSocketControllerCtor: FakeWebSocketController,
    });
    const trace = [];
    const { host } = createHost({
      enableWebSocket: true,
      connectionTrace: {
        enabled: true,
        output: {
          write(line) {
            trace.push(JSON.parse(line));
          },
        },
      },
    });

    try {
      host.handleControlConnected(1);
      host.handleControlConnected(2);
      await host.handleControlRpc(1, createRpcRequest("startWSServer", {}));
      await host.handleControlRpc(2, createRpcRequest("startWSServer", {}));

      host.handleControlDisconnected(1);
      assert.strictEqual(instances[0].closeCalls, 0);
      assert.strictEqual(host.webSocketController, instances[0]);

      host.handleControlDisconnected(2);
      assert.strictEqual(instances[0].closeCalls, 0);
      assert.strictEqual(host.webSocketController, instances[0]);
      assert.deepStrictEqual(host.webSocketServerInfo, {
        port: 19001,
        host: "127.0.0.1:19001",
        roomId: undefined,
      });
      assert.strictEqual(host.webSocketServerStarted, true);
      await host.stop();
      assert.strictEqual(instances[0].closeCalls, 1);
      assert.deepStrictEqual(
        trace
          .filter((node) => node.event.startsWith("websocket_server_"))
          .map((node) => ({
            event: node.event,
            metadata: node.metadata,
          })),
        [
          {
            event: "websocket_server_started",
            metadata: {
              port: 19001,
              host: "127.0.0.1:19001",
            },
          },
          {
            event: "websocket_server_stopped",
            metadata: {
              port: 19001,
              host: "127.0.0.1:19001",
              reason: "daemon_stop",
            },
          },
        ]
      );
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
    const controllers = [];
    host.startWebSocketServerInternal = async () => {
      calls++;
      const controller = {
        closeCalls: 0,
        close() {
          this.closeCalls++;
        },
      };
      controllers.push(controller);
      host.webSocketController = controller;
      throw {
        code: "custom-start-failed",
        message: "custom start failed",
      };
    };

    await assert.rejects(() =>
      host.handleControlRpc(1, createRpcRequest("startWSServer", {}))
    );
    assert.strictEqual(host.webSocketRequesterControlIds.size, 0);
    assert.strictEqual(host.webSocketController, null);
    assert.strictEqual(controllers[0].closeCalls, 1);
    await assert.rejects(() =>
      host.handleControlRpc(1, createRpcRequest("startWSServer", {}))
    );

    assert.strictEqual(calls, 2);
    assert.strictEqual(host.webSocketController, null);
    assert.strictEqual(controllers[1].closeCalls, 1);
  });

  it("sendMessageWithoutReply web broadcast returns when websocket is disabled or the server has not started", async function () {
    const disabled = createHost({
      enableWebSocket: false,
    });
    const enabled = createHost({
      enableWebSocket: true,
    });

    await disabled.host.handleControlRpc(
      1,
      createRpcRequest("sendMessageWithoutReply", {
        target: "web",
        clientId: -1,
        message: "hello",
      })
    );
    await enabled.host.handleControlRpc(
      1,
      createRpcRequest("sendMessageWithoutReply", {
        target: "web",
        clientId: -1,
        message: "hello",
      })
    );
  });

  it("sendMessageWithoutReply web target sends to the specified Driver instead of an App runtime", async function () {
    const { host } = createHost({
      enableWebSocket: true,
    });
    const { controller, state } = createWebSocketControllerState();
    host.webSocketController = controller;

    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessageWithoutReply", {
        target: "web",
        clientId: -1,
        message: { event: "broadcast" },
      })
    );
    await host.handleControlRpc(
      1,
      createRpcRequest("sendMessageWithoutReply", {
        target: "web",
        clientId: 42,
        message: "targeted",
      })
    );

    assert.deepStrictEqual(state.webMessages, [
      { kind: "broadcast", message: '{"event":"broadcast"}' },
      {
        kind: "targeted",
        webClientId: 42,
        message: "targeted",
      },
    ]);
  });

  it("coalesces concurrent ListSession queries and targets a fresh SessionList cache hit to one websocket frontend", function () {
    let now = 1000;
    const { host, physical } = createHost({
      enableWebSocket: true,
      memoizedNotificationTtlMs: 100,
      now: () => now,
    });
    const client = createClient(20);
    const webMessages = [];
    physical.usbClients.set(client.clientId(), client);
    host.webSocketController = {
      getAllWebsocketAppClients() {
        return new Map();
      },
      getAllWebsocketWebClients() {
        return new Map();
      },
      sendMessageToWeb(message) {
        webMessages.push({ kind: "broadcast", message });
      },
      sendMessageToWebClient(webClientId, message) {
        webMessages.push({ kind: "targeted", webClientId, message });
      },
      close() {},
    };

    const query = createListSessionMessage(20);
    host.handleWebSocketDriverMessage(100, 20, query);
    host.handleWebSocketDriverMessage(101, 20, query);

    assert.strictEqual(client.state.sendMessageCalls.length, 1);

    const notification = createSessionListMessage(0, [
      { session_id: 1, type: "web", url: "app://first" },
    ]);
    host.handlePhysicalMessage(20, notification);
    assert.strictEqual(webMessages.length, 1);
    assert.strictEqual(webMessages[0].kind, "broadcast");
    assert.strictEqual(JSON.parse(webMessages[0].message).data.sender, 20);

    now = 1050;
    host.handleWebSocketDriverMessage(102, 20, query);

    assert.strictEqual(client.state.sendMessageCalls.length, 1);
    assert.deepStrictEqual(webMessages.slice(1), [
      {
        kind: "targeted",
        webClientId: 102,
        message: webMessages[0].message,
      },
    ]);
  });

  it("continuously retries USB ListSession until SessionList arrives", function () {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const timers = createTimers();
    global.setTimeout = timers.setTimeout;
    global.clearTimeout = timers.clearTimeout;
    try {
      const { host, physical } = createHost({
        memoizedNotificationTtlMs: 100,
      });
      const client = createClient(201);
      physical.usbClients.set(client.clientId(), client);

      sendAppMessageWithoutReply(
        host,
        1,
        client.clientId(),
        createListSessionMessage(client.clientId())
      );
      assert.strictEqual(client.state.sendMessageCalls.length, 1);
      assert.strictEqual(timers.timers.length, 1);
      assert.strictEqual(timers.timers[0].timeoutMs, 100);

      timers.run(timers.timers[0]);
      timers.run(timers.timers[1]);
      assert.strictEqual(client.state.sendMessageCalls.length, 3);
      assert.strictEqual(timers.timers.length, 3);

      host.handlePhysicalMessage(
        client.clientId(),
        createSessionListMessage(client.clientId(), [])
      );
      assert.strictEqual(timers.timers[2].cleared, true);
      timers.run(timers.timers[2]);
      assert.strictEqual(client.state.sendMessageCalls.length, 3);
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  });

  it("continuously retries WiFi ListSession until SessionList arrives", function () {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const timers = createTimers();
    global.setTimeout = timers.setTimeout;
    global.clearTimeout = timers.clearTimeout;
    try {
      const { host } = createHost({
        enableWebSocket: true,
        memoizedNotificationTtlMs: 100,
      });
      const client = createWebSocketClient(202, "runtime");
      const { controller } = createWebSocketControllerState([client]);
      host.webSocketController = controller;

      host.handleWebSocketDriverMessage(
        1,
        client.clientId(),
        createListSessionMessage(client.clientId())
      );
      assert.strictEqual(client.state.sendMessageCalls.length, 1);

      timers.run(timers.timers[0]);
      timers.run(timers.timers[1]);
      assert.strictEqual(client.state.sendMessageCalls.length, 3);

      host.handleWebSocketAppMessage(
        client.clientId(),
        createSessionListMessage(client.clientId(), [])
      );
      assert.strictEqual(timers.timers[2].cleared, true);
      timers.run(timers.timers[2]);
      assert.strictEqual(client.state.sendMessageCalls.length, 3);
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  });

  it("retries ListSession after pending or cached data becomes stale", function () {
    let now = 2000;
    const { host, physical } = createHost({
      memoizedNotificationTtlMs: 100,
      now: () => now,
    });
    const client = createClient(21);
    const controlServer = attachControlServer(host);
    const query = createListSessionMessage(21);
    physical.usbClients.set(client.clientId(), client);

    sendAppMessageWithoutReply(host, 1, 21, query);
    now = 2050;
    sendAppMessageWithoutReply(host, 2, 21, query);
    assert.strictEqual(client.state.sendMessageCalls.length, 1);

    now = 2101;
    sendAppMessageWithoutReply(host, 3, 21, query);
    assert.strictEqual(client.state.sendMessageCalls.length, 2);

    host.handlePhysicalMessage(21, createSessionListMessage(21, []));
    controlServer.broadcasts.length = 0;
    now = 2150;
    sendAppMessageWithoutReply(host, 4, 21, query);
    assert.strictEqual(client.state.sendMessageCalls.length, 2);
    assert.strictEqual(
      controlServer.targeted[controlServer.targeted.length - 1].controlId,
      4
    );

    now = 2252;
    sendAppMessageWithoutReply(host, 5, 21, query);
    assert.strictEqual(client.state.sendMessageCalls.length, 3);
  });

  it("isolates memoized SessionList notifications by runtime client", function () {
    const { host, physical } = createHost({
      memoizedNotificationTtlMs: 100,
    });
    const firstClient = createClient(22);
    const secondClient = createClient(23);
    const controlServer = attachControlServer(host);
    physical.usbClients.set(firstClient.clientId(), firstClient);
    physical.usbClients.set(secondClient.clientId(), secondClient);

    host.handlePhysicalMessage(
      22,
      createSessionListMessage(22, [
        { session_id: 1, type: "web", url: "app://first" },
      ])
    );
    sendAppMessageWithoutReply(host, 6, 22, createListSessionMessage(22));
    sendAppMessageWithoutReply(host, 7, 23, createListSessionMessage(23));

    assert.strictEqual(firstClient.state.sendMessageCalls.length, 0);
    assert.strictEqual(secondClient.state.sendMessageCalls.length, 1);
    assert.strictEqual(
      controlServer.targeted[controlServer.targeted.length - 1].controlId,
      6
    );
  });

  it("does not coalesce unrelated idless Customized commands", function () {
    const { host, physical } = createHost();
    const client = createClient(24);
    physical.usbClients.set(client.clientId(), client);
    const openCard = JSON.stringify({
      event: "Customized",
      data: {
        type: "OpenCard",
        data: { type: "url", url: "app://card" },
        sender: 24,
      },
    });

    sendAppMessageWithoutReply(host, 1, 24, openCard);
    sendAppMessageWithoutReply(host, 2, 24, openCard);

    assert.strictEqual(client.state.sendMessageCalls.length, 2);
  });

  it("broadcasts idless GetGlobalSwitch responses to every control frontend", function () {
    const frontendCount = 30;
    const { host, physical } = createHost();
    const client = createClient(240);
    const controlServer = attachControlServer(host);
    physical.usbClients.set(client.clientId(), client);
    const request = JSON.stringify({
      event: "Customized",
      data: {
        type: "GetGlobalSwitch",
        data: {
          client_id: client.clientId(),
          session_id: -1,
          message: JSON.stringify({
            global_key: "enable_devtool",
            id: 10000,
          }),
        },
        sender: client.clientId(),
      },
    });

    for (let controlId = 1; controlId <= frontendCount; controlId++) {
      sendAppMessageWithoutReply(host, controlId, client.clientId(), request);
    }

    assert.strictEqual(client.state.sendMessageCalls.length, frontendCount);

    const response = JSON.stringify({
      event: "Customized",
      data: {
        type: "GetGlobalSwitch",
        data: {
          client_id: client.clientId(),
          session_id: -1,
          message: "true",
        },
        sender: 0,
      },
    });
    for (let index = 0; index < frontendCount; index++) {
      host.handlePhysicalMessage(client.clientId(), response);
    }

    assert.strictEqual(controlServer.targeted.length, 0);
    assert.strictEqual(controlServer.broadcasts.length, frontendCount);
    assert.strictEqual(
      controlServer.broadcasts.length * frontendCount,
      frontendCount * frontendCount
    );
  });

  it("targets SetGlobalSwitch responses that preserve the request id", function () {
    const frontendCount = 30;
    const { host, physical } = createHost();
    const client = createClient(241);
    const controlServer = attachControlServer(host);
    physical.usbClients.set(client.clientId(), client);
    const request = JSON.stringify({
      event: "Customized",
      data: {
        type: "SetGlobalSwitch",
        data: {
          client_id: client.clientId(),
          session_id: -1,
          message: JSON.stringify({
            global_key: "enable_devtool",
            global_value: true,
            id: 10000,
          }),
        },
        sender: client.clientId(),
      },
    });

    for (let controlId = 1; controlId <= frontendCount; controlId++) {
      sendAppMessageWithoutReply(host, controlId, client.clientId(), request);
    }
    for (const outbound of client.state.sendMessageCalls) {
      host.handlePhysicalMessage(client.clientId(), JSON.stringify(outbound));
    }

    assert.strictEqual(controlServer.broadcasts.length, 0);
    assert.strictEqual(controlServer.targeted.length, frontendCount);
    assert.deepStrictEqual(
      controlServer.targeted.map(({ controlId }) => controlId),
      Array.from({ length: frontendCount }, (_, index) => index + 1)
    );
    assert.deepStrictEqual(
      controlServer.targeted.map(({ event }) =>
        readCustomizedInner(event.data.message)
      ),
      Array.from({ length: frontendCount }, () => ({
        global_key: "enable_devtool",
        global_value: true,
        id: 10000,
      }))
    );
  });

  it("broadcasts idless SetGlobalSwitch responses to every control frontend", function () {
    const frontendCount = 30;
    const { host, physical } = createHost();
    const client = createClient(243);
    const controlServer = attachControlServer(host);
    physical.usbClients.set(client.clientId(), client);
    const request = JSON.stringify({
      event: "Customized",
      data: {
        type: "SetGlobalSwitch",
        data: {
          client_id: client.clientId(),
          session_id: -1,
          message: JSON.stringify({
            global_key: "enable_devtool",
            global_value: true,
            id: 10000,
          }),
        },
        sender: client.clientId(),
      },
    });

    for (let controlId = 1; controlId <= frontendCount; controlId++) {
      sendAppMessageWithoutReply(host, controlId, client.clientId(), request);
    }

    const response = JSON.stringify({
      event: "Customized",
      data: {
        type: "SetGlobalSwitch",
        data: {
          client_id: client.clientId(),
          session_id: -1,
          message: "true",
        },
        sender: 0,
      },
    });
    for (let index = 0; index < frontendCount; index++) {
      host.handlePhysicalMessage(client.clientId(), response);
    }

    assert.strictEqual(controlServer.targeted.length, 0);
    assert.strictEqual(controlServer.broadcasts.length, frontendCount);
    assert.strictEqual(
      controlServer.broadcasts.length * frontendCount,
      frontendCount * frontendCount
    );
  });

  it("broadcasts every SessionList notification produced after OpenCard commands", function () {
    const frontendCount = 30;
    const { host, physical } = createHost();
    const client = createClient(242);
    const controlServer = attachControlServer(host);
    physical.usbClients.set(client.clientId(), client);

    for (let controlId = 1; controlId <= frontendCount; controlId++) {
      sendAppMessageWithoutReply(
        host,
        controlId,
        client.clientId(),
        JSON.stringify({
          event: "Customized",
          data: {
            type: "OpenCard",
            data: {
              type: "url",
              url: `app://card-${controlId}`,
            },
            sender: client.clientId(),
          },
        })
      );
    }

    assert.strictEqual(client.state.sendMessageCalls.length, frontendCount);
    assert.strictEqual(controlServer.broadcasts.length, 0);

    for (let sessionCount = 1; sessionCount <= frontendCount; sessionCount++) {
      host.handlePhysicalMessage(
        client.clientId(),
        createSessionListMessage(
          client.clientId(),
          Array.from({ length: sessionCount }, (_, index) => ({
            session_id: index + 1,
            type: "web",
            url: `app://card-${index + 1}`,
          }))
        )
      );
    }

    assert.strictEqual(controlServer.targeted.length, 0);
    assert.strictEqual(controlServer.broadcasts.length, frontendCount);
    assert.strictEqual(
      controlServer.broadcasts.length * frontendCount,
      frontendCount * frontendCount
    );
  });

  it("clears memoized query state on runtime disconnect and send failure", async function () {
    const { host, physical } = createHost();
    const disconnectedClient = createClient(25);
    const retryClient = createClient(26);
    physical.usbClients.set(disconnectedClient.clientId(), disconnectedClient);
    physical.usbClients.set(retryClient.clientId(), retryClient);
    bindHostEvents(host);

    host.handlePhysicalMessage(25, createSessionListMessage(25, []));
    physical.emit("client-disconnected", 25);
    sendAppMessageWithoutReply(host, 1, 25, createListSessionMessage(25));
    assert.strictEqual(disconnectedClient.state.sendMessageCalls.length, 1);

    const sendMessage = retryClient.sendMessage;
    retryClient.sendMessage = () => {
      throw new Error("send failed");
    };
    await assert.rejects(
      () =>
        sendAppMessageWithoutReply(host, 2, 26, createListSessionMessage(26)),
      /send failed/
    );
    retryClient.sendMessage = sendMessage;
    sendAppMessageWithoutReply(host, 3, 26, createListSessionMessage(26));
    assert.strictEqual(retryClient.state.sendMessageCalls.length, 1);
  });

  it("routes concurrent websocket messages with duplicate original ids back to the originating web clients", function () {
    const { host, physical } = createHost({
      enableWebSocket: true,
    });
    const client = createClient(21);
    const webMessages = [];
    physical.usbClients.set(client.clientId(), client);
    host.webSocketController = {
      getAllWebsocketAppClients() {
        return new Map();
      },
      getAllWebsocketWebClients() {
        return new Map();
      },
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

    host.handleWebSocketDriverMessage(
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
    host.handleWebSocketDriverMessage(
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

    sendAppMessageWithoutReply(
      host,
      55,
      22,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 9,
          clientId: 22,
          method: "Runtime.evaluate",
          messageAsString: false,
        })
      )
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
          event: "client-message",
          data: {
            source: "usb-runtime",
            id: 22,
            message: JSON.stringify(
              createCustomizedEnvelope({
                id: 9,
                result: {
                  value: 42,
                },
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
      getAllWebsocketAppClients() {
        return new Map();
      },
      getAllWebsocketWebClients() {
        return new Map();
      },
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
    host.handleWebSocketAppMessage(
      32,
      JSON.stringify({
        event: "Customized",
        data: {
          type: "CDP",
          data: {
            client_id: -1,
            message: JSON.stringify({
              method: "Runtime.executionContextCreated",
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
      JSON.stringify({
        event: "Customized",
        data: {
          type: "CDP",
          data: {
            client_id: 32,
            message: JSON.stringify({
              method: "Runtime.executionContextCreated",
            }),
          },
          sender: 32,
        },
      }),
    ]);
    assert.deepStrictEqual(
      controlServer.broadcasts.map((event) => event.event),
      ["client-message", "client-message"]
    );
    assert.deepStrictEqual(
      controlServer.broadcasts.map((event) => event.data.source),
      ["usb-runtime", "websocket-runtime"]
    );
    assert.strictEqual(controlServer.broadcasts[0].data.id, 31);
    assert.strictEqual(controlServer.broadcasts[1].data.id, 32);
    assert.strictEqual(
      controlServer.broadcasts[0].data.message,
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
    assert.notStrictEqual(
      controlServer.broadcasts[0].data.message,
      webMessages[0]
    );
  });

  it("parses each runtime notification only once before routing", function () {
    const { host } = createHost();
    attachControlServer(host);
    const innerMessage = JSON.stringify({
      method: "Runtime.consoleAPICalled",
    });
    const message = JSON.stringify({
      event: "Customized",
      data: {
        type: "CDP",
        data: {
          client_id: -1,
          message: innerMessage,
        },
        sender: 0,
      },
    });
    const originalParseJsonMessageOrNull = hostModule.__get__(
      "parseJsonMessageOrNull"
    );
    const parsedMessages = [];
    const restoreParseJsonMessageOrNull = hostModule.__set__(
      "parseJsonMessageOrNull",
      (value) => {
        parsedMessages.push(value);
        return originalParseJsonMessageOrNull(value);
      }
    );

    try {
      host.handlePhysicalMessage(31, message);
    } finally {
      restoreParseJsonMessageOrNull();
    }

    assert.deepStrictEqual(parsedMessages, [message, innerMessage]);
  });

  it("drops responses from the wrong runtime without consuming the pending route", function () {
    const { host, physical } = createHost();
    const expectedClient = createClient(33);
    const wrongClient = createClient(34);
    physical.usbClients.set(expectedClient.clientId(), expectedClient);
    physical.usbClients.set(wrongClient.clientId(), wrongClient);
    const controlServer = attachControlServer(host);
    const warnings = [];
    defaultLogger.setOutput((level, ...messages) => {
      if (level === "warn") {
        warnings.push(messages.join(" "));
      }
    });

    sendAppMessageWithoutReply(
      host,
      70,
      33,
      JSON.stringify(
        createCustomizedEnvelope({
          id: 19,
          clientId: 33,
          method: "Runtime.evaluate",
          messageAsString: true,
        })
      )
    );
    const globalId = readCustomizedInner(
      expectedClient.state.sendMessageCalls[0]
    ).id;

    host.handlePhysicalMessage(
      34,
      JSON.stringify(
        createCustomizedEnvelope({
          id: globalId,
          result: { spoofed: true },
          messageAsString: true,
        })
      )
    );

    assert.notStrictEqual(host.pendingRoutes.get(globalId), null);
    assert.deepStrictEqual(controlServer.targeted, []);
    assert(
      warnings.some(
        (message) =>
          message.includes(`global message id ${globalId}`) &&
          message.includes("runtime 34") &&
          message.includes("expected runtime 33")
      )
    );

    host.handlePhysicalMessage(
      33,
      JSON.stringify(
        createCustomizedEnvelope({
          id: globalId,
          result: { value: 42 },
          messageAsString: true,
        })
      )
    );

    assert.strictEqual(host.pendingRoutes.get(globalId), null);
    assert.strictEqual(controlServer.targeted.length, 1);
    assert.strictEqual(controlServer.targeted[0].controlId, 70);
    assert.deepStrictEqual(
      readCustomizedInner(controlServer.targeted[0].event.data.message),
      {
        id: 19,
        result: { value: 42 },
      }
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
      getAllWebsocketAppClients() {
        return new Map();
      },
      getAllWebsocketWebClients() {
        return new Map();
      },
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
      createRpcRequest("sendMessageWithReply", {
        clientId: 41,
        message: createCustomizedEnvelope({
          id: 83,
          clientId: 41,
          method: "Runtime.evaluate",
        }),
      })
    );
    host.handleControlDisconnected(77);

    await assert.rejects(
      () => pendingControl,
      /Multiplexer control 77 disconnected/
    );

    host.handleWebSocketDriverMessage(
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
    host.emit("websocket-web-client-disconnected", 88);
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
      getAllWebsocketAppClients() {
        return new Map();
      },
      getAllWebsocketWebClients() {
        return new Map();
      },
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
        host.handleWebSocketDriverMessage(
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
  it("routes reports to one enabled control and updates selection on disconnect", async function () {
    const { host } = createHost();
    const server = attachControlServer(host);
    const service = getDriverReportService();
    const report = (name) => service.report(name, null, {});
    const delivered = () =>
      server.targeted
        .filter((item) => item.event.event === "report")
        .map((item) => [item.controlId, item.event.data.eventName]);
    report("startup");
    host.handleControlConnected(1);
    assert.deepStrictEqual(delivered(), []);
    host.handleControlConnected(2, true);
    host.handleControlConnected(3, true);
    host.handleControlConnected(4, false);
    report("first");
    host.handleControlDisconnected(2);
    report("second");
    host.handleControlDisconnected(3);
    report("disabled");
    host.handleControlDisconnected(1);
    host.handleControlDisconnected(4);
    report("queued");
    host.handleControlConnected(5, true);
    assert.deepStrictEqual(delivered(), [
      [2, "startup"],
      [2, "first"],
      [3, "second"],
      [5, "disabled"],
      [5, "queued"],
    ]);
    assert.strictEqual(
      server.broadcasts.some((event) => event.event === "report"),
      false
    );
    await host.stop();
    assert.strictEqual(getDriverReportService(), null);
    report("after-stop");
    assert.strictEqual(delivered().length, 5);
  });

  it("captures physical constructor reports before the first control registers", async function () {
    const host = new MultiplexerDaemonHost({
      controlEndpoint: "/tmp/report-startup.sock",
      protocolVersion: MULTIPLEXER_PROTOCOL_VERSION,
      multiplexerDaemonIdleTimeout: -1,
      physicalConnectorOption: {
        manualConnect: true,
        enableAndroid: false,
        enableIOS: false,
        enableHarmony: false,
        enableDesktop: false,
        enableNetworkDevice: false,
      },
    });
    const server = attachControlServer(host);
    host.handleControlConnected(1, true);
    const reports = server.targeted.filter(
      (item) => item.event.event === "report"
    );
    assert.deepStrictEqual(
      reports.map((item) => item.event.data.eventName),
      ["PhysicalConnectorInit"]
    );
    assert(reports.every((item) => isControlEvent(item.event)));
    host.handleControlConnected(2, true);
    assert.strictEqual(
      server.targeted.filter((item) => item.event.event === "report").length,
      1
    );
    await host.stop();
  });
});
