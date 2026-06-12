// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { EventEmitter } = require("events");

require("../register_ts");

const {
  MultiplexerControlConnection,
} = require("../../../../debug_router_connector/src/multiplexer/daemon/MultiplexerControlConnection");

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

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

function createConnection(overrides = {}) {
  const messages = [];
  const closed = [];
  const socket = overrides.socket ?? new FakeSocket();
  const connection = new MultiplexerControlConnection({
    controlId: overrides.controlId ?? 11,
    socket,
    onMessage:
      overrides.onMessage ??
      ((controlId, message) => {
        messages.push([controlId, message]);
      }),
    onClose: overrides.onClose ?? ((controlId) => closed.push(controlId)),
  });

  return {
    socket,
    connection,
    messages,
    closed,
  };
}

function parseSent(socket, index = 0) {
  return JSON.parse(socket.sent[index]);
}

describe("MultiplexerControlConnection", function () {
  it("dispatches valid RPC messages from socket data", function () {
    const { socket, messages } = createConnection();
    const request = createRpcRequest({ id: 12 });

    socket.emit("message", JSON.stringify(request));

    assert.deepStrictEqual(messages, [[11, request]]);
  });

  it("parses RPC messages from buffer arrays", function () {
    const { socket, messages } = createConnection();
    const request = createRpcRequest({ id: 13 });

    socket.emit("message", [Buffer.from(JSON.stringify(request))]);

    assert.deepStrictEqual(messages, [[11, request]]);
  });

  it("sends invalid message errors using the incoming numeric id when present", function () {
    const { socket } = createConnection();

    socket.emit(
      "message",
      JSON.stringify({
        kind: "rpc",
        id: 14,
        method: "missing-method",
        params: {},
      })
    );

    assert.deepStrictEqual(parseSent(socket), {
      kind: "rpc-response",
      id: 14,
      ok: false,
      error: {
        code: "invalid-control-message",
        message: "Invalid multiplexer control message",
      },
    });
  });

  it("sends invalid message errors with the fallback id for non-json data", function () {
    const { socket } = createConnection();
    const bytes = Uint8Array.from(Buffer.from("{bad-json"));

    socket.emit("message", bytes.buffer);

    assert.deepStrictEqual(parseSent(socket), {
      kind: "rpc-response",
      id: -1,
      ok: false,
      error: {
        code: "invalid-control-message",
        message: "Invalid multiplexer control message",
      },
    });
  });

  it("sends responses and errors when the socket is open", function () {
    const { socket, connection } = createConnection();

    connection.sendResponse(21, { ok: true });
    connection.sendError(22, { code: "failed", message: "failed message" });

    assert.deepStrictEqual(parseSent(socket, 0), {
      kind: "rpc-response",
      id: 21,
      ok: true,
      result: { ok: true },
    });
    assert.deepStrictEqual(parseSent(socket, 1), {
      kind: "rpc-response",
      id: 22,
      ok: false,
      error: {
        code: "failed",
        message: "failed message",
      },
    });
  });

  it("filters events while unsubscribed but still sends RPC responses", function () {
    const { socket, connection } = createConnection();
    const event = {
      kind: "event",
      event: "client-disconnected",
      data: { id: 1 },
    };

    connection.unsubscribe();
    connection.send(event);
    connection.sendResponse(23, undefined);
    connection.subscribe();
    connection.send(event);

    assert.deepStrictEqual(socket.sent.map((item) => JSON.parse(item)), [
      {
        kind: "rpc-response",
        id: 23,
        ok: true,
      },
      event,
    ]);
  });

  it("does not send when the socket is closed or closing", function () {
    const closedSocket = new FakeSocket(WS_CLOSED);
    const closingSocket = new FakeSocket(WS_CLOSING);
    const closed = createConnection({ socket: closedSocket }).connection;
    const closing = createConnection({ socket: closingSocket }).connection;

    closed.sendResponse(24, undefined);
    closing.sendResponse(25, undefined);

    assert.deepStrictEqual(closedSocket.sent, []);
    assert.deepStrictEqual(closingSocket.sent, []);
  });

  it("converts synchronous dispatch errors into RPC errors", function () {
    const { socket, connection } = createConnection({
      onMessage() {
        throw new Error("sync dispatch failed");
      },
    });

    connection.handleMessage(createRpcRequest({ id: 30 }));

    assert.deepStrictEqual(parseSent(socket), {
      kind: "rpc-response",
      id: 30,
      ok: false,
      error: {
        code: "control-message-dispatch-failed",
        message: "sync dispatch failed",
      },
    });
  });

  it("converts asynchronous dispatch errors into RPC errors", async function () {
    const { socket, connection } = createConnection({
      async onMessage() {
        throw new Error("async dispatch failed");
      },
    });

    connection.handleMessage(createRpcRequest({ id: 31 }));
    await nextTick();

    assert.deepStrictEqual(parseSent(socket), {
      kind: "rpc-response",
      id: 31,
      ok: false,
      error: {
        code: "control-message-dispatch-failed",
        message: "async dispatch failed",
      },
    });
  });

  it("uses a generic dispatch error message for non-error rejections", async function () {
    const { socket, connection } = createConnection({
      onMessage() {
        return Promise.reject("bad value");
      },
    });

    connection.handleMessage(createRpcRequest({ id: 32 }));
    await nextTick();

    assert.deepStrictEqual(parseSent(socket), {
      kind: "rpc-response",
      id: 32,
      ok: false,
      error: {
        code: "control-message-dispatch-failed",
        message: "Failed to dispatch multiplexer control message",
      },
    });
  });

  it("ignores direct messages after the connection is closed", function () {
    const { connection, messages } = createConnection();

    connection.close();
    connection.handleMessage(createRpcRequest({ id: 33 }));

    assert.deepStrictEqual(messages, []);
  });

  it("closes open sockets, unregisters once, and removes socket listeners", function () {
    const { socket, connection, closed } = createConnection();

    connection.close();
    connection.close();
    socket.emit("message", JSON.stringify(createRpcRequest({ id: 40 })));

    assert.strictEqual(connection.closed, true);
    assert.deepStrictEqual(closed, [11]);
    assert.strictEqual(socket.closeCalls, 1);
    assert.strictEqual(socket.listenerCount("message"), 0);
    assert.strictEqual(socket.listenerCount("close"), 0);
  });

  it("marks closed sockets as closed without closing them again", function () {
    const socket = new FakeSocket(WS_CLOSED);
    const { connection, closed } = createConnection({ socket });

    connection.close();

    assert.strictEqual(connection.closed, true);
    assert.deepStrictEqual(closed, [11]);
    assert.strictEqual(socket.closeCalls, 0);
  });

  it("handles remote close idempotently", function () {
    const { socket, connection, closed } = createConnection();

    socket.emit("close");
    socket.emit("close");

    assert.strictEqual(connection.closed, true);
    assert.deepStrictEqual(closed, [11]);
  });
});
