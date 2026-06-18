// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

require("../register_ts");

const daemonClientPath = require.resolve(
  "../../../../debug_router_connector/src/multiplexer/client/MultiplexerDaemonClient"
);
const daemonManagerPath = require.resolve(
  "../../../../debug_router_connector/src/multiplexer/client/MultiplexerDaemonManager"
);
const discoveryPath = require.resolve(
  "../../../../debug_router_connector/src/multiplexer/client/MultiplexerDiscovery"
);
const connectorPath = require.resolve(
  "../../../../debug_router_connector/src/connector/DebugRouterConnector"
);
const connectorIndexPath = require.resolve(
  "../../../../debug_router_connector/src/connector"
);
const rootIndexPath = require.resolve("../../../../debug_router_connector/src");

const {
  defaultLogger,
} = require("../../../../debug_router_connector/src/utils/logger");

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
    closeCalls: 0,
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
  }

  class FakeMultiplexerDaemonClient {
    constructor(option) {
      this.option = option;
      this.calls = [];
      this.closeCalls = 0;
      state.clients.push(this);
    }

    async call(method, params) {
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

    subscribe(listener) {
      this.listener = listener;
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        state.unsubscribeCalls++;
        if (this.listener === listener) {
          this.listener = undefined;
        }
      };
    }

    emitHostEvent(event) {
      this.listener?.(event);
    }

    async close() {
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
      const reports = [];
      const reportService = {
        init(manualConnect) {
          reports.push({
            event: "init",
            manualConnect,
          });
        },
        report(eventName, metrics, categories) {
          reports.push({
            event: eventName,
            metrics,
            categories,
          });
        },
      };

      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
        websocketOption: {
          port: 7777,
          roomId: "room-1",
        },
        multiplexerRootDir: "/tmp/mux-root",
        multiplexerDataDir: "/tmp/mux-data",
        multiplexerDaemonEntry: "/tmp/entry.js",
        multiplexerStaleTimeout: 222,
        multiplexerStartupTimeout: 333,
        multiplexerDaemonIdleTimeout: 444,
        multiplexerRpcTimeout: 555,
        reportService,
      });

      assert.strictEqual(connector.enableWebSocket, true);
      assert.strictEqual(connector.wssPort, 7777);
      assert.strictEqual(connector.roomId, "room-1");
      assert.strictEqual(state.discoveries.length, 1);
      assert.strictEqual(state.discoveries[0].option.staleTimeout, 222);
      assert.strictEqual(
        state.discoveries[0].option.discoveryPath,
        "/tmp/mux-data/daemon.json"
      );
      assert.strictEqual(state.managers.length, 1);
      assert.strictEqual(
        state.managers[0].option.discovery,
        state.discoveries[0]
      );
      assert.strictEqual(state.managers[0].option.daemonEntry, "/tmp/entry.js");
      assert.strictEqual(state.managers[0].option.startupTimeout, 333);
      assert.strictEqual(state.managers[0].option.staleTimeout, 222);
      assert.strictEqual(
        state.managers[0].option.multiplexerDaemonIdleTimeout,
        444
      );
      assert.deepStrictEqual(state.managers[0].option.websocketOption, {
        port: 7777,
        roomId: "room-1",
      });
      assert.strictEqual(
        state.clients[0].option.daemonManager,
        state.managers[0]
      );
      assert.strictEqual(state.clients[0].option.rpcTimeout, 555);
      assert.deepStrictEqual(state.clients[0].calls, []);
      assert.deepStrictEqual(
        reports.map((item) => item.event),
        ["init", "DebugRouterConnectorInit"]
      );
    } finally {
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
            isAutoListenClients: true,
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
            isAutoListenClients: false,
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
      assert.deepStrictEqual(devices[0].ports, [9010]);
      assert.strictEqual(connected.length, 2);

      connector.registerDevice(devices[0]);
      assert.strictEqual(connected.length, 2);
      connector.unregisterDevice("missing");
      connector.unregisterDevice("device-1");

      assert.strictEqual(connector.devices.has("device-1"), false);
      assert.deepStrictEqual(
        disconnected.map((device) => device.serial),
        ["device-1"]
      );
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
      assert.strictEqual(updated[0].info.port, 9999);
      assert.strictEqual(clientConnected.length, 2);
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
          event: "device-connected",
          data: createDeviceSnapshot({
            serial: "future-device",
          }),
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
          event: "client-connected",
          data: createClientSnapshot({
            id: 20,
            deviceId: "future-device",
            processName: "future-app",
          }),
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
      });
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

      connector.applyHostEvent({
        kind: "event",
        event: "ws-client-message",
        data: {
          id: 1,
          message: "from-client",
        },
      });
      connector.applyHostEvent({
        kind: "event",
        event: "ws-web-message",
        data: {
          id: 2,
          message: "from-web",
        },
      });
      connector.applyHostEvent({
        kind: "event",
        event: "websocket-app-client-connected",
        data: createWebSocketSnapshot({
          id: 100,
        }),
      });
      connector.applyHostEvent({
        kind: "event",
        event: "websocket-web-client-connected",
        data: createWebSocketSnapshot({
          id: 200,
          type: "Driver",
        }),
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
        connector.getAllWebsocketAppClients().map((client) => client.id),
        [100]
      );
      assert.deepStrictEqual(
        events.websocketAppConnected.map((client) => client.id),
        [100]
      );
      assert.deepStrictEqual(
        events.websocketWebConnected.map((client) => client.id),
        [200]
      );

      connector.applyHostEvent({
        kind: "event",
        event: "websocket-app-client-disconnected",
        data: {
          id: 100,
        },
      });
      connector.applyHostEvent({
        kind: "event",
        event: "websocket-web-client-disconnected",
        data: {
          id: 200,
        },
      });

      assert.deepStrictEqual(connector.getAllWebsocketAppClients(), []);
      assert.deepStrictEqual(events.websocketAppDisconnected, [100]);
      assert.deepStrictEqual(events.websocketWebDisconnected, [200]);
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

      connector.handleUsbMessage(
        1,
        createCustomizedMessage("Runtime.console", {
          text: "hello",
        })
      );
      connector.handleUsbMessage(404, "not-json");
      connector.handleWsMessage(404, createWebMessage("CDP", 3));
      connector.handleWsMessage(1, createWebMessage("UsbConnect", 3));
      connector.handleWsMessage(1, createWebMessage("UsbConnectAck", 3));
      connector.handleWsMessage(1, createWebMessage("CDP", 3));
      connector.handleWsMessage(1, createWebMessage("CDP", 0));

      assert.deepStrictEqual(
        usbMessages.map((item) => item.id),
        [1, 404]
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
          .filter((call) => call.method === "sendMessageToApp")
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
      assert.deepStrictEqual(state.clients[1].calls, [
        {
          method: "startWSServer",
          params: {},
        },
        {
          method: "sendMessageToWeb",
          params: {
            message: "to-web",
          },
        },
        {
          method: "sendMessageToApp",
          params: {
            id: 1,
            message: "to-app",
          },
        },
      ]);
    } finally {
      restore();
    }
  });

  it("handles fire-and-forget RPC rejections without throwing", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes({
      rejectMethods: [
        "startWatchAllClients",
        "sendMessageToWeb",
        "sendMessageToApp",
      ],
      results: [["startWSServer", undefined]],
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
          method: "startWatchAllClients",
          params: {
            force: true,
          },
        },
        {
          method: "startWatchAllClients",
          params: {
            force: false,
          },
        },
        {
          method: "startWSServer",
          params: {},
        },
        {
          method: "sendMessageToWeb",
          params: {
            message: "web",
          },
        },
        {
          method: "sendMessageToApp",
          params: {
            id: 1,
            message: "app",
          },
        },
      ]);
    } finally {
      restore();
    }
  });

  it("returns app clients from USB and websocket mirrors", function () {
    const { DebugRouterConnector, restore } = loadConnectorWithFakes();
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
      connector.applyHostEvent({
        kind: "event",
        event: "websocket-app-client-connected",
        data: createWebSocketSnapshot({
          id: 100,
        }),
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

  it("closes idempotently, unsubscribes daemon events, and clears websocket started state", async function () {
    const { DebugRouterConnector, state, restore } = loadConnectorWithFakes({
      results: [["startWSServer", undefined]],
    });
    try {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
      });
      await connector.startWSServer();
      assert.strictEqual(connector.webSocketServerStarted, true);

      await connector.close();
      await connector.close();
      state.clients[0].emitHostEvent({
        kind: "event",
        event: "device-connected",
        data: createDeviceSnapshot(),
      });

      assert.strictEqual(state.closeCalls, 1);
      assert.strictEqual(state.unsubscribeCalls, 1);
      assert.strictEqual(connector.webSocketServerStarted, false);
      assert.strictEqual(connector.devices.size, 0);
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
