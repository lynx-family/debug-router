// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { EventEmitter } = require("events");

require("../register_ts");

const {
  MultiplexerDaemonClient,
} = require("../../../../debug_router_connector/src/multiplexer/client/MultiplexerDaemonClient");
const {
  setDriverReportService,
} = require("../../../../debug_router_connector/src/report/interface/DriverReportService");
const {
  defaultLogger,
} = require("../../../../debug_router_connector/src/utils/logger");

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate) {
  for (let i = 0; i < 20; i++) {
    if (predicate()) {
      return;
    }
    await nextTick();
  }
  assert.fail("condition was not met");
}

function createWebSocketCtor() {
  return class FakeWebSocket extends EventEmitter {
    static instances = [];

    constructor(url) {
      super();
      this.url = url;
      this.readyState = WS_CONNECTING;
      this.sent = [];
      this.closeCalls = 0;
      this.sendError = null;
      FakeWebSocket.instances.push(this);
    }

    send(data, callback) {
      this.sent.push(data);
      callback?.(this.sendError);
    }

    open() {
      this.readyState = WS_OPEN;
      this.emit("open");
    }

    closeBeforeOpen() {
      this.readyState = WS_CLOSED;
      this.emit("close");
    }

    close() {
      this.closeCalls++;
      if (this.readyState !== WS_CLOSED) {
        this.readyState = WS_CLOSED;
        this.emit("close");
      }
    }
  };
}

function createDaemonManager(info = {}) {
  const state = {
    ensureCalls: 0,
    forceStopCalls: 0,
    daemonClient: null,
  };
  return {
    state,
    daemonManager: {
      setDaemonClient(client) {
        state.daemonClient = client;
      },
      async ensureDaemon() {
        state.ensureCalls++;
        return {
          pid: 100,
          protocolVersion: 1,
          controlPort: 9123,
          heartbeat: 1000,
          ...info,
        };
      },
      async forceStopDaemon() {
        state.forceStopCalls++;
      },
    },
  };
}

function createClient(overrides = {}) {
  const WebSocketCtor = overrides.WebSocketCtor ?? createWebSocketCtor();
  const { daemonManager, state } = createDaemonManager(overrides.discovery);
  const client = new MultiplexerDaemonClient({
    daemonManager,
    WebSocketCtor,
    rpcTimeout: overrides.rpcTimeout ?? 50,
    controlPath: overrides.controlPath,
    debugInfo: overrides.debugInfo,
    now: overrides.now,
  });

  return {
    client,
    WebSocketCtor,
    daemonManagerState: state,
  };
}

function parseSent(socket, index = 0) {
  return JSON.parse(socket.sent[index]);
}

async function openClient(client, WebSocketCtor) {
  const promise = client.connect();
  await waitFor(() => WebSocketCtor.instances.length === 1);
  const socket = WebSocketCtor.instances[0];
  socket.open();
  await promise;
  return socket;
}

function sendRpcResponse(socket, id, response) {
  socket.emit(
    "message",
    JSON.stringify({
      kind: "rpc-response",
      id,
      ...response,
    })
  );
}

function createInitializeMessage(clientId) {
  return {
    event: "Initialize",
    data: clientId,
  };
}

function createRegisterResponse(id) {
  return {
    event: "Register",
    data: {
      id,
      info: {},
    },
  };
}

describe("MultiplexerDaemonClient", function () {
  afterEach(function () {
    setDriverReportService(null);
    defaultLogger.setOutput(() => {});
  });

  it("connects to the daemon control url and reuses an open socket", async function () {
    const { client, WebSocketCtor, daemonManagerState } = createClient({
      discovery: { controlPort: 12345 },
      controlPath: "/custom-control",
    });

    const socket = await openClient(client, WebSocketCtor);
    await client.connect();

    assert.strictEqual(client.ready, true);
    assert.strictEqual(daemonManagerState.ensureCalls, 1);
    assert.strictEqual(WebSocketCtor.instances.length, 1);
    assert.strictEqual(socket.url, "ws://127.0.0.1:12345/custom-control");
  });

  it("forwards forceStopDaemon to the daemon manager", async function () {
    const { client, daemonManagerState } = createClient();

    await client.forceStopDaemon();

    assert.strictEqual(daemonManagerState.forceStopCalls, 1);
    assert.strictEqual(daemonManagerState.ensureCalls, 0);
  });

  it("shares an in-flight connect attempt", async function () {
    const { client, WebSocketCtor, daemonManagerState } = createClient();

    const first = client.connect();
    const second = client.connect();
    await waitFor(() => WebSocketCtor.instances.length === 1);
    assert.strictEqual(WebSocketCtor.instances.length, 1);

    WebSocketCtor.instances[0].open();
    await Promise.all([first, second]);

    assert.strictEqual(daemonManagerState.ensureCalls, 1);
    assert.strictEqual(client.ready, true);
  });

  it("rejects connect when the socket errors before opening", async function () {
    const { client, WebSocketCtor } = createClient();
    const promise = client.connect();
    await waitFor(() => WebSocketCtor.instances.length === 1);
    const socket = WebSocketCtor.instances[0];

    socket.emit("error", new Error("connect failed"));

    await assert.rejects(() => promise, /connect failed/);
    assert.strictEqual(client.ready, false);
  });

  it("rejects connect when the socket closes before opening", async function () {
    const { client, WebSocketCtor } = createClient();
    const promise = client.connect();
    await waitFor(() => WebSocketCtor.instances.length === 1);

    WebSocketCtor.instances[0].closeBeforeOpen();

    await assert.rejects(
      () => promise,
      /Multiplexer control socket closed before open/
    );
    assert.strictEqual(client.ready, false);
  });

  it("sends RPC requests with debug info and resolves successful responses", async function () {
    const { client, WebSocketCtor } = createClient({
      debugInfo: {
        protocolVersion: 3,
        clientVersion: "1.2.3",
      },
      now: () => 1234,
    });
    const socket = await openClient(client, WebSocketCtor);

    const result = client.call("sendMessageWithReply", {
      clientId: 1,
      message: createInitializeMessage(1),
    });
    await waitFor(() => socket.sent.length === 1);
    const request = parseSent(socket);

    assert.deepStrictEqual(request, {
      kind: "rpc",
      id: 1,
      method: "sendMessageWithReply",
      params: {
        clientId: 1,
        message: createInitializeMessage(1),
      },
      debugInfo: {
        protocolVersion: 3,
        clientVersion: "1.2.3",
        processId: process.pid,
        timestamp: 1234,
      },
    });

    sendRpcResponse(socket, request.id, {
      ok: true,
      result: createRegisterResponse(1),
    });

    assert.deepStrictEqual(await result, createRegisterResponse(1));
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("omits debug info from RPC requests when it is not configured", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);

    const result = client.call("closeClient", {
      clientId: 1,
    });
    await waitFor(() => socket.sent.length === 1);
    const request = parseSent(socket);

    assert.deepStrictEqual(request, {
      kind: "rpc",
      id: 1,
      method: "closeClient",
      params: {
        clientId: 1,
      },
    });

    sendRpcResponse(socket, request.id, {
      ok: true,
      result: {},
    });
    assert.deepStrictEqual(await result, {});
  });

  it("rejects invalid single-device watch params before sending the RPC", async function () {
    const { client, WebSocketCtor, daemonManagerState } = createClient();
    const invalidCalls = [
      ["startDeviceClientWatcher", { deviceId: "" }],
      ["startDeviceClientWatcher", { deviceId: "device-1", action: "start" }],
      ["stopDeviceClientWatcher", { deviceId: "" }],
      ["stopDeviceClientWatcher", { deviceId: "device-1", action: "stop" }],
    ];

    for (const [method, params] of invalidCalls) {
      await assert.rejects(
        () => client.call(method, params),
        new RegExp(`Invalid multiplexer RPC ${method} params`)
      );
    }

    assert.strictEqual(WebSocketCtor.instances.length, 0);
    assert.strictEqual(daemonManagerState.ensureCalls, 0);
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("calls a specific discovery without asking the manager to resolve a daemon", async function () {
    const { client, WebSocketCtor, daemonManagerState } = createClient();
    const promise = client.callOnDiscovery(
      {
        pid: 999,
        protocolVersion: 1,
        controlPort: 45678,
        heartbeat: 1000,
      },
      "shutdownDaemon",
      { reason: "stale-daemon" }
    );
    await waitFor(() => WebSocketCtor.instances.length === 1);
    const socket = WebSocketCtor.instances[0];
    socket.open();
    await waitFor(() => socket.sent.length === 1);
    const request = parseSent(socket);

    assert.strictEqual(daemonManagerState.ensureCalls, 0);
    assert.strictEqual(
      socket.url,
      "ws://127.0.0.1:45678/debug-router-multiplexer/control"
    );
    assert.strictEqual(request.method, "shutdownDaemon");
    assert.deepStrictEqual(request.params, { reason: "stale-daemon" });

    sendRpcResponse(socket, request.id, {
      ok: true,
      result: {},
    });

    assert.deepStrictEqual(await promise, {});
    assert.strictEqual(socket.closeCalls, 0);
    assert.strictEqual(client.ready, true);
    assert.strictEqual(daemonManagerState.daemonClient, client);
  });

  it("rejects RPC responses carrying daemon errors", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);

    const result = client.call("sendMessageWithReply", {
      clientId: 2,
      message: createInitializeMessage(2),
    });
    await waitFor(() => socket.sent.length === 1);
    const request = parseSent(socket);

    sendRpcResponse(socket, request.id, {
      ok: false,
      error: {
        code: "daemon-error",
        message: "daemon rejected",
      },
    });

    await assert.rejects(
      () => result,
      (error) =>
        error.name === "daemon-error" && error.message === "daemon rejected"
    );
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("rejects startWSServer responses without an explicit result", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);

    const result = client.call("startWSServer", {});
    await waitFor(() => socket.sent.length === 1);
    const request = parseSent(socket);

    sendRpcResponse(socket, request.id, {
      ok: true,
    });

    await assert.rejects(
      () => result,
      /Invalid multiplexer RPC startWSServer response payload/
    );
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("ignores responses with unknown ids", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);

    const result = client.call("sendMessageWithReply", {
      clientId: 4,
      message: createInitializeMessage(4),
    });
    await waitFor(() => socket.sent.length === 1);
    const request = parseSent(socket);

    sendRpcResponse(socket, request.id + 1, {
      ok: true,
      result: createRegisterResponse(404),
    });
    assert.strictEqual(client.pendingRpc.size, 1);

    sendRpcResponse(socket, request.id, {
      ok: true,
      result: createRegisterResponse(4),
    });
    assert.deepStrictEqual(await result, createRegisterResponse(4));
  });

  it("rejects RPCs when socket send fails", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);
    socket.sendError = new Error("send failed");

    await assert.rejects(
      () =>
        client.call("sendMessageWithReply", {
          clientId: 5,
          message: createInitializeMessage(5),
        }),
      /send failed/
    );
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("times out pending RPCs and removes them from the pending map", async function () {
    const { client, WebSocketCtor } = createClient({ rpcTimeout: 1 });
    const socket = await openClient(client, WebSocketCtor);

    const result = client.call("sendMessageWithReply", {
      clientId: 6,
      message: createInitializeMessage(6),
    });
    await waitFor(() => socket.sent.length === 1);

    await assert.rejects(
      () => result,
      /Timed out waiting for multiplexer RPC sendMessageWithReply response/
    );
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("does not time out a long-poll RPC before its operation timeout can resolve", async function () {
    const { client, WebSocketCtor } = createClient({ rpcTimeout: 5 });
    const socket = await openClient(client, WebSocketCtor);

    const result = client.call("connectDevices", {
      timeout: 30,
      serial: null,
      isAutoListenClients: true,
    });
    await waitFor(() => socket.sent.length === 1);
    const request = parseSent(socket);

    setTimeout(() => {
      sendRpcResponse(socket, request.id, {
        ok: true,
        result: [],
      });
    }, 15);

    assert.deepStrictEqual(await result, []);
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("dispatches events to the single active listener", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);
    const firstEvents = [];
    const secondEvents = [];
    const unsubscribeFirst = client.subscribe((event) =>
      firstEvents.push(event)
    );
    const unsubscribeSecond = client.subscribe((event) =>
      secondEvents.push(event)
    );
    const event = {
      kind: "event",
      event: "client-message",
      data: { source: "usb-runtime", id: 99, message: "hello" },
    };

    socket.emit("message", [Buffer.from(JSON.stringify(event))]);
    unsubscribeFirst();
    socket.emit("message", JSON.stringify(event));
    unsubscribeSecond();
    socket.emit("message", JSON.stringify(event));

    assert.deepStrictEqual(firstEvents, []);
    assert.deepStrictEqual(secondEvents, [event, event]);
  });

  it("wraps snapshots as snapshot events", function () {
    const { client } = createClient();
    const events = [];
    const snapshot = {
      devices: [],
      usbClients: [],
      websocketAppClients: [],
      websocketWebClients: [],
    };

    client.subscribe((event) => events.push(event));
    client.handleSnapshot(snapshot);

    assert.deepStrictEqual(events, [
      {
        kind: "event",
        event: "snapshot",
        data: snapshot,
      },
    ]);
  });

  it("logs unknown structured control messages without reporting from the Connector process", async function () {
    const reports = [];
    const warnings = [];
    setDriverReportService({
      init() {},
      report(...args) {
        reports.push(args);
      },
    });
    defaultLogger.setOutput((level, ...messages) => {
      if (level === "warn") {
        warnings.push(messages.join(" "));
      }
    });
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);

    socket.emit(
      "message",
      JSON.stringify({
        kind: "future-kind",
        event: "future-event",
        id: 10,
        data: {},
      })
    );

    assert.deepStrictEqual(reports, []);
    assert.strictEqual(warnings.length, 1);
    assert(
      warnings[0].includes(
        '"kind":"future-kind","event":"future-event","id":10'
      )
    );
  });

  it("logs invalid unknown messages with truncated previews without reporting", async function () {
    const reports = [];
    const warnings = [];
    setDriverReportService({
      init() {},
      report(...args) {
        reports.push(args);
      },
    });
    defaultLogger.setOutput((level, ...messages) => {
      if (level === "warn") {
        warnings.push(messages.join(" "));
      }
    });
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);
    const text = "x".repeat(600);
    const bytes = Uint8Array.from(Buffer.from(text));

    socket.emit("message", bytes.buffer);

    assert.deepStrictEqual(reports, []);
    assert.strictEqual(warnings.length, 1);
    assert(warnings[0].includes('"parseResult":"invalid-json"'));
    assert(warnings[0].includes(`"messagePreview":"${"x".repeat(500)}..."`));
  });

  it("rejects pending RPCs and removes listeners when the socket closes", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);
    const result = client.call("sendMessageWithReply", {
      clientId: 7,
      message: createInitializeMessage(7),
    });
    await waitFor(() => socket.sent.length === 1);

    socket.emit("close");

    await assert.rejects(() => result, /Multiplexer control socket closed/);
    assert.strictEqual(client.ready, false);
    assert.strictEqual(client.pendingRpc.size, 0);
    assert.strictEqual(socket.listenerCount("message"), 0);
    assert.strictEqual(socket.listenerCount("close"), 0);
    assert.strictEqual(socket.listenerCount("error"), 0);
  });

  it("closes the current socket and reconnects with a new socket", async function () {
    const { client, WebSocketCtor, daemonManagerState } = createClient();
    const firstSocket = await openClient(client, WebSocketCtor);

    const reconnect = client.reconnect();
    assert.strictEqual(firstSocket.closeCalls, 1);
    await waitFor(() => WebSocketCtor.instances.length === 2);
    assert.strictEqual(WebSocketCtor.instances.length, 2);
    WebSocketCtor.instances[1].open();
    await reconnect;

    assert.strictEqual(client.ready, true);
    assert.strictEqual(daemonManagerState.ensureCalls, 2);
  });

  it("notifies connection state listeners on connect, disconnect, and unsubscribe", async function () {
    const { client, WebSocketCtor } = createClient();
    const states = [];
    const unsubscribe = client.subscribeConnectionState((state) =>
      states.push(state.state)
    );
    const socket = await openClient(client, WebSocketCtor);

    socket.emit("close");
    await nextTick();
    unsubscribe();
    const reconnect = client.connect();
    await waitFor(() => WebSocketCtor.instances.length === 2);
    WebSocketCtor.instances[1].open();
    await reconnect;

    assert.deepStrictEqual(states, ["connected", "disconnected"]);
  });

  it("close clears the listener, closes the socket, and rejects pending RPCs", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);
    const events = [];
    client.subscribe((event) => events.push(event));
    const result = client.call("sendMessageWithReply", {
      clientId: 8,
      message: createInitializeMessage(8),
    });
    await waitFor(() => socket.sent.length === 1);

    await client.close();
    client.handleHostEvent({
      kind: "event",
      event: "client-message",
      data: { source: "usb-runtime", id: 1, message: "hello" },
    });

    await assert.rejects(() => result, /Multiplexer remote client closed/);
    assert.strictEqual(socket.closeCalls, 1);
    assert.deepStrictEqual(events, []);
    assert.strictEqual(client.ready, false);
  });
});
