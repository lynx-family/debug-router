// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

const {
  MultiplexerControlConnection,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/MultiplexerControlConnection");

class FakeTransport {
  constructor() {
    this.writable = true;
    this.closed = false;
    this.sent = [];
    this.messageListeners = new Set();
    this.closeListeners = new Set();
  }
  send(value) {
    if (this.sendError) throw this.sendError;
    this.sent.push(value);
  }
  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  emitMessage(value) {
    for (const listener of [...this.messageListeners]) listener(value);
  }
  emitClose(error) {
    this.closed = true;
    this.writable = false;
    for (const listener of [...this.closeListeners]) listener(error);
  }
  async end() {
    this.emitClose();
  }
  destroy() {
    this.emitClose();
  }
}

function request(id = 1) {
  return { kind: "rpc", id, method: "startWSServer", params: {} };
}

function createConnection(overrides = {}) {
  const transport = overrides.transport ?? new FakeTransport();
  const messages = [];
  const closes = [];
  const connection = new MultiplexerControlConnection({
    controlId: 7,
    transport,
    onMessage:
      overrides.onMessage ??
      (async (id, message) => {
        messages.push([id, message]);
      }),
    onClose: (id) => closes.push(id),
    createDebugInfo: overrides.createDebugInfo,
  });
  return { connection, transport, messages, closes };
}

describe("MultiplexerControlConnection", function () {
  it("dispatches valid RPCs and rejects invalid messages", function () {
    const { transport, messages } = createConnection();
    transport.emitMessage(request(3));
    transport.emitMessage({ id: 4, nope: true });
    assert.deepStrictEqual(messages, [[7, request(3)]]);
    assert.deepStrictEqual(transport.sent[0], {
      kind: "rpc-response",
      id: 4,
      ok: false,
      error: {
        code: "invalid-control-message",
        message: "Invalid multiplexer control message",
      },
    });
  });

  it("sends results, errors, events, and optional debug info", function () {
    const { connection, transport } = createConnection({
      createDebugInfo: () => ({ processId: 10 }),
    });
    connection.sendResponse(1, undefined);
    connection.sendError(2, { code: "failed", message: "no" });
    connection.send({ kind: "event", event: "snapshot", data: {} });
    assert.deepStrictEqual(transport.sent[0], {
      kind: "rpc-response",
      id: 1,
      ok: true,
      result: {},
      debugInfo: { processId: 10 },
    });
    assert.strictEqual(transport.sent.length, 3);
  });

  it("closes idempotently and unregisters once", async function () {
    const { connection, transport, closes } = createConnection();
    await connection.close();
    connection.handleClose();
    transport.emitClose();
    assert.deepStrictEqual(closes, [7]);
  });
});
