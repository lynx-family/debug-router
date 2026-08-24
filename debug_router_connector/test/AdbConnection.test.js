// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  disposeAdbConnection,
  withAdbConnection,
} = require("../dist/cjs/src/utils/adb.connection");

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.destroyCalls = 0;
  }

  destroy() {
    this.destroyed = true;
    this.destroyCalls += 1;
    queueMicrotask(() => this.emit("close"));
  }
}

function fakeConnection(socket) {
  return {
    getSocket() {
      return socket;
    },
  };
}

describe("ADB connection disposal", () => {
  it("waits for the socket to close after a successful command", async () => {
    const socket = new FakeSocket();
    const result = await withAdbConnection(
      async () => fakeConnection(socket),
      async () => "done",
    );

    assert.equal(result, "done");
    assert.equal(socket.destroyCalls, 1);
    assert.equal(socket.destroyed, true);
  });

  it("also closes the socket when the command fails", async () => {
    const socket = new FakeSocket();

    await assert.rejects(
      withAdbConnection(
        async () => fakeConnection(socket),
        async () => {
          throw new Error("command failed");
        },
      ),
      /command failed/,
    );

    assert.equal(socket.destroyCalls, 1);
  });

  it("does not destroy an already destroyed socket again", async () => {
    const socket = new FakeSocket();
    socket.destroyed = true;

    await disposeAdbConnection(fakeConnection(socket));

    assert.equal(socket.destroyCalls, 0);
  });
});
