// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  MultiplexerDaemon,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/MultiplexerDaemon");

function createHost(overrides = {}) {
  return {
    startCalls: 0,
    stopCalls: 0,
    async start(option) {
      this.startCalls++;
      this.startOption = option;
      if (overrides.start) return overrides.start();
    },
    async stop() {
      this.stopCalls++;
      if (overrides.stop) return overrides.stop();
    },
    setIdleTimeoutHandler(handler) {
      this.idleHandler = handler;
    },
    setShutdownHandler(handler) {
      this.shutdownHandler = handler;
    },
  };
}

describe("MultiplexerDaemon", function () {
  let tempDir;

  beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-daemon-"));
  });

  afterEach(function () {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts once without creating daemon.lock or daemon.json", async function () {
    const host = createHost();
    const daemon = new MultiplexerDaemon({
      host,
      hostOption: { idle: 10 },
    });
    await daemon.start();
    await daemon.start();
    assert.strictEqual(host.startCalls, 1);
    assert.deepStrictEqual(host.startOption, { idle: 10 });
    assert.strictEqual(fs.existsSync(path.join(tempDir, "daemon.lock")), false);
    assert.strictEqual(fs.existsSync(path.join(tempDir, "daemon.json")), false);
    await daemon.stop();
  });

  it("stops cleanly when host start fails", async function () {
    const host = createHost({
      start() {
        throw new Error("start failed");
      },
    });
    const daemon = new MultiplexerDaemon({ host });
    await assert.rejects(() => daemon.start(), /start failed/);
  });

  it("rethrows host stop failures", async function () {
    const host = createHost({
      stop() {
        throw new Error("stop failed");
      },
    });
    const daemon = new MultiplexerDaemon({ host });
    await daemon.start();
    await assert.rejects(() => daemon.stop(), /stop failed/);
  });

  it("stops for idle and shutdown callbacks", async function () {
    for (const kind of ["idle", "shutdown"]) {
      const host = createHost();
      const calls = [];
      const daemon = new MultiplexerDaemon({
        host,
        onIdleTimeout: (error) => calls.push(["idle", error]),
        onShutdownRequest: (error) => calls.push(["shutdown", error]),
      });
      await daemon.start();
      await (kind === "idle" ? host.idleHandler() : host.shutdownHandler());
      assert.strictEqual(host.stopCalls, 1);
      assert.deepStrictEqual(calls, [[kind, undefined]]);
    }
  });
});
