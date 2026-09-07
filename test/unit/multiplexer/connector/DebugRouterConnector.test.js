// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const path = require("path");

const daemonClientPath = require.resolve(
  "../../../../debug_router_connector/dist/cjs/src/multiplexer/client/MultiplexerDaemonClient"
);
const daemonManagerPath = require.resolve(
  "../../../../debug_router_connector/dist/cjs/src/multiplexer/client/MultiplexerDaemonManager"
);
const discoveryPath = require.resolve(
  "../../../../debug_router_connector/dist/cjs/src/multiplexer/client/MultiplexerDiscovery"
);
const connectorPath = require.resolve(
  "../../../../debug_router_connector/dist/cjs/src/connector/DebugRouterConnector"
);
const connectorIndexPath = require.resolve(
  "../../../../debug_router_connector/dist/cjs/src/connector"
);
const rootIndexPath = require.resolve(
  "../../../../debug_router_connector/dist/cjs/src"
);

const {
  defaultLogger,
} = require("../../../../debug_router_connector/dist/cjs/src/utils/logger");
const {
  MultiOpenStatus,
} = require("../../../../debug_router_connector/dist/cjs/src/connector/MultiOpenCallBack");

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeviceSnapshot(overrides = {}) {
  return {
    os: overrides.os ?? "Android",
    title: overrides.title ?? "Pixel",
    serial: overrides.serial ?? "device-1",
    ports: overrides.ports ?? [9001],
    host: overrides.host,
  };
}

function createClientSnapshot(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    port: overrides.port ?? 9100,
    query: {
      app: overrides.app ?? "Demo",
      os: overrides.os ?? "Android",
      device: overrides.device ?? "Pixel",
      device_model: overrides.deviceModel ?? "Pixel",
      device_id: overrides.deviceId ?? "device-1",
      sdk_version: overrides.sdkVersion ?? "1.0.0",
      raw_info: overrides.rawInfo ?? {
        AppProcessName: overrides.processName ?? "com.demo",
        App: overrides.appName ?? "Demo",
      },
    },
  };
}

function createWebSocketSnapshot(overrides = {}) {
  return {
    id: overrides.id ?? 100,
    app: overrides.app ?? "web-app",
    debugRouterVersion: overrides.debugRouterVersion ?? "1.0.0",
    deviceModel: overrides.deviceModel ?? "Pixel",
    network: "WiFi",
    osVersion: overrides.osVersion ?? "14",
    sdkVersion: overrides.sdkVersion ?? "2.0.0",
    type: overrides.type ?? "runtime",
    raw_info: overrides.rawInfo ?? {},
  };
}

function createCustomizedMessage(method, params = {}, sessionId = 1) {
  return JSON.stringify({
    event: "Customized",
    data: {
      type: "CDP",
      data: {
        session_id: sessionId,
        message: JSON.stringify({
          method,
          params,
        }),
      },
      sender: 0,
    },
  });
}

function createWebMessage(type, clientId = 1) {
  return JSON.stringify({
    event: "Customized",
    data: {
      type,
      data: {
        client_id: clientId,
      },
    },
  });
}

function collect(connector, event) {
  const payloads = [];
  connector.on(event, (payload) => payloads.push(payload));
  return payloads;
}

function loadConnectorWithFakes(config = {}) {
  const daemonClientModule = require(daemonClientPath);
  const daemonManagerModule = require(daemonManagerPath);
  const discoveryModule = require(discoveryPath);
  const originals = {
    daemonClient: daemonClientModule.MultiplexerDaemonClient,
    daemonManager: daemonManagerModule.MultiplexerDaemonManager,
    discovery: discoveryModule.MultiplexerDiscovery,
  };
  const state = {
    clients: [],
    managers: [],
    discoveries: [],
    results: new Map(config.results ?? []),
    rejectMethods: new Set(config.rejectMethods ?? []),
    unsubscribeCalls: 0,
    unsubscribeConnectionCalls: 0,
    closeCalls: 0,
    connectCalls: 0,
    forceStopCalls: 0,
  };

  class FakeMultiplexerDiscovery {
    constructor(option) {
      this.option = option;
      this.discoveryPath = option.discoveryPath;
      this.staleTimeout = option.staleTimeout;
      state.discoveries.push(this);
    }
  }

  class FakeMultiplexerDaemonManager {
    constructor(option) {
      this.option = option;
      state.managers.push(this);
    }

    async stopDaemonForDebugging(withRespawn = false) {
      assert.strictEqual(withRespawn, false);
      state.forceStopCalls++;
    }
  }

  class FakeMultiplexerDaemonClient {
    constructor(option) {
      this.option = option;
      this.calls = [];
      this.connectCalls = 0;
      this.closeCalls = 0;
      this.status = "disconnected";
      state.clients.push(this);
    }

    async connect() {
      this.status = "connected";
      this.connectCalls++;
      state.connectCalls++;
    }

    async call(method, params) {
      this.status = "connected";
      this.calls.push({
        method,
        params,
      });
      if (state.rejectMethods.has(method)) {
        throw new Error(`${method} rejected`);
      }
      if (state.results.has(method)) {
        const result = state.results.get(method);
        return typeof result === "function" ? result(params, this) : result;
      }
      if (method === "connectDevices" || method === "connectUsbClients") {
        return [];
      }
      return undefined;
    }

    async forceStopDaemon() {
      await this.option.daemonManager.stopDaemonForDebugging();
    }

    subscribe(listener) {
      this.listener = listener;
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        state.unsubscribeCalls++;
        this.listener = undefined;
      };
    }

    subscribeConnectionEvent(listener) {
      this.connectionEventListener = listener;
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        state.unsubscribeConnectionCalls++;
        this.connectionEventListener = undefined;
      };
    }

    emitHostEvent(event) {
      this.listener?.(event);
    }

    emitConnectionEvent(event) {
      this.connectionEventListener?.(event);
    }

    async close() {
      this.status = "disconnected";
      this.closeCalls++;
      state.closeCalls++;
    }
  }

  daemonClientModule.MultiplexerDaemonClient = FakeMultiplexerDaemonClient;
  daemonManagerModule.MultiplexerDaemonManager = FakeMultiplexerDaemonManager;
  discoveryModule.MultiplexerDiscovery = FakeMultiplexerDiscovery;
  delete require.cache[connectorPath];
  delete require.cache[connectorIndexPath];
  delete require.cache[rootIndexPath];

  const { DebugRouterConnector } = require(connectorPath);

  return {
    DebugRouterConnector,
    state,
    restore() {
      daemonClientModule.MultiplexerDaemonClient = originals.daemonClient;
      daemonManagerModule.MultiplexerDaemonManager = originals.daemonManager;
      discoveryModule.MultiplexerDiscovery = originals.discovery;
      delete require.cache[connectorPath];
      delete require.cache[connectorIndexPath];
      delete require.cache[rootIndexPath];
    },
  };
}

describe("DebugRouterConnector multiplexer facade", function () {
  afterEach(function () {
    defaultLogger.setOutput(() => {});
  });

  it("constructs discovery, manager, and daemon client with explicit multiplexer options", function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: false,
        websocketOption: {
          port: 7777,
          roomId: "room-1",
        },
        multiplexerRootDir: "/tmp/mux-root",
        multiplexerDataDir: "/tmp/mux-data",
        multiplexerDaemonEntry: "/tmp/entry.js",
        multiplexerLegacyDriverDir: "/tmp/legacy-driver",
        multiplexerStartupTimeout: 333,
        multiplexerDaemonIdleTimeout: 444,
        multiplexerRpcTimeout: 555,
        enableDebugMode: true,
        enableAndroid: false,
        enableIOS: false,
        enableHarmony: false,
        enableDesktop: false,
        enableNetworkDevice: false,
        networkDeviceOpt: {
          ip: "127.0.0.1",
          port: [9100],
        },
        connectionTrace: {
          enabled: true,
          output: "relative-trace.ndjson",
          bufferSize: 200,
        },
      });

      assert.strictEqual(connector.enableWebSocket, false);
      assert.strictEqual(connector.wssPort, 19783);
      assert.strictEqual(connector.roomId, "room-1");
      assert.strictEqual(state.discoveries.length, 1);
      assert.strictEqual(
        state.discoveries[0].option.controlEndpoint,
        path.join("/tmp/mux-data", "control.sock")
      );
      assert.strictEqual(state.managers.length, 1);
      assert.strictEqual(
        state.managers[0].option.discovery,
        state.discoveries[0]
      );
      assert.strictEqual(state.managers[0].option.daemonEntry, "/tmp/entry.js");
      assert.strictEqual(state.managers[0].option.startupTimeout, 333);
      assert.strictEqual(
        state.managers[0].option.controlEndpoint,
        path.join("/tmp/mux-data", "control.sock")
      );
      assert.strictEqual(
        state.managers[0].option.legacyDriverDir,
        "/tmp/legacy-driver"
      );
      assert.strictEqual(
        state.managers[0].option.multiplexerDaemonIdleTimeout,
        444
      );
      assert.strictEqual(state.managers[0].option.enableDebugMode, true);
      assert.strictEqual(state.managers[0].option.enableWebSocket, false);
      assert.deepStrictEqual(state.managers[0].option.websocketOption, {
        port: 7777,
        roomId: "room-1",
      });
      assert.deepStrictEqual(
        {
          manualConnect:
            state.managers[0].option.physicalConnectorOption.manualConnect,
          enableAndroid:
            state.managers[0].option.physicalConnectorOption.enableAndroid,
          enableIOS: state.managers[0].option.physicalConnectorOption.enableIOS,
          enableHarmony:
            state.managers[0].option.physicalConnectorOption.enableHarmony,
          enableDesktop:
            state.managers[0].option.physicalConnectorOption.enableDesktop,
          enableNetworkDevice:
            state.managers[0].option.physicalConnectorOption
              .enableNetworkDevice,
        },
        {
          manualConnect: true,
          enableAndroid: false,
          enableIOS: false,
          enableHarmony: false,
          enableDesktop: false,
          enableNetworkDevice: false,
        }
      );
      assert.deepStrictEqual(
        state.managers[0].option.physicalConnectorOption.networkDeviceOpt,
        {
          ip: "127.0.0.1",
          port: [9100],
        }
      );
      assert.deepStrictEqual(state.managers[0].option.connectionTrace, {
        enabled: true,
        output: path.resolve("relative-trace.ndjson"),
        bufferSize: 200,
      });
      assert.strictEqual(
        "connectionTrace" in state.managers[0].option.physicalConnectorOption,
        false
      );
      assert.strictEqual(
        state.clients[0].option.daemonManager,
        state.managers[0]
      );
      assert.strictEqual(state.clients[0].option.rpcTimeout, 555);
      assert.deepStrictEqual(state.clients[0].calls, []);
    } finally {
      restore();
    }
  });

  it("uses all daemon capabilities by default without enableDebugMode", function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: false,
        enableAndroid: false,
        enableIOS: false,
        enableHarmony: false,
        enableDesktop: false,
        enableNetworkDevice: false,
        networkDeviceOpt: {
          ip: "127.0.0.1",
          port: [9100],
        },
      });

      assert.strictEqual(state.managers[0].option.enableDebugMode, false);
      assert.strictEqual(state.managers[0].option.enableWebSocket, true);
      assert.strictEqual(
        state.managers[0].option.daemonEntry,
        require.resolve(
          "../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/entry"
        )
      );
      assert.deepStrictEqual(
        {
          manualConnect:
            state.managers[0].option.physicalConnectorOption.manualConnect,
          enableAndroid:
            state.managers[0].option.physicalConnectorOption.enableAndroid,
          enableIOS: state.managers[0].option.physicalConnectorOption.enableIOS,
          enableHarmony:
            state.managers[0].option.physicalConnectorOption.enableHarmony,
          enableDesktop:
            state.managers[0].option.physicalConnectorOption.enableDesktop,
          enableNetworkDevice:
            state.managers[0].option.physicalConnectorOption
              .enableNetworkDevice,
        },
        {
          manualConnect: false,
          enableAndroid: true,
          enableIOS: true,
          enableHarmony: true,
          enableDesktop: true,
          enableNetworkDevice: true,
        }
      );
    } finally {
      restore();
    }
  });

  it("ignores legacy environment capability overrides", function () {
    const environmentKeys = [
      "DriverEnableAndroid",
      "DriverEnableIOS",
      "DriverEnableDesktop",
    ];
    const originalEnvironment = new Map(
      environmentKeys.map((key) => [key, process.env[key]])
    );
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      environmentKeys.forEach((key) => {
        process.env[key] = "false";
      });

      const sharedConnector = new DebugRouterConnector({
        manualConnect: true,
        enableAndroid: true,
        enableIOS: true,
        enableHarmony: true,
        enableDesktop: true,
      });
      sharedConnector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 1,
        devices: [
          createDeviceSnapshot({ serial: "android", os: "Android" }),
          createDeviceSnapshot({ serial: "ios", os: "iOS" }),
          createDeviceSnapshot({ serial: "harmony", os: "Harmony" }),
          createDeviceSnapshot({ serial: "desktop", os: "Mac" }),
        ],
        clients: [],
      });

      new DebugRouterConnector({
        manualConnect: true,
        enableDebugMode: true,
        enableAndroid: true,
        enableIOS: true,
        enableHarmony: true,
        enableDesktop: true,
      });

      assert.deepStrictEqual(Array.from(sharedConnector.devices.keys()), [
        "android",
        "ios",
        "harmony",
        "desktop",
      ]);
      assert.deepStrictEqual(
        {
          enableAndroid:
            state.managers[0].option.physicalConnectorOption.enableAndroid,
          enableIOS: state.managers[0].option.physicalConnectorOption.enableIOS,
          enableHarmony:
            state.managers[0].option.physicalConnectorOption.enableHarmony,
          enableDesktop:
            state.managers[0].option.physicalConnectorOption.enableDesktop,
        },
        {
          enableAndroid: true,
          enableIOS: true,
          enableHarmony: true,
          enableDesktop: true,
        }
      );
      assert.deepStrictEqual(
        {
          enableAndroid:
            state.managers[1].option.physicalConnectorOption.enableAndroid,
          enableIOS: state.managers[1].option.physicalConnectorOption.enableIOS,
          enableHarmony:
            state.managers[1].option.physicalConnectorOption.enableHarmony,
          enableDesktop:
            state.managers[1].option.physicalConnectorOption.enableDesktop,
        },
        {
          enableAndroid: true,
          enableIOS: true,
          enableHarmony: true,
          enableDesktop: true,
        }
      );
    } finally {
      originalEnvironment.forEach((value, key) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
      restore();
    }
  });

  it("auto-connects devices when manualConnect is false", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes({
      results: [["connectDevices", [createDeviceSnapshot()]]],
    });
    try {
      const connector = new DebugRouterConnector({
        manualConnect: false,
      });

      await nextTick();

      assert.deepStrictEqual(state.clients[0].calls, [
        {
          method: "connectDevices",
          params: {
            timeout: -1,
            serial: null,
          },
        },
      ]);
      assert.deepStrictEqual(Array.from(connector.devices.keys()), [
        "device-1",
      ]);
    } finally {
      restore();
    }
  });

  it("logs auto-connect failures and keeps them in the desired recovery path", async function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes({
      rejectMethods: ["connectDevices"],
    });
    const warnings = [];
    defaultLogger.setOutput((level, ...messages) => {
      if (level === "warn") {
        warnings.push(messages.join(" "));
      }
    });

    const connector = new DebugRouterConnector({
      manualConnect: false,
    });
    try {
      await nextTick();

      assert.strictEqual(
        warnings.some((message) =>
          message.includes("Failed to auto-connect multiplexer devices")
        ),
        true
      );
      assert.notStrictEqual(connector.desiredRecoveryTimer, null);
    } finally {
      await connector.close();
      restore();
    }
  });

  it("keeps device capability options local to each Connector", function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableAndroid: false,
        enableIOS: true,
        enableHarmony: false,
        enableDesktop: false,
        enableNetworkDevice: false,
      });
      const usbMessages = collect(connector, "usb-client-message");

      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 1,
        devices: [
          createDeviceSnapshot({ serial: "android", os: "Android" }),
          createDeviceSnapshot({ serial: "ios", os: "iOS" }),
          createDeviceSnapshot({ serial: "harmony", os: "Harmony" }),
          createDeviceSnapshot({ serial: "desktop", os: "Mac" }),
          createDeviceSnapshot({ serial: "network", os: "Network" }),
        ],
        clients: [
          createClientSnapshot({ id: 1, deviceId: "android" }),
          createClientSnapshot({ id: 2, deviceId: "ios", os: "iOS" }),
          createClientSnapshot({ id: 3, deviceId: "harmony" }),
          createClientSnapshot({ id: 4, deviceId: "desktop" }),
          createClientSnapshot({ id: 5, deviceId: "network" }),
        ],
      });
      connector.applyHostEvent({
        kind: "event",
        event: "client-message",
        data: { source: "usb-runtime", id: 1, message: "hidden" },
      });
      connector.applyHostEvent({
        kind: "event",
        event: "client-message",
        data: { source: "usb-runtime", id: 2, message: "visible" },
      });

      assert.deepStrictEqual(Array.from(connector.devices.keys()), ["ios"]);
      assert.deepStrictEqual(Array.from(connector.usbClients.keys()), [2]);
      assert.deepStrictEqual(
        usbMessages.map((event) => event.id),
        [2]
      );
    } finally {
      restore();
    }
  });

  it("forwards device RPCs, upserts mirrors, filters queries, and handles duplicate registration", async function () {
    const firstSnapshot = createDeviceSnapshot({
      serial: "device-1",
      ports: [9001],
    });
    const secondSnapshot = createDeviceSnapshot({
      serial: "device-2",
      ports: [9002],
    });
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes({
      results: [["connectDevices", [firstSnapshot, secondSnapshot]]],
    });
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });
      const connected = collect(connector, "device-connected");
      const disconnected = collect(connector, "device-disconnected");

      const devices = await connector.connectDevices(12, "device-1", false);

      assert.deepStrictEqual(state.clients[0].calls, [
        {
          method: "connectDevices",
          params: {
            timeout: 12,
            serial: "device-1",
          },
        },
      ]);
      assert.strictEqual(devices.length, 2);
      assert.deepStrictEqual(
        connected.map((device) => device.serial),
        ["device-1", "device-2"]
      );
      assert.deepStrictEqual(
        (await connector.getDevices(-1, null)).map((device) => device.serial),
        ["device-1", "device-2"]
      );
      assert.deepStrictEqual(
        (await connector.getDevices(-1, "device-2")).map(
          (device) => device.serial
        ),
        ["device-2"]
      );

      state.results.set("connectDevices", [
        createDeviceSnapshot({
          serial: "device-1",
          ports: [9010],
        }),
      ]);
      const updated = await connector.connectDevices();

      assert.strictEqual(updated[0], devices[0]);
      assert.deepStrictEqual(devices[0].ports, [9001]);
      assert.strictEqual(connected.length, 2);

      connector.registerDevice(devices[0]);
      assert.strictEqual(connected.length, 2);
      connector.unregisterDevice("missing");
      connector.unregisterDevice("device-1");

      assert.strictEqual(connector.devices.has("device-1"), true);
      assert.deepStrictEqual(disconnected, []);

      connector.unregisterDevice("device-1", true);
      await nextTick();

      assert.strictEqual(connector.devices.has("device-1"), false);
      assert.deepStrictEqual(
        disconnected.map((device) => device.serial),
        ["device-1"]
      );
      assert.deepStrictEqual(state.clients[0].calls.slice(-1), [
        {
          method: "disconnectDevice",
          params: {
            deviceId: "device-1",
          },
        },
      ]);
    } finally {
      restore();
    }
  });

  it("forwards client RPCs, upserts USB mirrors, selects clients, and filters Android and iOS names", async function () {
    const android = createClientSnapshot({
      id: 1,
      deviceId: "device-1",
      processName: "com.demo.android",
    });
    const ios = createClientSnapshot({
      id: 2,
      os: "iOS",
      deviceModel: "iPhone 15",
      deviceId: "device-1",
      rawInfo: {
        App: "Demo iOS",
      },
    });
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes({
      results: [["connectUsbClients", [android, ios]]],
    });
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
      });
      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 1,
        devices: [createDeviceSnapshot()],
        clients: [],
      });
      const clientConnected = collect(connector, "client-connected");
      const appConnected = collect(connector, "app-client-connected");

      const clients = await connector.connectUsbClients(
        "device-1",
        20,
        false,
        "Demo"
      );

      assert.deepStrictEqual(state.clients[0].calls, [
        {
          method: "connectUsbClients",
          params: {
            deviceId: "device-1",
            timeout: 20,
            waitTimeout: false,
            clientName: "Demo",
          },
        },
      ]);
      assert.deepStrictEqual(
        clients.map((client) => client.clientId()),
        [1, 2]
      );
      assert.deepStrictEqual(
        clientConnected.map((client) => client.clientId()),
        [1, 2]
      );
      assert.deepStrictEqual(
        appConnected.map((client) => client.clientId()),
        [1, 2]
      );
      assert.deepStrictEqual(
        (
          await connector.getDeviceUsbClients("device-1", -1, null)
        ).map((client) => client.clientId()),
        [1, 2]
      );
      assert.deepStrictEqual(
        (
          await connector.getDeviceUsbClients(
            "device-1",
            -1,
            "com.demo.android"
          )
        ).map((client) => client.clientId()),
        [1]
      );
      assert.deepStrictEqual(
        (
          await connector.getDeviceUsbClients("device-1", -1, "Demo iOS")
        ).map((client) => client.clientId()),
        [2]
      );
      assert.deepStrictEqual(
        await connector.getDeviceUsbClients("missing-device", -1, null),
        []
      );

      connector.selecteUsbClient(2);
      connector.selecteUsbClient(404);
      state.results.set("connectUsbClients", [
        createClientSnapshot({
          id: 1,
          deviceId: "device-1",
          port: 9999,
        }),
      ]);
      const updated = await connector.connectUsbClients("device-1");

      assert.strictEqual(updated[0], clients[0]);
      assert.strictEqual(updated[0].info.port, android.port);
      assert.strictEqual(clientConnected.length, 2);
    } finally {
      restore();
    }
  });

  it("cleans the local USB mirror after a client disconnects", function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
      });
      const clientDisconnected = collect(connector, "client-disconnected");
      const appClientDisconnected = collect(
        connector,
        "app-client-disconnected"
      );
      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 1,
        devices: [createDeviceSnapshot()],
        clients: [createClientSnapshot({ id: 1 })],
      });
      connector.selecteUsbClient(1);

      connector.unregiserUsbClient(1);

      assert.strictEqual(connector.usbClients.has(1), false);
      assert.strictEqual(connector.selectedClient, undefined);
      assert.deepStrictEqual(clientDisconnected, [1]);
      assert.deepStrictEqual(appClientDisconnected, [1]);
      assert.deepStrictEqual(state.clients[0].calls, []);
    } finally {
      restore();
    }
  });

  it("waits for future devices and clients, and times out when no target appears", async function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
      });
      const deviceWait = connector.getDevices(20, "future-device");
      setTimeout(() => {
        connector.applyHostEvent({
          kind: "event",
          event: "snapshot",
          data: {
            protocolVersion: 1,
            generatedAt: 1,
            devices: [
              createDeviceSnapshot({
                serial: "future-device",
              }),
            ],
            clients: [],
          },
        });
      }, 0);

      assert.deepStrictEqual(
        (await deviceWait).map((device) => device.serial),
        ["future-device"]
      );
      assert.deepStrictEqual(
        await connector.getDevices(0, "missing-device"),
        []
      );

      const clientWait = connector.getDeviceUsbClients(
        "future-device",
        20,
        "future-app"
      );
      setTimeout(() => {
        connector.applyHostEvent({
          kind: "event",
          event: "snapshot",
          data: {
            protocolVersion: 1,
            generatedAt: 2,
            devices: [
              createDeviceSnapshot({
                serial: "future-device",
              }),
            ],
            clients: [
              createClientSnapshot({
                id: 20,
                deviceId: "future-device",
                processName: "future-app",
              }),
            ],
          },
        });
      }, 0);

      assert.deepStrictEqual(
        (await clientWait).map((client) => client.clientId()),
        [20]
      );
      assert.deepStrictEqual(
        await connector.getDeviceUsbClients("future-device", 0, "missing-app"),
        []
      );
    } finally {
      restore();
    }
  });

  it("applies snapshots and host events, including stale removals and websocket client mirrors", function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });
      connector.wss = {
        wssPath: "ws://127.0.0.1:8888/mdevices/page/android",
      };
      const events = {
        deviceDisconnected: collect(connector, "device-disconnected"),
        clientDisconnected: collect(connector, "client-disconnected"),
        appDisconnected: collect(connector, "app-client-disconnected"),
        websocketAppConnected: collect(
          connector,
          "websocket-app-client-connected"
        ),
        websocketWebConnected: collect(
          connector,
          "websocket-web-client-connected"
        ),
        websocketAppDisconnected: collect(
          connector,
          "websocket-app-client-disconnected"
        ),
        websocketWebDisconnected: collect(
          connector,
          "websocket-web-client-disconnected"
        ),
        wsClientMessage: collect(connector, "ws-client-message"),
        wsWebMessage: collect(connector, "ws-web-message"),
      };

      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 1,
        devices: [createDeviceSnapshot()],
        clients: [createClientSnapshot()],
      });
      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 2,
        devices: [],
        clients: [],
      });

      assert.strictEqual(connector.devices.size, 0);
      assert.strictEqual(connector.usbClients.size, 0);
      assert.deepStrictEqual(
        events.deviceDisconnected.map((device) => device.serial),
        ["device-1"]
      );
      assert.deepStrictEqual(events.clientDisconnected, [1]);
      assert.deepStrictEqual(events.appDisconnected, [1]);

      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 3,
        devices: [],
        clients: [],
        websocketAppClients: [createWebSocketSnapshot({ id: 100 })],
        websocketWebClients: [
          createWebSocketSnapshot({ id: 200, type: "Driver" }),
        ],
      });
      const websocketProxy = connector.getAllWebsocketAppClients()[0];
      assert.strictEqual(websocketProxy.clientId(), 100);
      assert.strictEqual(websocketProxy.type(), "runtime");
      assert.strictEqual(typeof websocketProxy.sendMessage, "function");
      assert.strictEqual(
        typeof websocketProxy.sendCustomizedMessage,
        "function"
      );
      assert.strictEqual(typeof websocketProxy.close, "function");
      assert.strictEqual(
        connector
          .getAllAppClients()
          .some((client) => client.clientId() === 100),
        true
      );

      connector.applyHostEvent({
        kind: "event",
        event: "client-message",
        data: {
          source: "websocket-runtime",
          id: 1,
          message: "from-client",
        },
      });
      connector.applyHostEvent({
        kind: "event",
        event: "client-message",
        data: {
          source: "websocket-driver",
          id: 2,
          message: "from-web",
        },
      });

      assert.deepStrictEqual(events.wsClientMessage, [
        {
          id: 1,
          message: "from-client",
        },
      ]);
      assert.deepStrictEqual(events.wsWebMessage, [
        {
          id: 2,
          message: "from-web",
        },
      ]);
      assert.deepStrictEqual(
        connector
          .getAllWebsocketAppClients()
          .map((client) => client.clientId()),
        [100]
      );
      assert.deepStrictEqual(
        events.websocketAppConnected.map((client) => client.clientId()),
        [100]
      );
      assert.deepStrictEqual(
        events.websocketWebConnected.map((client) => client.clientId()),
        [200]
      );

      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 4,
        devices: [],
        clients: [],
        websocketAppClients: [],
        websocketWebClients: [],
      });

      assert.deepStrictEqual(connector.getAllWebsocketAppClients(), []);
      assert.deepStrictEqual(events.websocketAppDisconnected, [100]);
      assert.deepStrictEqual(events.websocketWebDisconnected, [200]);
    } finally {
      restore();
    }
  });

  it("ignores non-serializable connection trace output with a warning", function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      const warnings = [];
      defaultLogger.setOutput((level, ...messages) => {
        if (level === "warn") {
          warnings.push(messages.join(" "));
        }
      });
      const connector = new DebugRouterConnector({
        manualConnect: true,
        connectionTrace: {
          enabled: true,
          bufferSize: 100,
          output: {
            write() {},
          },
        },
      });
      assert.strictEqual(connector.getConnectionTrace, undefined);
      assert.strictEqual(connector.onConnectionTrace, undefined);
      assert.deepStrictEqual(state.managers[0].option.connectionTrace, {
        enabled: true,
        bufferSize: 100,
        output: undefined,
      });
      assert.strictEqual(
        warnings.some((message) => message.includes("WritableStream")),
        true
      );
    } finally {
      restore();
    }
  });

  it("maps legacy ownership events to multi-open callbacks and clears the selected client on unattached", function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
      });
      const statuses = [];
      connector.setMultiOpenCallback({
        statusChanged(status) {
          statuses.push(status);
        },
      });
      connector.selectedClient = {
        clientId() {
          return 1;
        },
      };

      connector.applyHostEvent({
        kind: "event",
        event: "legacy-ownership-changed",
        data: {
          status: "attached",
          ownerPid: 100,
          reason: "daemon-started",
        },
      });
      connector.applyHostEvent({
        kind: "event",
        event: "legacy-ownership-changed",
        data: {
          status: "attached",
          ownerPid: 100,
          reason: "daemon-started",
        },
      });
      connector.applyHostEvent({
        kind: "event",
        event: "legacy-ownership-changed",
        data: {
          status: "unattached",
          ownerPid: 100,
          previousOwnerPid: 200,
          reason: "legacy-preempted",
        },
      });

      assert.deepStrictEqual(statuses, [
        MultiOpenStatus.attached,
        MultiOpenStatus.unattached,
      ]);
      assert.strictEqual(connector.selectedClient, undefined);
    } finally {
      restore();
    }
  });

  it("routes USB and websocket messages through local mirrors and daemon RPCs", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
      });
      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 1,
        devices: [createDeviceSnapshot()],
        clients: [createClientSnapshot()],
      });
      const usbMessages = collect(connector, "usb-client-message");
      const clientEvents = [];
      connector.usbClients.get(1).on("Runtime.console", (...args) => {
        clientEvents.push(args);
      });

      connector.applyHostEvent({
        kind: "event",
        event: "client-message",
        data: {
          source: "usb-runtime",
          id: 1,
          message: createCustomizedMessage("Runtime.console", {
            text: "hello",
          }),
        },
      });
      connector.applyHostEvent({
        kind: "event",
        event: "client-message",
        data: { source: "usb-runtime", id: 404, message: "not-json" },
      });
      connector.handleWsMessage(404, createWebMessage("CDP", 3));
      connector.handleWsMessage(1, createWebMessage("UsbConnect", 3));
      connector.handleWsMessage(1, createWebMessage("UsbConnectAck", 3));
      connector.handleWsMessage(1, createWebMessage("CDP", 3));
      connector.handleWsMessage(1, createWebMessage("CDP", 0));

      assert.deepStrictEqual(
        usbMessages.map((item) => item.id),
        [1]
      );
      assert.deepStrictEqual(clientEvents, [
        [
          {
            text: "hello",
          },
          {
            session_id: 1,
          },
        ],
      ]);
      assert.deepStrictEqual(
        state.clients[0].calls
          .filter(
            (call) =>
              call.method === "sendMessageWithoutReply" &&
              call.params.target === "app"
          )
          .map((call) => JSON.parse(call.params.message).data.data.client_id),
        [-1, 0]
      );
      assert.throws(
        () => connector.handleWsMessage(1, "not-json"),
        SyntaxError
      );
    } finally {
      restore();
    }
  });

  it("gates websocket facade calls until enabled and started, then forwards send RPCs", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes({
      results: [
        [
          "startWSServer",
          {
            port: 8888,
            host: "127.0.0.1:8888",
            roomId: "room-2",
          },
        ],
      ],
    });
    try {
      const disabled = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: false,
      });
      disabled.sendMessageToWeb("web-disabled");
      disabled.sendMessageToApp(1, "app-disabled");
      await disabled.startWSServer();
      assert.deepStrictEqual(state.clients[0].calls, []);

      const enabled = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
        websocketOption: {
          port: 7777,
          roomId: "room-1",
        },
      });
      enabled.sendMessageToWeb("before-start");
      enabled.sendMessageToApp(1, "before-start");
      assert.deepStrictEqual(state.clients[1].calls, []);

      await enabled.startWSServer();
      enabled.sendMessageToWeb("to-web");
      enabled.sendMessageToApp(1, "to-app");
      await nextTick();

      assert.strictEqual(enabled.wssPort, 8888);
      assert.strictEqual(enabled.wssHost, "127.0.0.1:8888");
      assert.strictEqual(enabled.roomId, "room-2");
      assert.deepStrictEqual(enabled.wss, {
        wssPath: "ws://127.0.0.1:8888/mdevices/page/android",
      });
      assert.deepStrictEqual(state.clients[1].calls, [
        {
          method: "startWSServer",
          params: {},
        },
        {
          method: "sendMessageWithoutReply",
          params: {
            target: "web",
            clientId: -1,
            message: "to-web",
          },
        },
        {
          method: "sendMessageWithoutReply",
          params: {
            target: "app",
            clientId: 1,
            message: "to-app",
          },
        },
      ]);
    } finally {
      restore();
    }
  });

  it("keeps desired websocket state, clears the mirror on daemon disconnect, and restores it after reconnect", async function () {
    let starts = 0;
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes({
      results: [
        [
          "startWSServer",
          () => {
            starts++;
            return {
              port: 8800 + starts,
              host: `127.0.0.1:${8800 + starts}`,
              roomId: `room-${starts}`,
            };
          },
        ],
      ],
    });
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });

      await connector.startWSServer();
      assert.strictEqual(connector.desiredWSServerStarted, true);
      assert.deepStrictEqual(connector.wss, {
        wssPath: "ws://127.0.0.1:8801/mdevices/page/android",
      });

      state.clients[0].emitConnectionEvent({
        state: "disconnected",
        error: new Error("daemon lost"),
      });
      assert.strictEqual(connector.wss, null);

      await delay(120);
      assert.deepStrictEqual(connector.wss, {
        wssPath: "ws://127.0.0.1:8802/mdevices/page/android",
      });
      assert.deepStrictEqual(
        state.clients[0].calls
          .filter((call) => call.method === "startWSServer")
          .map((call) => call.params),
        [{}, {}]
      );
    } finally {
      restore();
    }
  });

  it("reconnects the daemon after disconnect even when there is no desired state", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
      });

      state.clients[0].emitConnectionEvent({
        state: "disconnected",
        error: new Error("daemon lost"),
      });

      await delay(120);
      assert.strictEqual(state.connectCalls, 1);
      assert.deepStrictEqual(state.clients[0].calls, []);
    } finally {
      restore();
    }
  });

  it("does not run desired recovery on a plain connected event", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes({
      results: [["connectDevices", [createDeviceSnapshot()]]],
    });
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
      });

      await connector.connectDevices(-1, null, true);
      state.clients[0].calls = [];
      state.clients[0].emitConnectionEvent({
        state: "connected",
      });

      await delay(120);
      assert.deepStrictEqual(state.clients[0].calls, []);
    } finally {
      restore();
    }
  });

  it("schedules desired recovery with a fixed 100ms delay", function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes();
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const delays = [];
    try {
      global.setTimeout = (callback, delay) => {
        delays.push(delay);
        return {
          callback,
        };
      };
      global.clearTimeout = () => {};
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });
      connector.desiredWSServerStarted = true;

      connector.scheduleDesiredRecovery();
      connector.scheduleDesiredRecovery();

      assert.deepStrictEqual(delays, [100]);
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      restore();
    }
  });

  it("clears all local mirrors and emits offline events in dependency order on daemon disconnect", function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });
      connector.wss = {
        wssPath: "ws://127.0.0.1:8888/mdevices/page/android",
      };
      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 1,
        devices: [createDeviceSnapshot()],
        clients: [createClientSnapshot()],
      });
      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 2,
        devices: [createDeviceSnapshot()],
        clients: [createClientSnapshot()],
        websocketAppClients: [createWebSocketSnapshot({ id: 100 })],
        websocketWebClients: [createWebSocketSnapshot({ id: 200 })],
      });
      const events = [];
      connector.on("client-disconnected", (id) =>
        events.push(["client-disconnected", id])
      );
      connector.on("app-client-disconnected", (id) =>
        events.push(["app-client-disconnected", id])
      );
      connector.on("websocket-app-client-disconnected", (id) =>
        events.push(["websocket-app-client-disconnected", id])
      );
      connector.on("websocket-web-client-disconnected", (id) =>
        events.push(["websocket-web-client-disconnected", id])
      );
      connector.on("device-disconnected", (device) =>
        events.push(["device-disconnected", device.serial])
      );

      state.clients[0].emitConnectionEvent({
        state: "disconnected",
        error: new Error("daemon lost"),
      });

      assert.strictEqual(connector.wss, null);
      assert.strictEqual(connector.usbClients.size, 0);
      assert.strictEqual(connector.websocketAppClients.size, 0);
      assert.strictEqual(connector.websocketWebClients.size, 0);
      assert.strictEqual(connector.devices.size, 0);
      assert.deepStrictEqual(events, [
        ["client-disconnected", 1],
        ["app-client-disconnected", 1],
        ["websocket-app-client-disconnected", 100],
        ["app-client-disconnected", 100],
        ["websocket-web-client-disconnected", 200],
        ["device-disconnected", "device-1"],
      ]);
      assert.deepStrictEqual(
        state.clients[0].calls.filter(
          (call) => call.method === "disconnectDevice"
        ),
        []
      );
    } finally {
      restore();
    }
  });

  it("keeps desired WatchAllClients state and restores it after daemon reconnect", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
      });

      connector.startWatchAllClients(false);
      await nextTick();
      assert.strictEqual(connector.desiredWatchAllClientsStarted, true);
      assert.deepStrictEqual(state.clients[0].calls.slice(0, 1), [
        {
          method: "startAllDeviceClientWatchers",
          params: {},
        },
      ]);

      state.clients[0].emitConnectionEvent({
        state: "disconnected",
        error: new Error("daemon lost"),
      });

      await delay(120);
      assert.deepStrictEqual(
        state.clients[0].calls
          .filter((call) => call.method === "startAllDeviceClientWatchers")
          .map((call) => call.params),
        [{}, {}]
      );
    } finally {
      restore();
    }
  });

  it("force-disables daemon clients and does not restore watchers after reconnect", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
      });

      connector.startWatchAllClients(false);
      await nextTick();
      await connector.disableAllClients();

      assert.strictEqual(connector.desiredWatchAllClientsStarted, true);
      assert.deepStrictEqual(state.clients[0].calls, [
        {
          method: "startAllDeviceClientWatchers",
          params: {},
        },
      ]);

      await connector.disableAllClients(true);

      assert.strictEqual(connector.desiredWatchAllClientsStarted, false);
      assert.deepStrictEqual(state.clients[0].calls, [
        {
          method: "startAllDeviceClientWatchers",
          params: {},
        },
        {
          method: "stopAllDeviceClientWatchers",
          params: {},
        },
      ]);

      state.clients[0].emitConnectionEvent({
        state: "disconnected",
        error: new Error("daemon lost"),
      });
      await delay(120);

      assert.deepStrictEqual(
        state.clients[0].calls.filter(
          (call) => call.method === "startAllDeviceClientWatchers"
        ),
        [
          {
            method: "startAllDeviceClientWatchers",
            params: {},
          },
        ]
      );
    } finally {
      restore();
    }
  });

  it("restores desired device discovery before other desired RPCs after daemon reconnect", async function () {
    let starts = 0;
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes({
      results: [
        ["connectDevices", [createDeviceSnapshot()]],
        [
          "startWSServer",
          () => {
            starts++;
            return {
              port: 8800 + starts,
              host: `127.0.0.1:${8800 + starts}`,
              roomId: `room-${starts}`,
            };
          },
        ],
      ],
    });
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });

      await connector.connectDevices(12, "device-1", false);
      assert.strictEqual(connector.desiredDeviceDiscoveryStarted, true);
      connector.startWatchAllClients(false);
      await nextTick();
      await connector.startWSServer();
      state.clients[0].calls = [];

      state.clients[0].emitConnectionEvent({
        state: "disconnected",
        error: new Error("daemon lost"),
      });

      await delay(120);
      assert.strictEqual(state.connectCalls, 1);
      assert.deepStrictEqual(state.clients[0].calls, [
        {
          method: "connectDevices",
          params: {
            timeout: -1,
            serial: null,
          },
        },
        {
          method: "startAllDeviceClientWatchers",
          params: {},
        },
        {
          method: "startWSServer",
          params: {},
        },
      ]);
    } finally {
      restore();
    }
  });

  it("handles fire-and-forget RPC rejections without throwing", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes({
      rejectMethods: ["sendMessageWithoutReply"],
      results: [
        [
          "startWSServer",
          {
            port: 8888,
            host: "127.0.0.1:8888",
            roomId: "room-1",
          },
        ],
      ],
    });
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });

      connector.setMultiOpenCallback(() => {});
      connector.disableAllClients();
      connector.addDeviceManager({});
      connector.startWatchAllClients();
      connector.startWatchAllClients(false);
      await connector.startWSServer();
      connector.sendMessageToWeb("web");
      connector.sendMessageToApp(1, "app");
      await delay(0);

      assert.deepStrictEqual(state.clients[0].calls, [
        {
          method: "startAllDeviceClientWatchers",
          params: {},
        },
        {
          method: "startAllDeviceClientWatchers",
          params: {},
        },
        {
          method: "startWSServer",
          params: {},
        },
        {
          method: "sendMessageWithoutReply",
          params: {
            target: "web",
            clientId: -1,
            message: "web",
          },
        },
        {
          method: "sendMessageWithoutReply",
          params: {
            target: "app",
            clientId: 1,
            message: "app",
          },
        },
      ]);
      await connector.close();
    } finally {
      restore();
    }
  });

  it("returns app clients from USB and websocket mirrors", function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });
      connector.wss = {
        wssPath: "ws://127.0.0.1:8888/mdevices/page/android",
      };

      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 1,
        devices: [createDeviceSnapshot()],
        clients: [createClientSnapshot()],
      });
      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 2,
        devices: [createDeviceSnapshot()],
        clients: [createClientSnapshot()],
        websocketAppClients: [createWebSocketSnapshot({ id: 100 })],
        websocketWebClients: [],
      });

      assert.deepStrictEqual(
        connector
          .getAllAppClients()
          .map((client) =>
            typeof client.clientId === "function"
              ? client.clientId()
              : client.id
          ),
        [1, 100]
      );
    } finally {
      restore();
    }
  });

  it("preserves the legacy websocket app lifecycle event order and payload identity", function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });
      connector.wss = {
        wssPath: "ws://127.0.0.1:8888/mdevices/page/android",
      };
      const events = [];
      connector.on("websocket-app-client-connected", (client) =>
        events.push(["websocket-app-client-connected", client])
      );
      connector.on("app-client-connected", (client) =>
        events.push(["app-client-connected", client])
      );
      connector.on("websocket-app-client-disconnected", (id) =>
        events.push(["websocket-app-client-disconnected", id])
      );
      connector.on("app-client-disconnected", (id) =>
        events.push(["app-client-disconnected", id])
      );

      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 1,
        devices: [],
        clients: [],
        websocketAppClients: [createWebSocketSnapshot({ id: 100 })],
        websocketWebClients: [],
      });
      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 2,
        devices: [],
        clients: [],
        websocketAppClients: [],
        websocketWebClients: [],
      });

      assert.deepStrictEqual(
        events.map(([event]) => event),
        [
          "websocket-app-client-connected",
          "app-client-connected",
          "websocket-app-client-disconnected",
          "app-client-disconnected",
        ]
      );
      assert.strictEqual(events[0][1], events[1][1]);
      assert.strictEqual(events[0][1].clientId(), 100);
      assert.strictEqual(events[2][1], 100);
      assert.strictEqual(events[3][1], 100);
    } finally {
      restore();
    }
  });

  it("preserves dependency order when consecutive snapshots change multiple lifecycles", function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });
      connector.wss = {
        wssPath: "ws://127.0.0.1:8888/mdevices/page/android",
      };
      const eventNames = [];
      for (const event of [
        "device-connected",
        "client-connected",
        "app-client-connected",
        "websocket-app-client-connected",
        "websocket-web-client-connected",
        "client-disconnected",
        "app-client-disconnected",
        "websocket-app-client-disconnected",
        "websocket-web-client-disconnected",
        "device-disconnected",
      ]) {
        connector.on(event, () => eventNames.push(event));
      }

      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 1,
        devices: [createDeviceSnapshot()],
        clients: [createClientSnapshot()],
        websocketAppClients: [createWebSocketSnapshot({ id: 100 })],
        websocketWebClients: [
          createWebSocketSnapshot({ id: 200, type: "Driver" }),
        ],
      });
      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 2,
        devices: [],
        clients: [],
        websocketAppClients: [],
        websocketWebClients: [],
      });

      assert.deepStrictEqual(eventNames, [
        "device-connected",
        "client-connected",
        "app-client-connected",
        "websocket-app-client-connected",
        "app-client-connected",
        "websocket-web-client-connected",
        "client-disconnected",
        "app-client-disconnected",
        "websocket-app-client-disconnected",
        "app-client-disconnected",
        "websocket-web-client-disconnected",
        "device-disconnected",
      ]);
    } finally {
      restore();
    }
  });

  it("keeps websocket clients out of getAllAppClients when websocket support is disabled", function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: false,
      });

      connector.applySnapshot({
        protocolVersion: 1,
        generatedAt: 1,
        devices: [createDeviceSnapshot()],
        clients: [createClientSnapshot()],
      });
      connector.getAllWebsocketAppClients = () => [
        {
          clientId: () => 100,
        },
      ];

      assert.deepStrictEqual(
        connector.getAllAppClients().map((client) => client.clientId()),
        [1]
      );
    } finally {
      restore();
    }
  });

  it("hides shared websocket state until this facade starts its websocket server", async function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes({
      results: [
        [
          "startWSServer",
          {
            port: 8888,
            host: "127.0.0.1:8888",
          },
        ],
      ],
    });
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });
      const connected = collect(connector, "websocket-app-client-connected");
      const messages = collect(connector, "ws-client-message");
      const snapshot = {
        protocolVersion: 1,
        generatedAt: 1,
        devices: [],
        clients: [],
        websocketAppClients: [createWebSocketSnapshot({ id: 100 })],
        websocketWebClients: [],
      };

      connector.applySnapshot(snapshot);
      connector.applyHostEvent({
        kind: "event",
        event: "client-message",
        data: {
          source: "websocket-runtime",
          id: 100,
          message: "before-start",
        },
      });
      assert.deepStrictEqual(connector.getAllWebsocketAppClients(), []);
      assert.deepStrictEqual(connector.getAllAppClients(), []);
      assert.deepStrictEqual(connected, []);
      assert.deepStrictEqual(messages, []);

      await connector.startWSServer();
      connector.applySnapshot(snapshot);
      connector.applyHostEvent({
        kind: "event",
        event: "client-message",
        data: {
          source: "websocket-runtime",
          id: 100,
          message: "after-start",
        },
      });

      assert.deepStrictEqual(
        connector
          .getAllWebsocketAppClients()
          .map((client) => client.clientId()),
        [100]
      );
      assert.deepStrictEqual(
        connected.map((client) => client.clientId()),
        [100]
      );
      assert.deepStrictEqual(messages, [{ id: 100, message: "after-start" }]);
    } finally {
      restore();
    }
  });

  it("closes idempotently, unsubscribes daemon events, and clears websocket started state", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes({
      results: [
        [
          "startWSServer",
          {
            port: 8888,
            host: "127.0.0.1:8888",
            roomId: "room-1",
          },
        ],
      ],
    });
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });
      await connector.startWSServer();
      assert.notStrictEqual(connector.wss, null);

      await connector.close();
      await connector.close();
      state.clients[0].emitHostEvent({
        kind: "event",
        event: "snapshot",
        data: {
          protocolVersion: 1,
          generatedAt: 1,
          devices: [createDeviceSnapshot()],
          clients: [],
        },
      });

      assert.strictEqual(state.closeCalls, 1);
      assert.strictEqual(state.unsubscribeCalls, 1);
      assert.strictEqual(state.unsubscribeConnectionCalls, 1);
      assert.strictEqual(state.forceStopCalls, 0);
      assert.strictEqual(connector.wss, null);
      assert.strictEqual(connector.devices.size, 0);
    } finally {
      restore();
    }
  });

  it("stops the connected daemon when an enableDebugMode Connector closes", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableDebugMode: true,
      });
      await connector.connectDevices();

      await connector.close();
      await connector.close();

      assert.strictEqual(
        state.clients[0].calls.some((call) => call.method === "shutdownDaemon"),
        false
      );
      assert.strictEqual(state.forceStopCalls, 1);
      assert.strictEqual(state.closeCalls, 1);
    } finally {
      restore();
    }
  });

  it("does not start a daemon only to stop an unused enableDebugMode Connector", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableDebugMode: true,
      });

      await connector.close();

      assert.deepStrictEqual(state.clients[0].calls, []);
      assert.strictEqual(state.forceStopCalls, 1);
      assert.strictEqual(state.closeCalls, 1);
    } finally {
      restore();
    }
  });

  it("creates bounded local driver client ids and exposes the driver client", function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes();
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
      });

      assert.ok(connector.getDriverClient());
      assert.strictEqual(connector.createClientId(), 2);
      connector.nextClientId = 4294967295;
      assert.strictEqual(connector.createClientId(), 1);
    } finally {
      restore();
    }
  });
});
