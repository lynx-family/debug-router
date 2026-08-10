// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  MultiplexerDaemonManager,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/client/MultiplexerDaemonManager");
const {
  FileLock,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/utils/FileLock");

function response(protocolVersion = 1, minSupportedProtocolVersion = 1) {
  return {
    kind: "health-response",
    ok: true,
    protocolVersion,
    minSupportedProtocolVersion,
  };
}

function usable(value = response()) {
  return {
    status: "usable",
    reason: "same-version",
    daemonProtocolVersion: value.protocolVersion,
    connectorProtocolVersion: 1,
  };
}

function unavailable(reason = "unreachable", error) {
  return { status: "unusable", reason, ...(error ? { error } : {}) };
}

function replaceRequired() {
  const value = response(0, 0);
  return {
    status: "replace-required",
    reason: "daemon-older-than-connector",
    daemonProtocolVersion: 0,
    connectorProtocolVersion: 1,
  };
}

function connectorTooOld() {
  const value = response(2, 2);
  return {
    status: "unusable",
    reason: "connector-protocol-too-old",
    daemonProtocolVersion: 2,
    daemonMinSupportedProtocolVersion: 2,
    connectorProtocolVersion: 1,
  };
}

function sequenceDiscovery(endpoint, values) {
  let calls = 0;
  return {
    controlEndpoint: endpoint,
    async probeHealth() {
      const value = values[Math.min(calls, values.length - 1)];
      calls++;
      return typeof value === "function" ? value() : value;
    },
    get calls() {
      return calls;
    },
  };
}

function createManager(tempDir, values, overrides = {}) {
  const controlEndpoint = path.join(tempDir, "control.sock");
  const discovery =
    overrides.discovery ?? sequenceDiscovery(controlEndpoint, values);
  const spawnCalls = [];
  let now = 0;
  const manager = new MultiplexerDaemonManager({
    discovery,
    controlEndpoint,
    spawnLockPath: path.join(tempDir, "spawn.lock"),
    daemonLockPath: path.join(tempDir, "daemon.lock"),
    daemonEntry: "/tmp/entry.js",
    startupTimeout: 100,
    readyPollInterval: 10,
    replacementTimeout: 20,
    localProtocolVersion: 1,
    debugInfo: overrides.debugInfo,
    legacyDriverDir: overrides.legacyDriverDir,
    spawn(command, args, options) {
      const call = { command, args, options, unref: false };
      spawnCalls.push(call);
      return { unref: () => (call.unref = true) };
    },
    kill: overrides.kill ?? (() => {}),
    isProcessAlive: overrides.isProcessAlive ?? (() => false),
    sleep: async (duration) => {
      now += duration;
    },
    now: () => now,
  });
  return { manager, discovery, spawnCalls, controlEndpoint };
}

describe("MultiplexerDaemonManager", function () {
  let tempDir;

  beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-manager-"));
  });

  afterEach(function () {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reuses a healthy daemon without locking or spawning", async function () {
    const { manager, spawnCalls } = createManager(tempDir, [usable()]);
    assert.strictEqual(await manager.ensureDaemon(), undefined);
    assert.deepStrictEqual(spawnCalls, []);
    assert.strictEqual(fs.existsSync(manager.spawnLock.lockPath), false);
  });

  it("retries unreachable health after acquiring spawn.lock for explicit stop", async function () {
    const spawnLockPath = path.join(tempDir, "spawn.lock");
    const discovery = sequenceDiscovery(path.join(tempDir, "control.sock"), [
      () => {
        assert.strictEqual(fs.existsSync(spawnLockPath), true);
        return unavailable();
      },
    ]);
    const { manager } = createManager(tempDir, [], { discovery });

    await manager.stopDaemonOnConnectorRequest();
    assert.strictEqual(discovery.calls, 4);
    assert.strictEqual(fs.existsSync(spawnLockPath), false);
  });

  it("spawns with endpoint args after health retries without probing again under spawn.lock", async function () {
    const {
      manager,
      discovery,
      spawnCalls,
      controlEndpoint,
    } = createManager(tempDir, [
      unavailable(),
      unavailable("timeout"),
      unavailable(),
      unavailable("timeout"),
      usable(),
    ]);
    assert.strictEqual(await manager.ensureDaemon(), undefined);
    assert.strictEqual(discovery.calls, 5);
    assert.strictEqual(spawnCalls.length, 1);
    assert.deepStrictEqual(spawnCalls[0].args.slice(0, 7), [
      "/tmp/entry.js",
      "--control-endpoint",
      controlEndpoint,
      "--daemon-lock-path",
      manager.daemonLock.lockPath,
      "--protocol-version",
      "1",
    ]);
    assert.strictEqual(spawnCalls[0].args.includes("--discovery-path"), false);
    assert.strictEqual(spawnCalls[0].args.includes("--control-port"), false);
    assert.strictEqual(
      spawnCalls[0].args.includes("--heartbeat-interval"),
      false
    );
    assert.strictEqual(spawnCalls[0].unref, true);
  });

  it("reuses a daemon that becomes usable during health retries", async function () {
    const { manager, discovery, spawnCalls } = createManager(tempDir, [
      unavailable(),
      usable(),
    ]);

    assert.strictEqual(await manager.ensureDaemon(), undefined);
    assert.strictEqual(discovery.calls, 2);
    assert.deepStrictEqual(spawnCalls, []);
  });

  it("waits for the lock owner daemon instead of spawning concurrently", async function () {
    const { manager, discovery, spawnCalls } = createManager(tempDir, [
      unavailable(),
      unavailable(),
      unavailable(),
      unavailable(),
      usable(),
    ]);
    const owner = new FileLock(manager.spawnLock.lockPath);
    assert.strictEqual(owner.acquire(), true);
    try {
      assert.strictEqual(await manager.ensureDaemon(), undefined);
      assert.strictEqual(discovery.calls, 5);
      assert.deepStrictEqual(spawnCalls, []);
    } finally {
      owner.release();
    }
  });

  it("stops health retries when a version incompatibility is discovered", async function () {
    const { manager, discovery, spawnCalls } = createManager(tempDir, [
      unavailable(),
      connectorTooOld(),
      usable(),
    ]);

    await assert.rejects(() => manager.ensureDaemon(), /Please upgrade/);
    assert.strictEqual(discovery.calls, 2);
    assert.deepStrictEqual(spawnCalls, []);
  });

  it("waitUntilReady performs one probe per polling interval", async function () {
    const lastError = new Error("last health probe failed");
    const { manager, discovery } = createManager(tempDir, [
      unavailable(),
      unavailable("timeout"),
      unavailable("invalid-frame", lastError),
    ]);

    await assert.rejects(
      () => manager.waitUntilReady(20),
      /Timed out waiting for multiplexer daemon: unusable\/invalid-frame, health-check:last health probe failed/
    );
    assert.strictEqual(discovery.calls, 3);
  });

  it("waitUntilReady exits early for terminal protocol results", async function () {
    const replaceContext = createManager(tempDir, [replaceRequired()]);
    await assert.rejects(
      () => replaceContext.manager.waitUntilReady(100),
      /daemon protocol 0 is older/
    );
    assert.strictEqual(replaceContext.discovery.calls, 1);

    const incompatibleContext = createManager(tempDir, [connectorTooOld()]);
    await assert.rejects(
      () => incompatibleContext.manager.waitUntilReady(100),
      /Please upgrade/
    );
    assert.strictEqual(incompatibleContext.discovery.calls, 1);
  });

  it("retries ensureDaemon after timing out behind another spawn lock owner", async function () {
    const calls = [];
    const { manager, discovery, spawnCalls } = createManager(tempDir, [
      unavailable(),
      replaceRequired(),
      replaceRequired(),
      usable(),
    ]);
    const owner = new FileLock(manager.spawnLock.lockPath);
    assert.strictEqual(owner.acquire(), true);
    manager.setDaemonClient({
      async callOnDaemon(method, params) {
        calls.push([method, params]);
        return {};
      },
    });

    const waitUntilReady = manager.waitUntilReady.bind(manager);
    let waitCalls = 0;
    manager.waitUntilReady = async (timeout) => {
      waitCalls++;
      if (waitCalls === 1) {
        owner.release();
        throw new Error("Timed out waiting for multiplexer daemon");
      }
      return waitUntilReady(timeout);
    };

    await manager.ensureDaemon();

    assert.strictEqual(waitCalls, 2);
    assert.strictEqual(discovery.calls, 4);
    assert.strictEqual(spawnCalls.length, 1);
    assert.deepStrictEqual(calls, [
      ["shutdownDaemon", { reason: "daemon-protocol-older-than-connector" }],
    ]);
  });

  it("propagates readiness failures after spawning its own daemon", async function () {
    const { manager, spawnCalls } = createManager(tempDir, [
      unavailable(),
      unavailable(),
    ]);
    manager.waitUntilReady = async () => {
      throw new Error("own daemon failed to become ready");
    };

    await assert.rejects(
      () => manager.ensureDaemon(),
      /own daemon failed to become ready/
    );

    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(fs.existsSync(manager.spawnLock.lockPath), false);
  });

  it("rejects a connector below the daemon minimum without cleanup", async function () {
    const { manager, spawnCalls } = createManager(tempDir, [connectorTooOld()]);
    await assert.rejects(() => manager.ensureDaemon(), /Please upgrade/);
    assert.deepStrictEqual(spawnCalls, []);
  });

  it("uses daemon.lock PID for crash cleanup and removes a stale socket", async function () {
    const alive = new Set([process.pid]);
    const kills = [];
    const { manager, controlEndpoint } = createManager(
      tempDir,
      [
        unavailable(),
        unavailable("timeout"),
        unavailable(),
        unavailable("timeout"),
        usable(),
      ],
      {
        isProcessAlive: (pid) => alive.has(pid),
        kill(pid, signal) {
          kills.push([pid, signal]);
          alive.delete(pid);
        },
      }
    );
    const daemonOwner = new FileLock(manager.daemonLock.lockPath);
    assert.strictEqual(daemonOwner.acquire(), true);
    fs.writeFileSync(controlEndpoint, "stale");

    await manager.ensureDaemon();
    assert.deepStrictEqual(kills, [[process.pid, "SIGTERM"]]);
    assert.strictEqual(fs.existsSync(controlEndpoint), false);
    assert.strictEqual(fs.existsSync(path.join(tempDir, "daemon.json")), false);
  });

  it("requests graceful shutdown for protocol replacement", async function () {
    const calls = [];
    const { manager } = createManager(tempDir, [replaceRequired(), usable()]);
    manager.setDaemonClient({
      async callOnDaemon(method, params) {
        calls.push([method, params]);
        return {};
      },
    });
    await manager.ensureDaemon();
    assert.deepStrictEqual(calls, [
      ["shutdownDaemon", { reason: "daemon-protocol-older-than-connector" }],
    ]);
  });
});
