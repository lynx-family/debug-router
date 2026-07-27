// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

require("../register_ts");

const {
  MultiplexerDevice,
  MultiplexerUsbClient,
} = require("../../../../debug_router_connector/src/multiplexer/client");
const {
  MultiplexerWebSocketClient,
} = require("../../../../debug_router_connector/src/multiplexer/client/MultiplexerWebSocketClient");
const {
  defaultLogger,
} = require("../../../../debug_router_connector/src/utils/logger");
const {
  WebSocketClient,
} = require("../../../../debug_router_connector/src/websocket/WebSocketConnection");

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDaemonClient(overrides = {}) {
  const state = {
    calls: [],
  };

  return {
    state,
    async call(method, params) {
      state.calls.push({
        method,
        params,
      });
      if (overrides.rejectMethods?.has(method)) {
        throw new Error(`${method} rejected`);
      }
      if (overrides.call) {
        return overrides.call(method, params);
      }
      if (overrides.results?.has(method)) {
        return overrides.results.get(method);
      }
      return `${method}-result`;
    },
  };
}

function createDeviceSnapshot(overrides = {}) {
  return {
    os: overrides.os ?? "Android",
    title: overrides.title ?? "Pixel",
    serial: overrides.serial ?? "device-1",
    ports: overrides.ports ?? [8901, 8902],
    host: overrides.host,
  };
}

function createClientSnapshot(overrides = {}) {
  return {
    port: overrides.port ?? 9001,
    id: overrides.id ?? 1,
    query: {
      app: overrides.app ?? "demo",
      os: overrides.os ?? "Android",
      device: overrides.device ?? "Pixel",
      device_model: overrides.deviceModel ?? "Pixel",
      device_id: overrides.deviceId ?? "device-1",
      sdk_version: overrides.sdkVersion,
      raw_info: overrides.rawInfo,
    },
  };
}

function createWebSocketClientSnapshot(overrides = {}) {
  return {
    id: overrides.id ?? 100,
    app: overrides.app ?? "wifi-demo",
    debugRouterVersion: overrides.debugRouterVersion ?? "1.0.0",
    deviceModel: overrides.deviceModel ?? "Pixel",
    network: "WiFi",
    osVersion: overrides.osVersion ?? "14",
    sdkVersion: overrides.sdkVersion ?? "2.0.0",
    type: overrides.type ?? "runtime",
    raw_info: overrides.rawInfo ?? { App: "WiFi Demo" },
  };
}

function createCustomizedMessage(type, data) {
  return JSON.stringify({
    event: "Customized",
    data: {
      type,
      data,
      sender: 0,
    },
  });
}

function createCustomizedResponse(type, message, clientId) {
  return {
    event: "Customized",
    data: {
      type,
      data: {
        client_id: clientId,
        session_id: -1,
        message,
      },
      sender: 0,
    },
  };
}

describe("multiplexer client mirror sync", function () {
  afterEach(function () {
    defaultLogger.setOutput(() => {});
  });

  it("builds a MultiplexerDevice from a snapshot without sharing mutable arrays", function () {
    const daemonClient = createDaemonClient();
    const snapshot = createDeviceSnapshot({
      host: "10.0.0.1",
      ports: [9001],
    });
    const device = MultiplexerDevice.fromSnapshot(snapshot, daemonClient);

    snapshot.ports.push(9002);
    const ports = device.ports;
    ports.push(9003);

    assert.deepStrictEqual(device.info, {
      os: "Android",
      title: "Pixel",
      serial: "device-1",
    });
    assert.deepStrictEqual(device.ports, [9001]);
    assert.strictEqual(device.serial, "device-1");
    assert.strictEqual(device.getHost(), "10.0.0.1");
    assert.strictEqual(device.isConnected, true);
  });

  it("updates a MultiplexerDevice snapshot, restores connection state, and rejects serial mismatches", function () {
    const daemonClient = createDaemonClient();
    const device = MultiplexerDevice.fromSnapshot(
      createDeviceSnapshot({
        host: "10.0.0.1",
      }),
      daemonClient
    );
    device.disConnect();
    device.updateFromSnapshot(
      createDeviceSnapshot({
        title: "Pixel 2",
        ports: [9101],
        host: undefined,
      })
    );

    assert.deepStrictEqual(device.info, {
      os: "Android",
      title: "Pixel 2",
      serial: "device-1",
    });
    assert.deepStrictEqual(device.ports, [9101]);
    assert.strictEqual(device.getHost(), "127.0.0.1");
    assert.strictEqual(device.isConnected, true);
    assert.throws(
      () =>
        device.updateFromSnapshot(
          createDeviceSnapshot({
            serial: "other-device",
          })
        ),
      /Cannot update multiplexer device device-1/
    );
  });

  it("forwards MultiplexerDevice public watcher APIs to daemon RPC", async function () {
    const daemonClient = createDaemonClient();
    const device = MultiplexerDevice.fromSnapshot(
      createDeviceSnapshot(),
      daemonClient
    );

    device.startWatchClient();
    await device.stopWatchClient();
    device.disConnect();
    await nextTick();

    assert.strictEqual(device.isConnected, false);
    assert.deepStrictEqual(daemonClient.state.calls, [
      {
        method: "startDeviceClientWatcher",
        params: {
          deviceId: "device-1",
        },
      },
      {
        method: "stopDeviceClientWatcher",
        params: {
          deviceId: "device-1",
        },
      },
      {
        method: "disconnectDevice",
        params: {
          deviceId: "device-1",
        },
      },
    ]);
  });

  it("does not throw when fire-and-forget MultiplexerDevice RPCs reject", async function () {
    const daemonClient = createDaemonClient({
      rejectMethods: new Set(["startDeviceClientWatcher", "disconnectDevice"]),
    });
    const device = MultiplexerDevice.fromSnapshot(
      createDeviceSnapshot(),
      daemonClient
    );

    assert.doesNotThrow(() => device.startWatchClient());
    assert.doesNotThrow(() => device.disConnect());
    await nextTick();

    assert.deepStrictEqual(
      daemonClient.state.calls.map((call) => call.method),
      ["startDeviceClientWatcher", "disconnectDevice"]
    );
  });

  it("builds and updates MultiplexerUsbClient snapshots without sharing mutable info", function () {
    const daemonClient = createDaemonClient();
    const snapshot = createClientSnapshot({
      rawInfo: {
        App: "Demo",
      },
    });
    const client = MultiplexerUsbClient.fromSnapshot(snapshot, daemonClient);

    snapshot.query.raw_info.App = "Changed";
    const info = client.info;
    info.query.raw_info.App = "Mutated";

    assert.strictEqual(client.clientId(), 1);
    assert.strictEqual(client.deviceId(), "device-1");
    assert.deepStrictEqual(client.info.query.raw_info, {
      App: "Demo",
    });

    client.updateFromSnapshot(
      createClientSnapshot({
        id: 1,
        port: 9100,
        deviceId: "device-2",
        rawInfo: {
          App: "Updated",
        },
      })
    );

    assert.strictEqual(client.deviceId(), "device-2");
    assert.strictEqual(client.info.port, 9100);
    assert.deepStrictEqual(client.info.query.raw_info, {
      App: "Updated",
    });
    assert.throws(
      () =>
        client.updateFromSnapshot(
          createClientSnapshot({
            id: 2,
          })
        ),
      /Cannot update multiplexer USB client 1/
    );
  });

  it("forwards MultiplexerUsbClient send and close APIs to daemon RPC", async function () {
    const rawResult = {
      event: "Register",
      data: {
        id: 1,
        info: {},
      },
    };
    const daemonClient = createDaemonClient({
      call(method, params) {
        if (method !== "sendMessageWithReply") {
          return `${method}-result`;
        }
        if (params.message.event === "Initialize") {
          return rawResult;
        }
        return createCustomizedResponse(
          params.message.data.type,
          "customized-result",
          params.clientId
        );
      },
    });
    const client = MultiplexerUsbClient.fromSnapshot(
      createClientSnapshot(),
      daemonClient
    );
    const rawMessage = {
      event: "Initialize",
      data: 1,
    };

    client.close();
    const customized = await client.sendCustomizedMessage(
      "Runtime.evaluate",
      {
        expression: "1 + 1",
      },
      7,
      "CDP"
    );
    const raw = await client.sendRawMessage(rawMessage);
    client.sendMessage({
      event: "Ping",
    });
    const app = await client.sendClientMessage("App.call", {
      value: true,
    });
    await nextTick();

    assert.strictEqual(customized, "customized-result");
    assert.deepStrictEqual(raw, rawResult);
    assert.strictEqual(app, "customized-result");
    const calls = daemonClient.state.calls;
    assert.deepStrictEqual(calls[0], {
      method: "closeClient",
      params: {
        clientId: 1,
      },
    });
    assert.strictEqual(calls[1].method, "sendMessageWithReply");
    assert.strictEqual(calls[1].params.clientId, 1);
    assert.deepStrictEqual(
      {
        ...calls[1].params.message,
        data: {
          ...calls[1].params.message.data,
          data: {
            ...calls[1].params.message.data.data,
            message: {
              ...calls[1].params.message.data.data.message,
              id: "<generated>",
            },
          },
        },
      },
      {
        event: "Customized",
        data: {
          type: "CDP",
          data: {
            client_id: -1,
            session_id: 7,
            message: {
              id: "<generated>",
              method: "Runtime.evaluate",
              params: {
                expression: "1 + 1",
              },
            },
          },
          sender: 0,
        },
      }
    );
    assert(Number.isSafeInteger(calls[1].params.message.data.data.message.id));
    assert.deepStrictEqual(calls.slice(2, 4), [
      {
        method: "sendMessageWithReply",
        params: {
          clientId: 1,
          message: rawMessage,
        },
      },
      {
        method: "sendMessageWithoutReply",
        params: {
          target: "app",
          clientId: 1,
          message: {
            event: "Ping",
          },
        },
      },
    ]);
    assert.strictEqual(calls[4].method, "sendMessageWithReply");
    assert.strictEqual(calls[4].params.clientId, 1);
    assert.deepStrictEqual(
      {
        ...calls[4].params.message,
        data: {
          ...calls[4].params.message.data,
          data: {
            ...calls[4].params.message.data.data,
            message: {
              ...calls[4].params.message.data.data.message,
              id: "<generated>",
            },
          },
        },
      },
      {
        event: "Customized",
        data: {
          type: "App",
          data: {
            client_id: -1,
            session_id: -1,
            message: {
              id: "<generated>",
              method: "App.call",
              params: {
                value: true,
              },
            },
          },
          sender: 0,
        },
      }
    );
    assert(Number.isSafeInteger(calls[4].params.message.data.data.message.id));
  });

  it("does not throw when fire-and-forget MultiplexerUsbClient RPCs reject", async function () {
    const daemonClient = createDaemonClient({
      rejectMethods: new Set(["closeClient", "sendMessageWithoutReply"]),
    });
    const client = MultiplexerUsbClient.fromSnapshot(
      createClientSnapshot(),
      daemonClient
    );

    assert.doesNotThrow(() => client.close());
    assert.doesNotThrow(() =>
      client.sendMessage({
        event: "Ping",
      })
    );
    await nextTick();

    assert.deepStrictEqual(
      daemonClient.state.calls.map((call) => call.method),
      ["closeClient", "sendMessageWithoutReply"]
    );
  });

  it("builds a legacy WebSocketClient-compatible proxy with stable mutable info identity", function () {
    const daemonClient = createDaemonClient();
    const snapshot = createWebSocketClientSnapshot({
      rawInfo: { App: "Original" },
    });
    const client = MultiplexerWebSocketClient.fromSnapshot(
      snapshot,
      daemonClient
    );

    snapshot.raw_info.App = "Changed";
    const info = client.info;
    info.raw_info.App = "Mutated";
    info.externalMarker = "keep-me";

    assert.strictEqual(client instanceof WebSocketClient, true);
    assert.strictEqual(client.clientId(), 100);
    assert.strictEqual(client.type(), "runtime");
    assert.strictEqual(client.info, info);
    assert.deepStrictEqual(client.info.raw_info, { App: "Mutated" });

    client.updateFromSnapshot(
      createWebSocketClientSnapshot({
        id: 100,
        app: "updated",
        rawInfo: { App: "Updated" },
      })
    );
    assert.strictEqual(client.info, info);
    assert.strictEqual(client.info.app, "updated");
    assert.deepStrictEqual(client.info.raw_info, { App: "Updated" });
    assert.strictEqual(client.info.externalMarker, "keep-me");
    assert.throws(
      () =>
        client.updateFromSnapshot(createWebSocketClientSnapshot({ id: 101 })),
      /Cannot update multiplexer WebSocket client 100/
    );
  });

  it("delegates handleListClients only for legacy Driver proxies", function () {
    const daemonClient = createDaemonClient();
    let calls = 0;
    const driver = MultiplexerWebSocketClient.fromSnapshot(
      createWebSocketClientSnapshot({ type: "Driver" }),
      daemonClient,
      () => calls++
    );
    const runtime = MultiplexerWebSocketClient.fromSnapshot(
      createWebSocketClientSnapshot({ id: 101, type: "runtime" }),
      daemonClient,
      () => calls++
    );

    driver.handleListClients();
    runtime.handleListClients();

    assert.strictEqual(calls, 1);
  });

  it("forwards MultiplexerWebSocketClient compatibility APIs to daemon RPC", async function () {
    const daemonClient = createDaemonClient({
      call(method, params) {
        if (method === "sendMessageWithReply") {
          return createCustomizedResponse(
            params.message.data.type,
            "wifi-result",
            params.clientId
          );
        }
        return `${method}-result`;
      },
    });
    const client = MultiplexerWebSocketClient.fromSnapshot(
      createWebSocketClientSnapshot(),
      daemonClient
    );

    client.close();
    client.sendMessage("raw-message");
    const customized = await client.sendCustomizedMessage(
      "Runtime.evaluate",
      { expression: "1 + 1" },
      7,
      "CDP"
    );
    await nextTick();

    assert.strictEqual(customized, "wifi-result");
    assert.deepStrictEqual(daemonClient.state.calls.slice(0, 2), [
      {
        method: "closeClient",
        params: { clientId: 100 },
      },
      {
        method: "sendMessageWithoutReply",
        params: {
          target: "app",
          clientId: 100,
          message: "raw-message",
        },
      },
    ]);
    const rawCall = daemonClient.state.calls[2];
    assert.strictEqual(rawCall.method, "sendMessageWithReply");
    assert.strictEqual(rawCall.params.clientId, 100);
    assert.deepStrictEqual(
      {
        ...rawCall.params.message,
        data: {
          ...rawCall.params.message.data,
          data: {
            ...rawCall.params.message.data.data,
            message: {
              ...rawCall.params.message.data.data.message,
              id: "<generated>",
            },
          },
        },
      },
      {
        event: "Customized",
        data: {
          type: "CDP",
          data: {
            client_id: -1,
            session_id: 7,
            message: {
              id: "<generated>",
              method: "Runtime.evaluate",
              params: { expression: "1 + 1" },
            },
          },
          sender: 0,
        },
      }
    );
    assert(Number.isSafeInteger(rawCall.params.message.data.data.message.id));
  });

  it("routes MultiplexerWebSocketClient Driver messages to the target Web client", async function () {
    const daemonClient = createDaemonClient();
    const client = MultiplexerWebSocketClient.fromSnapshot(
      createWebSocketClientSnapshot({ id: 101, type: "Driver" }),
      daemonClient
    );

    client.sendMessage("driver-message");
    await nextTick();

    assert.deepStrictEqual(daemonClient.state.calls, [
      {
        method: "sendMessageWithoutReply",
        params: {
          target: "web",
          clientId: 101,
          message: "driver-message",
        },
      },
    ]);
  });

  it("forwards sendMessageWithReply RPC errors without legacy rewrapping", async function () {
    const daemonClient = createDaemonClient({
      rejectMethods: new Set(["sendMessageWithReply"]),
    });
    daemonClient.call = async (method, params) => {
      daemonClient.state.calls.push({ method, params });
      throw new Error(
        "Timed out waiting for multiplexer RPC sendMessageWithReply response"
      );
    };
    const client = MultiplexerWebSocketClient.fromSnapshot(
      createWebSocketClientSnapshot(),
      daemonClient
    );

    await assert.rejects(
      client.sendCustomizedMessage(
        "Runtime.evaluate",
        { expression: "1 + 1" },
        7,
        "CDP"
      ),
      (error) => {
        assert.strictEqual(
          error.message,
          "Timed out waiting for multiplexer RPC sendMessageWithReply response"
        );
        return true;
      }
    );
  });

  it("contains rejected fire-and-forget WebSocket proxy RPCs", async function () {
    const daemonClient = createDaemonClient({
      rejectMethods: new Set(["closeClient", "sendMessageWithoutReply"]),
    });
    const client = MultiplexerWebSocketClient.fromSnapshot(
      createWebSocketClientSnapshot(),
      daemonClient
    );
    const originalWarn = defaultLogger.warn;
    const warnings = [];
    defaultLogger.warn = (...args) => warnings.push(args);

    try {
      assert.doesNotThrow(() => client.close());
      assert.doesNotThrow(() => client.sendMessage("message"));
      await nextTick();
      assert.deepStrictEqual(
        daemonClient.state.calls.map((call) => call.method),
        ["closeClient", "sendMessageWithoutReply"]
      );
      assert.deepStrictEqual(warnings, []);
    } finally {
      defaultLogger.warn = originalWarn;
    }
  });

  it("emits session list, CDP, App, once, off, and all-event callbacks from USB messages", function () {
    const daemonClient = createDaemonClient();
    const client = MultiplexerUsbClient.fromSnapshot(
      createClientSnapshot(),
      daemonClient
    );
    const events = [];
    const allEvents = [];
    const offEvents = [];
    const onceEvents = [];
    const offHandler = (...params) => offEvents.push(params);

    client.on("Runtime.consoleAPICalled", (...params) => events.push(params));
    client.on("off-event", offHandler);
    client.off("off-event", offHandler);
    client.once("once-event", (...params) => onceEvents.push(params));
    client.onAllEvents((method, params, session) =>
      allEvents.push({
        method,
        params,
        session,
      })
    );

    let sessions;
    client.on("SessionList", (value) => {
      sessions = value;
    });

    client.handleMessage(
      createCustomizedMessage("SessionList", [
        {
          session_id: 1,
          url: "https://example.test",
        },
      ])
    );
    client.handleMessage(
      createCustomizedMessage("CDP", {
        session_id: 9,
        message: JSON.stringify({
          method: "Runtime.consoleAPICalled",
          params: {
            value: 1,
          },
        }),
      })
    );
    client.handleMessage(
      createCustomizedMessage("App", {
        message: JSON.stringify({
          method: "once-event",
          params: {
            count: 1,
          },
        }),
      })
    );
    client.handleMessage(
      createCustomizedMessage("App", {
        message: JSON.stringify({
          method: "once-event",
          params: {
            count: 2,
          },
        }),
      })
    );
    client.handleMessage(
      createCustomizedMessage("CDP", {
        message: JSON.stringify({
          method: "off-event",
          params: {},
        }),
      })
    );

    assert.deepStrictEqual(sessions, [
      {
        session_id: 1,
        url: "https://example.test",
      },
    ]);
    assert.deepStrictEqual(events, [
      [
        {
          value: 1,
        },
        {
          session_id: 9,
        },
      ],
    ]);
    assert.deepStrictEqual(onceEvents, [
      [
        {
          count: 1,
        },
        {
          session_id: -1,
        },
      ],
    ]);
    assert.deepStrictEqual(offEvents, []);
    assert.deepStrictEqual(allEvents, [
      {
        method: "Runtime.consoleAPICalled",
        params: {
          value: 1,
        },
        session: {
          session_id: 9,
        },
      },
      {
        method: "once-event",
        params: {
          count: 1,
        },
        session: {
          session_id: -1,
        },
      },
      {
        method: "once-event",
        params: {
          count: 2,
        },
        session: {
          session_id: -1,
        },
      },
      {
        method: "off-event",
        params: {},
        session: {
          session_id: -1,
        },
      },
    ]);
  });

  it("ignores invalid, unsupported, response, and malformed USB messages", function () {
    const daemonClient = createDaemonClient();
    const client = MultiplexerUsbClient.fromSnapshot(
      createClientSnapshot(),
      daemonClient
    );
    const events = [];
    const allEvents = [];

    client.on("Runtime.event", (...params) => events.push(params));
    client.onAllEvents((...params) => allEvents.push(params));

    client.handleMessage("{bad-json");
    client.handleMessage(
      JSON.stringify({
        event: "Register",
        data: {},
      })
    );
    client.handleMessage(createCustomizedMessage("OpenCard", {}));
    client.handleMessage(
      createCustomizedMessage("CDP", {
        message: {
          method: "Runtime.event",
        },
      })
    );
    client.handleMessage(
      createCustomizedMessage("CDP", {
        message: JSON.stringify({
          id: 1,
          method: "Runtime.event",
          params: {},
        }),
      })
    );
    client.handleMessage(
      createCustomizedMessage("CDP", {
        message: JSON.stringify({
          params: {},
        }),
      })
    );

    assert.deepStrictEqual(events, []);
    assert.deepStrictEqual(allEvents, []);
  });
});
