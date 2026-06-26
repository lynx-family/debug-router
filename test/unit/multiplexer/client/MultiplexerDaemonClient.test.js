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
  };
  return {
    state,
    daemonManager: {
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
    protocolVersion: overrides.protocolVersion,
    clientVersion: overrides.clientVersion,
    capabilities: overrides.capabilities,
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

  it("sends RPC requests with metadata and resolves successful responses", async function () {
    const { client, WebSocketCtor } = createClient({
      protocolVersion: 3,
      clientVersion: "1.2.3",
      capabilities: ["client", "test"],
    });
    const socket = await openClient(client, WebSocketCtor);

    const result = client.call("sendCustomizedMessage", {
      clientId: 1,
      method: "Runtime.evaluate",
    });
    await waitFor(() => socket.sent.length === 1);
    const request = parseSent(socket);

    assert.deepStrictEqual(request, {
      kind: "rpc",
      id: 1,
      method: "sendCustomizedMessage",
      params: {
        clientId: 1,
        method: "Runtime.evaluate",
      },
      meta: {
        protocolVersion: 3,
        clientVersion: "1.2.3",
        capabilities: ["client", "test"],
      },
    });

    sendRpcResponse(socket, request.id, {
      ok: true,
      result: "done",
    });

    assert.strictEqual(await result, "done");
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("rejects RPC responses carrying daemon errors", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);

    const result = client.call("sendCustomizedMessage", {
      clientId: 2,
      method: "Page.reload",
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

  it("rejects method-aware RPC responses with invalid result payloads", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);

    const result = client.call("startWSServer", {});
    await waitFor(() => socket.sent.length === 1);
    const request = parseSent(socket);

    sendRpcResponse(socket, request.id, {
      ok: true,
      result: "should-be-undefined",
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

    const result = client.call("sendCustomizedMessage", {
      clientId: 4,
      method: "Runtime.evaluate",
    });
    await waitFor(() => socket.sent.length === 1);
    const request = parseSent(socket);

    sendRpcResponse(socket, request.id + 1, {
      ok: true,
      result: "ignored",
    });
    assert.strictEqual(client.pendingRpc.size, 1);

    sendRpcResponse(socket, request.id, {
      ok: true,
      result: "accepted",
    });
    assert.strictEqual(await result, "accepted");
  });

  it("rejects RPCs when socket send fails", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);
    socket.sendError = new Error("send failed");

    await assert.rejects(
      () =>
        client.call("sendCustomizedMessage", {
          clientId: 5,
          method: "Runtime.evaluate",
        }),
      /send failed/
    );
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("times out pending RPCs and removes them from the pending map", async function () {
    const { client, WebSocketCtor } = createClient({ rpcTimeout: 1 });
    const socket = await openClient(client, WebSocketCtor);

    const result = client.call("sendCustomizedMessage", {
      clientId: 6,
      method: "Runtime.evaluate",
    });
    await waitFor(() => socket.sent.length === 1);

    await assert.rejects(
      () => result,
      /Timed out waiting for multiplexer RPC sendCustomizedMessage response/
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
    const unsubscribeFirst = client.subscribe((event) => firstEvents.push(event));
    const unsubscribeSecond = client.subscribe((event) =>
      secondEvents.push(event)
    );
    const event = {
      kind: "event",
      event: "client-disconnected",
      data: { id: 99 },
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

  it("reports unknown structured control messages", async function () {
    const reports = [];
    setDriverReportService({
      init() {},
      report(...args) {
        reports.push(args);
      },
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

    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0][0], "multiplexer_unknown_control_message");
    assert.deepStrictEqual(reports[0][2], {
      kind: "future-kind",
      event: "future-event",
      id: 10,
      parseResult: "object",
      messagePreview:
        '{"kind":"future-kind","event":"future-event","id":10,"data":{}}',
    });
  });

  it("reports invalid unknown messages with truncated previews", async function () {
    const reports = [];
    setDriverReportService({
      init() {},
      report(...args) {
        reports.push(args);
      },
    });
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);
    const text = "x".repeat(600);
    const bytes = Uint8Array.from(Buffer.from(text));

    socket.emit("message", bytes.buffer);

    assert.strictEqual(reports.length, 1);
    assert.deepStrictEqual(reports[0][2], {
      kind: undefined,
      event: undefined,
      id: undefined,
      parseResult: "invalid-json",
      messagePreview: `${"x".repeat(500)}...`,
    });
  });

  it("rejects pending RPCs and removes listeners when the socket closes", async function () {
    const { client, WebSocketCtor } = createClient();
    const socket = await openClient(client, WebSocketCtor);
    const result = client.call("sendCustomizedMessage", {
      clientId: 7,
      method: "Runtime.evaluate",
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
    const result = client.call("sendCustomizedMessage", {
      clientId: 8,
      method: "Runtime.evaluate",
    });
    await waitFor(() => socket.sent.length === 1);

    await client.close();
    client.handleHostEvent({
      kind: "event",
      event: "client-disconnected",
      data: { id: 1 },
    });

    await assert.rejects(() => result, /Multiplexer remote client closed/);
    assert.strictEqual(socket.closeCalls, 1);
    assert.deepStrictEqual(events, []);
    assert.strictEqual(client.ready, false);
  });
});
