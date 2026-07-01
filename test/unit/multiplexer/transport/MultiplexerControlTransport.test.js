// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { EventEmitter } = require("events");

const {
  MultiplexerControlTransport,
  MultiplexerControlTransportError,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/transport/MultiplexerControlTransport");

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.destroyed = false;
    this.writes = [];
    this.writeResult = true;
  }

  write(data) {
    this.writes.push(Buffer.from(data));
    if (this.writeError) {
      throw this.writeError;
    }
    return this.writeResult;
  }

  end() {
    this.writable = false;
    this.destroyed = true;
    this.emit("close");
  }

  destroy() {
    if (this.destroyed) return;
    this.writable = false;
    this.destroyed = true;
    this.emit("close");
  }
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(4 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

describe("MultiplexerControlTransport", function () {
  it("parses split headers, split payloads, and multiple frames", function () {
    const socket = new FakeSocket();
    const transport = new MultiplexerControlTransport(socket);
    const messages = [];
    transport.onMessage((message) => messages.push(message));

    const first = frame({ id: 1 });
    const second = frame({ id: 2 });
    socket.emit("data", first.subarray(0, 2));
    socket.emit("data", first.subarray(2, 7));
    assert.deepStrictEqual(messages, []);
    socket.emit("data", Buffer.concat([first.subarray(7), second]));

    assert.deepStrictEqual(messages, [{ id: 1 }, { id: 2 }]);
  });

  it("hands off the message listener between frames in the same chunk", function () {
    const socket = new FakeSocket();
    const transport = new MultiplexerControlTransport(socket);
    const messages = [];
    transport.onMessage((message) => {
      messages.push(["handshake", message]);
      transport.onMessage((nextMessage) => {
        messages.push(["steady", nextMessage]);
      });
    });

    socket.emit("data", Buffer.concat([frame({ id: 1 }), frame({ id: 2 })]));

    assert.deepStrictEqual(messages, [
      ["handshake", { id: 1 }],
      ["steady", { id: 2 }],
    ]);
  });

  it("writes complete ordered frames", function () {
    const socket = new FakeSocket();
    const transport = new MultiplexerControlTransport(socket);

    transport.send({ id: 1 });
    transport.send({ id: 2 });

    assert.deepStrictEqual(socket.writes, [frame({ id: 1 }), frame({ id: 2 })]);
  });

  it("closes on a zero or oversized incoming payload length", function () {
    const zeroLengthSocket = new FakeSocket();
    const zeroLengthTransport = new MultiplexerControlTransport(
      zeroLengthSocket
    );
    let zeroLengthError;
    zeroLengthTransport.onClose((error) => {
      zeroLengthError = error;
    });
    zeroLengthSocket.emit("data", Buffer.alloc(4));

    assert.strictEqual(zeroLengthTransport.closed, true);
    assert.strictEqual(zeroLengthError.code, "invalid-frame");

    const oversizedSocket = new FakeSocket();
    const oversizedTransport = new MultiplexerControlTransport(
      oversizedSocket,
      { maxFrameSize: 4 }
    );
    let oversizedError;
    oversizedTransport.onClose((error) => {
      oversizedError = error;
    });
    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32BE(5, 0);
    oversizedSocket.emit("data", oversizedHeader);

    assert.strictEqual(oversizedTransport.closed, true);
    assert.strictEqual(oversizedError.code, "frame-too-large");
  });

  it("closes on invalid JSON without parsing later frames", function () {
    const socket = new FakeSocket();
    const transport = new MultiplexerControlTransport(socket);
    const messages = [];
    let closeError;
    transport.onMessage((message) => messages.push(message));
    transport.onClose((error) => {
      closeError = error;
    });
    const invalidPayload = Buffer.from("{");
    const invalidFrame = Buffer.alloc(5);
    invalidFrame.writeUInt32BE(1, 0);
    invalidPayload.copy(invalidFrame, 4);
    socket.emit("data", Buffer.concat([invalidFrame, frame({ id: 1 })]));

    assert.deepStrictEqual(messages, []);
    assert.strictEqual(transport.closed, true);
    assert.strictEqual(closeError.code, "invalid-frame");
  });

  it("rejects oversized outgoing frames", function () {
    const socket = new FakeSocket();
    const transport = new MultiplexerControlTransport(socket, {
      maxFrameSize: 4,
    });

    assert.throws(
      () => transport.send(12345),
      (error) =>
        error instanceof MultiplexerControlTransportError &&
        error.code === "frame-too-large"
    );
  });

  it("rejects send on non-writable sockets and propagates sync write errors", function () {
    const closedSocket = new FakeSocket();
    closedSocket.writable = false;
    const closedTransport = new MultiplexerControlTransport(closedSocket);
    assert.throws(() => closedTransport.send({}));

    const errorSocket = new FakeSocket();
    const writeError = new Error("write failed");
    errorSocket.writeError = writeError;
    const errorTransport = new MultiplexerControlTransport(errorSocket);
    assert.throws(
      () => errorTransport.send({}),
      (error) => error === writeError
    );
  });

  it("notifies close once across error, end, close, and destroy", function () {
    const socket = new FakeSocket();
    const transport = new MultiplexerControlTransport(socket);
    const closes = [];
    transport.onClose((error) => closes.push(error));

    const socketError = new Error("boom");
    socket.emit("error", socketError);
    socket.emit("end");
    socket.emit("close");
    transport.destroy(new Error("later"));

    assert.deepStrictEqual(closes, [socketError]);
  });
});
