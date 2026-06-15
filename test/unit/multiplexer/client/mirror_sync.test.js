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
  defaultLogger,
} = require("../../../../debug_router_connector/src/utils/logger");

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
        method: "startWatchClient",
        params: {
          deviceId: "device-1",
        },
      },
      {
        method: "stopWatchClient",
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
      rejectMethods: new Set(["startWatchClient", "disconnectDevice"]),
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
      ["startWatchClient", "disconnectDevice"]
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
      results: new Map([
        ["sendCustomizedMessage", "customized-result"],
        ["sendRawMessage", rawResult],
      ]),
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
    assert.deepStrictEqual(daemonClient.state.calls, [
      {
        method: "closeClient",
        params: {
          clientId: 1,
        },
      },
      {
        method: "sendCustomizedMessage",
        params: {
          clientId: 1,
          method: "Runtime.evaluate",
          params: {
            expression: "1 + 1",
          },
          sessionId: 7,
          type: "CDP",
        },
      },
      {
        method: "sendRawMessage",
        params: {
          clientId: 1,
          message: rawMessage,
        },
      },
      {
        method: "sendMessage",
        params: {
          clientId: 1,
          message: {
            event: "Ping",
          },
        },
      },
      {
        method: "sendCustomizedMessage",
        params: {
          clientId: 1,
          method: "App.call",
          params: {
            value: true,
          },
          sessionId: -1,
          type: "App",
        },
      },
    ]);
  });

  it("does not throw when fire-and-forget MultiplexerUsbClient RPCs reject", async function () {
    const daemonClient = createDaemonClient({
      rejectMethods: new Set(["closeClient", "sendMessage"]),
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
      ["closeClient", "sendMessage"]
    );
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

    client.on("Runtime.consoleAPICalled", (...params) =>
      events.push(params)
    );
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
