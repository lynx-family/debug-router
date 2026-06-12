// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { EventEmitter } = require("events");

require("../register_ts");

const {
  MultiplexerControlServer,
} = require("../../../../debug_router_connector/src/multiplexer/daemon/MultiplexerControlServer");

const WS_OPEN = 1;
const WS_CLOSED = 3;

class FakeSocket extends EventEmitter {
  constructor(readyState = WS_OPEN) {
    super();
    this.readyState = readyState;
    this.sent = [];
    this.closeCalls = 0;
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls++;
    this.readyState = WS_CLOSED;
    this.emit("close");
  }
}

function createRequest(url) {
  return {
    url,
  };
}

function createResponseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

function createUpgradeSocketRecorder() {
  return {
    chunks: [],
    destroyed: false,
    write(chunk) {
      this.chunks.push(chunk);
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

function createRpcRequest(overrides = {}) {
  return {
    kind: "rpc",
    id: 1,
    method: "sendMessageToWeb",
    params: {
      message: "hello",
    },
    ...overrides,
  };
}

function parseSent(socket, index = 0) {
  return JSON.parse(socket.sent[index]);
}

describe("MultiplexerControlServer", function () {
  it("includes minSupportedProtocolVersion in health response", function () {
    const response = createResponseRecorder();
    const server = new MultiplexerControlServer({
      host: {
        handleControlRpc() {},
      },
      protocolVersion: 3,
      minSupportedProtocolVersion: 2,
      daemonVersion: "0.0.3",
      capabilities: ["control"],
      now: () => 1000,
    });

    server.handleHealth({}, response);

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(
      response.headers["content-type"],
      "application/json; charset=utf-8"
    );
    assert.deepStrictEqual(JSON.parse(response.body), {
      ok: true,
      pid: process.pid,
      protocolVersion: 3,
      minSupportedProtocolVersion: 2,
      heartbeat: 1000,
      daemonVersion: "0.0.3",
      capabilities: ["control"],
    });
  });

  it("uses default health protocol fields and omits optional metadata", function () {
    const response = createResponseRecorder();
    const server = new MultiplexerControlServer({
      host: {
        handleControlRpc() {},
      },
      now: () => 2000,
    });

    server.handleHealth({}, response);

    assert.deepStrictEqual(JSON.parse(response.body), {
      ok: true,
      pid: process.pid,
      protocolVersion: 1,
      minSupportedProtocolVersion: 1,
      heartbeat: 2000,
    });
  });

  it("registers connections with incrementing ids and unregisters on close", function () {
    const server = new MultiplexerControlServer({
      host: {
        handleControlRpc() {},
      },
    });
    const first = server.registerConnection(new FakeSocket());
    const second = server.registerConnection(new FakeSocket());

    assert.strictEqual(first.controlId, 1);
    assert.strictEqual(second.controlId, 2);
    assert.strictEqual(server.connections.size, 2);

    first.close();

    assert.strictEqual(server.connections.has(1), false);
    assert.strictEqual(server.connections.has(2), true);
  });

  it("dispatches RPCs to the host and sends successful responses", async function () {
    const calls = [];
    const server = new MultiplexerControlServer({
      host: {
        handleControlRpc(controlId, message) {
          calls.push([controlId, message]);
          return "ok";
        },
      },
    });
    const socket = new FakeSocket();
    const connection = server.registerConnection(socket);
    const message = createRpcRequest({ id: 10 });

    await server.dispatchRpc(connection.controlId, message);

    assert.deepStrictEqual(calls, [[connection.controlId, message]]);
    assert.deepStrictEqual(parseSent(socket), {
      kind: "rpc-response",
      id: 10,
      ok: true,
      result: "ok",
    });
  });

  it("wraps host Error throws into control RPC errors", async function () {
    const server = new MultiplexerControlServer({
      host: {
        handleControlRpc() {
          throw new Error("host failed");
        },
      },
    });
    const socket = new FakeSocket();
    const connection = server.registerConnection(socket);

    await server.dispatchRpc(connection.controlId, createRpcRequest({ id: 11 }));

    assert.deepStrictEqual(parseSent(socket), {
      kind: "rpc-response",
      id: 11,
      ok: false,
      error: {
        code: "control-rpc-failed",
        message: "host failed",
      },
    });
  });

  it("preserves host-thrown control RPC errors", async function () {
    const server = new MultiplexerControlServer({
      host: {
        handleControlRpc() {
          throw {
            code: "custom-control-error",
            message: "custom failed",
            details: { retry: false },
          };
        },
      },
    });
    const socket = new FakeSocket();
    const connection = server.registerConnection(socket);

    await server.dispatchRpc(connection.controlId, createRpcRequest({ id: 12 }));

    assert.deepStrictEqual(parseSent(socket), {
      kind: "rpc-response",
      id: 12,
      ok: false,
      error: {
        code: "custom-control-error",
        message: "custom failed",
        details: { retry: false },
      },
    });
  });

  it("uses a generic control RPC error for non-error throws", async function () {
    const server = new MultiplexerControlServer({
      host: {
        handleControlRpc() {
          throw "bad value";
        },
      },
    });
    const socket = new FakeSocket();
    const connection = server.registerConnection(socket);

    await server.dispatchRpc(connection.controlId, createRpcRequest({ id: 13 }));

    assert.deepStrictEqual(parseSent(socket), {
      kind: "rpc-response",
      id: 13,
      ok: false,
      error: {
        code: "control-rpc-failed",
        message: "Multiplexer control RPC failed",
      },
    });
  });

  it("does not dispatch RPCs for missing or closed connections", async function () {
    const calls = [];
    const server = new MultiplexerControlServer({
      host: {
        handleControlRpc(controlId) {
          calls.push(controlId);
        },
      },
    });
    const connection = server.registerConnection(new FakeSocket());
    connection.close();

    await server.dispatchRpc(connection.controlId, createRpcRequest({ id: 14 }));
    await server.dispatchRpc(999, createRpcRequest({ id: 15 }));

    assert.deepStrictEqual(calls, []);
  });

  it("broadcasts to all controls and sends targeted events", function () {
    const server = new MultiplexerControlServer({
      host: {
        handleControlRpc() {},
      },
    });
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const first = server.registerConnection(firstSocket);
    const second = server.registerConnection(secondSocket);
    const broadcast = {
      kind: "event",
      event: "client-disconnected",
      data: { id: 1 },
    };
    const targeted = {
      kind: "event",
      event: "client-disconnected",
      data: { id: 2 },
    };

    server.broadcast(broadcast);
    server.sendToControl(second.controlId, targeted);
    server.sendToControl(999, targeted);

    assert.deepStrictEqual(firstSocket.sent.map(JSON.parse), [broadcast]);
    assert.deepStrictEqual(secondSocket.sent.map(JSON.parse), [
      broadcast,
      targeted,
    ]);
    assert.strictEqual(first.controlId, 1);
    assert.strictEqual(second.controlId, 2);
  });

  it("rejects upgrades when no websocket server is active", function () {
    const server = new MultiplexerControlServer({
      host: {
        handleControlRpc() {},
      },
      controlPath: "/control",
    });
    const socket = createUpgradeSocketRecorder();

    server.handleUpgrade(createRequest("/control?x=1"), socket);

    assert.deepStrictEqual(socket.chunks, [
      "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n",
    ]);
    assert.strictEqual(socket.destroyed, true);
  });

  it("stop is safe before start", async function () {
    const server = new MultiplexerControlServer({
      host: {
        handleControlRpc() {},
      },
      controlPort: 1234,
    });

    await server.stop();

    assert.strictEqual(server.controlPort, 1234);
    assert.strictEqual(server.connections.size, 0);
  });
});
