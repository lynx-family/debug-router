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
const {
  defaultLogger,
} = require("../../../../debug_router_connector/dist/cjs/src/utils/logger");

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
  return {
    status: "replace-required",
    reason: "daemon-older-than-connector",
    daemonProtocolVersion: 0,
    connectorProtocolVersion: 1,
  };
}

function connectorTooOld() {
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

function getArgumentValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function createManager(tempDir, values, overrides = {}) {
  const controlEndpoint = path.join(tempDir, "control.sock");
  const discovery =
    overrides.discovery ?? sequenceDiscovery(controlEndpoint, values);
  const spawnCalls = [];
  let now = 0;
  const manager = new MultiplexerDaemonManager({
    discovery,
    daemonProcessName: overrides.daemonProcessName ?? "test-muxDaemon",
    controlEndpoint,
    spawnLockPath: path.join(tempDir, "spawn.lock"),
    daemonEntry: "/tmp/entry.js",
    startupTimeout: 100,
    readyPollInterval: 10,
    replacementTimeout: 20,
    localProtocolVersion: 1,
    minSupportedProtocolVersion: 1,
    debugInfo: overrides.debugInfo,
    legacyDriverDir: overrides.legacyDriverDir,
    spawn(command, args, options) {
      const call = { command, args, options, unref: false };
      spawnCalls.push(call);
      overrides.onSpawn?.(call);
      return { unref: () => (call.unref = true) };
    },
    processFinder: overrides.processFinder ?? (async () => []),
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

  it("releases spawn.lock when explicitly stopping an unreachable daemon", async function () {
    const spawnLockPath = path.join(tempDir, "spawn.lock");
    const discovery = sequenceDiscovery(path.join(tempDir, "control.sock"), [
      () => {
        assert.strictEqual(fs.existsSync(spawnLockPath), true);
        return unavailable();
      },
    ]);
    const { manager, spawnCalls } = createManager(tempDir, [], { discovery });

    await manager.stopDaemonOnConnectorRequest();
    assert.deepStrictEqual(spawnCalls, []);
    assert.strictEqual(fs.existsSync(spawnLockPath), false);
  });

  it("spawns once with the required endpoint and protocol args", async function () {
    let spawned = false;
    const controlEndpoint = path.join(tempDir, "control.sock");
    const discovery = {
      controlEndpoint,
      async probeHealth() {
        return spawned ? usable() : unavailable();
      },
    };
    const { manager, spawnCalls } = createManager(tempDir, [], {
      discovery,
      onSpawn: () => {
        spawned = true;
      },
    });
    assert.strictEqual(await manager.ensureDaemon(), undefined);
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].args[0], "/tmp/entry.js");
    assert.strictEqual(
      getArgumentValue(spawnCalls[0].args, "--control-endpoint"),
      controlEndpoint
    );
    assert.strictEqual(
      getArgumentValue(spawnCalls[0].args, "--protocol-version"),
      "1"
    );
    assert.strictEqual(
      getArgumentValue(spawnCalls[0].args, "--min-supported-protocol-version"),
      "1"
    );
    assert.strictEqual(spawnCalls[0].options.argv0, manager.daemonProcessName);
    assert.strictEqual(spawnCalls[0].unref, true);
  });

  it("reuses a daemon that becomes usable during health retries", async function () {
    const { manager, discovery, spawnCalls } = createManager(tempDir, [
      unavailable(),
      usable(),
    ]);

    assert.strictEqual(await manager.ensureDaemon(), undefined);
    assert.deepStrictEqual(spawnCalls, []);
  });

  it("waits for the lock owner daemon instead of spawning concurrently", async function () {
    const { manager, spawnCalls } = createManager(tempDir, [
      replaceRequired(),
      usable(),
    ]);
    const owner = new FileLock(manager.spawnLock.lockPath);
    assert.strictEqual(owner.acquire(), true);
    try {
      assert.strictEqual(await manager.ensureDaemon(), undefined);
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

    await assert.rejects(() => manager.ensureDaemon());
    assert.deepStrictEqual(spawnCalls, []);
  });

  it("rejects when the daemon does not become ready before timeout", async function () {
    const lastError = new Error("last health probe failed");
    const { manager, discovery } = createManager(tempDir, [
      unavailable(),
      unavailable("timeout"),
      unavailable("invalid-frame", lastError),
    ]);

    await assert.rejects(() => manager.waitUntilReady(20));
  });

  it("waitUntilReady exits early for terminal protocol results", async function () {
    const shouldNotProbeAgain = () => {
      throw new Error("terminal protocol result must stop readiness polling");
    };
    const replaceContext = createManager(tempDir, [
      replaceRequired(),
      shouldNotProbeAgain,
    ]);
    await assert.rejects(() => replaceContext.manager.waitUntilReady(100));

    const incompatibleContext = createManager(tempDir, [
      connectorTooOld(),
      shouldNotProbeAgain,
    ]);
    await assert.rejects(() => incompatibleContext.manager.waitUntilReady(100));
  });

  it("propagates readiness failures after spawning its own daemon", async function () {
    let spawned = false;
    const discovery = {
      controlEndpoint: path.join(tempDir, "control.sock"),
      async probeHealth() {
        return spawned ? connectorTooOld() : unavailable();
      },
    };
    const { manager, spawnCalls } = createManager(tempDir, [], {
      discovery,
      onSpawn: () => {
        spawned = true;
      },
    });

    await assert.rejects(() => manager.ensureDaemon());

    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(fs.existsSync(manager.spawnLock.lockPath), false);
  });

  it("rejects a connector below the daemon minimum without cleanup", async function () {
    const { manager, spawnCalls } = createManager(tempDir, [connectorTooOld()]);
    await assert.rejects(() => manager.ensureDaemon());
    assert.deepStrictEqual(spawnCalls, []);
  });

  it("[v1 compatibility gate] finds the named daemon for crash cleanup", async function () {
    const daemonPid = 4242;
    const alive = new Set([daemonPid]);
    const kills = [];
    const findCalls = [];
    let spawned = false;
    const discovery = {
      controlEndpoint: path.join(tempDir, "control.sock"),
      async probeHealth() {
        return spawned ? usable() : unavailable();
      },
    };
    const { manager, controlEndpoint } = createManager(tempDir, [], {
      discovery,
      onSpawn: () => {
        spawned = true;
      },
      async processFinder(by, value, option) {
        findCalls.push([by, value, option]);
        return alive.has(daemonPid)
          ? [
              {
                pid: daemonPid,
                ppid: 1,
                name: "node",
                cmd: manager.daemonProcessName,
              },
            ]
          : [];
      },
      isProcessAlive: (pid) => alive.has(pid),
      kill(pid, signal) {
        kills.push([pid, signal]);
        alive.delete(pid);
      },
    });
    fs.writeFileSync(controlEndpoint, "stale");

    await manager.ensureDaemon();
    assert.ok(
      findCalls.some(
        ([by, value, option]) =>
          by === "name" &&
          value === manager.daemonProcessName &&
          option.strict === false &&
          option.skipSelf === true
      )
    );
    assert.deepStrictEqual(kills, [[daemonPid, "SIGTERM"]]);
    assert.strictEqual(fs.existsSync(controlEndpoint), false);
  });

  it("reports multiple daemon pids and stops only the first", async function () {
    const daemonPids = [4242, 4343];
    const alive = new Set(daemonPids);
    const kills = [];
    const errors = [];
    let spawned = false;
    const originalError = defaultLogger.error;
    defaultLogger.error = (message) => errors.push(message);
    try {
      const { manager } = createManager(tempDir, [], {
        discovery: {
          controlEndpoint: path.join(tempDir, "control.sock"),
          async probeHealth() {
            return spawned ? usable() : unavailable();
          },
        },
        onSpawn: () => {
          spawned = true;
        },
        async processFinder() {
          return daemonPids.map((pid) => ({
            pid,
            ppid: 1,
            name: "node",
            cmd: "test-muxDaemon",
          }));
        },
        isProcessAlive: (pid) => alive.has(pid),
        kill(pid, signal) {
          kills.push([pid, signal]);
          alive.delete(pid);
        },
      });

      await manager.ensureDaemon();

      assert.deepStrictEqual(kills, [[daemonPids[0], "SIGTERM"]]);
      assert.strictEqual(alive.has(daemonPids[1]), true);
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0].includes(manager.daemonProcessName));
      for (const pid of daemonPids) {
        assert.ok(errors[0].includes(String(pid)));
      }
    } finally {
      defaultLogger.error = originalError;
    }
  });

  it("[v1 compatibility gate] requests graceful shutdown for protocol replacement", async function () {
    const calls = [];
    const { manager } = createManager(tempDir, [replaceRequired(), usable()], {
      async processFinder() {
        return [
          {
            pid: 4242,
            ppid: 1,
            name: "node",
            cmd: "test-muxDaemon",
          },
        ];
      },
    });
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

  it("reports and returns when graceful shutdown cannot find a daemon pid", async function () {
    const errors = [];
    const controlEndpoint = path.join(tempDir, "control.sock");
    const { manager } = createManager(tempDir, [usable()]);
    const calls = [];
    manager.setDaemonClient({
      async callOnDaemon(method, params) {
        calls.push([method, params]);
        return {};
      },
    });
    fs.writeFileSync(controlEndpoint, "stale");
    const originalError = defaultLogger.error;
    defaultLogger.error = (message) => errors.push(message);
    try {
      await manager.tryGracefullyStopDaemon("force-stop");
    } finally {
      defaultLogger.error = originalError;
    }

    assert.deepStrictEqual(calls, [
      ["shutdownDaemon", { reason: "force-stop" }],
    ]);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes(manager.daemonProcessName));
    assert.strictEqual(fs.existsSync(controlEndpoint), true);
  });
});
