// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("../register_ts");

const {
  MultiplexerDaemon,
} = require("../../../../debug_router_connector/src/multiplexer/daemon/MultiplexerDaemon");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-mux-daemon-"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createHost(overrides = {}) {
  const state = {
    started: 0,
    stopped: 0,
    startOptions: [],
    idleTimeoutHandler: null,
    shutdownHandler: null,
  };

  return {
    state,
    host: {
      start: async (option) => {
        state.started++;
        state.startOptions.push(option);
        if (overrides.start) {
          await overrides.start(option);
        }
      },
      stop: async () => {
        state.stopped++;
        if (overrides.stop) {
          await overrides.stop();
        }
      },
      getControlPort: () => {
        return overrides.controlPort ?? 9100;
      },
      setIdleTimeoutHandler: (handler) => {
        state.idleTimeoutHandler = handler;
      },
      setShutdownHandler: (handler) => {
        state.shutdownHandler = handler;
      },
    },
  };
}

describe("MultiplexerDaemon", function () {
  let tempDir;
  let discoveryPath;
  let daemonLockPath;
  let now;
  let daemon;

  beforeEach(function () {
    tempDir = createTempDir();
    discoveryPath = path.join(tempDir, "daemon.json");
    daemonLockPath = path.join(tempDir, "daemon.lock");
    now = 1000;
  });

  afterEach(async function () {
    if (daemon) {
      try {
        await daemon.stop();
      } catch (_error) {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createDaemon(host, extra = {}) {
    daemon = new MultiplexerDaemon({
      discoveryPath,
      daemonLockPath,
      protocolVersion: 1,
      minSupportedProtocolVersion: 1,
      debugInfo: {
        daemonVersion: "0.0.1",
      },
      heartbeatInterval: 100000,
      host,
      hostOption: { source: "test" },
      now: () => now,
      ...extra,
    });
    return daemon;
  }

  it("starts host, holds daemon lock, and writes discovery", async function () {
    const { host, state } = createHost();
    createDaemon(host);

    await daemon.start();

    assert.strictEqual(state.started, 1);
    assert.deepStrictEqual(state.startOptions, [{ source: "test" }]);
    assert.strictEqual(fs.existsSync(daemonLockPath), true);
    assert.deepStrictEqual(readJson(discoveryPath), {
      pid: process.pid,
      protocolVersion: 1,
      minSupportedProtocolVersion: 1,
      controlPort: 9100,
      heartbeat: 1000,
      startedAt: 1000,
      debugInfo: {
        protocolVersion: 1,
        daemonVersion: "0.0.1",
        processId: process.pid,
        timestamp: 1000,
      },
    });
    assert.ok(daemon.heartbeatTimer);
  });

  it("is idempotent when started more than once", async function () {
    const { host, state } = createHost();
    createDaemon(host);

    await daemon.start();
    await daemon.start();

    assert.strictEqual(state.started, 1);
  });

  it("refreshes heartbeat while preserving other discovery fields", async function () {
    const { host } = createHost();
    createDaemon(host);

    await daemon.start();
    now = 1500;
    daemon.refreshHeartbeat();

    assert.deepStrictEqual(readJson(discoveryPath), {
      pid: process.pid,
      protocolVersion: 1,
      minSupportedProtocolVersion: 1,
      controlPort: 9100,
      heartbeat: 1500,
      startedAt: 1000,
      debugInfo: {
        protocolVersion: 1,
        daemonVersion: "0.0.1",
        processId: process.pid,
        timestamp: 1500,
      },
    });
  });

  it("omits debug info from discovery when it is not configured", async function () {
    const { host } = createHost();
    createDaemon(host, { debugInfo: undefined });

    await daemon.start();
    assert.deepStrictEqual(readJson(discoveryPath), {
      pid: process.pid,
      protocolVersion: 1,
      minSupportedProtocolVersion: 1,
      controlPort: 9100,
      heartbeat: 1000,
      startedAt: 1000,
    });

    now = 1500;
    daemon.refreshHeartbeat();
    assert.deepStrictEqual(readJson(discoveryPath), {
      pid: process.pid,
      protocolVersion: 1,
      minSupportedProtocolVersion: 1,
      controlPort: 9100,
      heartbeat: 1500,
      startedAt: 1000,
    });
  });

  it("stops timer, host, discovery, and daemon lock", async function () {
    const { host, state } = createHost();
    createDaemon(host);

    await daemon.start();
    await daemon.stop();

    assert.strictEqual(state.stopped, 1);
    assert.strictEqual(daemon.heartbeatTimer, undefined);
    assert.strictEqual(daemon.discoveryInfo, null);
    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
  });

  it("fails without starting host when daemon lock is already held", async function () {
    fs.mkdirSync(daemonLockPath, { recursive: true });
    const { host, state } = createHost();
    createDaemon(host);

    await assert.rejects(() => daemon.start(), /Failed to acquire/);

    assert.strictEqual(state.started, 0);
    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), true);
  });

  it("cleans daemon lock when host start fails", async function () {
    const { host } = createHost({
      start: async () => {
        throw new Error("host start failed");
      },
    });
    createDaemon(host);

    await assert.rejects(() => daemon.start(), /host start failed/);

    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
    assert.strictEqual(daemon.discoveryInfo, null);
  });

  it("cleans local resources and rethrows host stop errors", async function () {
    const { host } = createHost({
      stop: async () => {
        throw new Error("host stop failed");
      },
    });
    createDaemon(host);

    await daemon.start();
    await assert.rejects(() => daemon.stop(), /host stop failed/);

    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
    assert.strictEqual(daemon.discoveryInfo, null);
  });

  it("rejects invalid control ports from host", async function () {
    const { host } = createHost({ controlPort: Number.NaN });
    createDaemon(host);

    await assert.rejects(
      () => daemon.start(),
      /Invalid multiplexer daemon control port/
    );

    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
  });

  it("stops daemon resources and invokes idle callback when host idles", async function () {
    const idleCalls = [];
    const { host, state } = createHost();
    createDaemon(host, {
      onIdleTimeout: (stopError) => {
        idleCalls.push(stopError);
      },
    });

    await daemon.start();
    assert.strictEqual(typeof state.idleTimeoutHandler, "function");

    await state.idleTimeoutHandler();

    assert.strictEqual(state.stopped, 1);
    assert.deepStrictEqual(idleCalls, [undefined]);
    assert.strictEqual(daemon.heartbeatTimer, undefined);
    assert.strictEqual(daemon.discoveryInfo, null);
    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
  });

  it("stops daemon resources and invokes shutdown callback when host requests shutdown", async function () {
    const shutdownCalls = [];
    const { host, state } = createHost();
    createDaemon(host, {
      onShutdownRequest: (stopError) => {
        shutdownCalls.push(stopError);
      },
    });

    await daemon.start();
    assert.strictEqual(typeof state.shutdownHandler, "function");

    await state.shutdownHandler();

    assert.strictEqual(state.stopped, 1);
    assert.deepStrictEqual(shutdownCalls, [undefined]);
    assert.strictEqual(daemon.heartbeatTimer, undefined);
    assert.strictEqual(daemon.discoveryInfo, null);
    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
  });

  it("still invokes idle callback when stop reports an error", async function () {
    const stopError = new Error("host stop failed");
    const idleCalls = [];
    const { host, state } = createHost({
      stop: async () => {
        throw stopError;
      },
    });
    createDaemon(host, {
      onIdleTimeout: (error) => {
        idleCalls.push(error);
      },
    });

    await daemon.start();
    await state.idleTimeoutHandler();

    assert.strictEqual(state.stopped, 1);
    assert.deepStrictEqual(idleCalls, [stopError]);
    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
  });
});
