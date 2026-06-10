// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("../register_ts");

const {
  MultiplexerDaemonManager,
} = require("../../../../debug_router_connector/src/multiplexer/client/MultiplexerDaemonManager");
const {
  MultiplexerDiscovery,
} = require("../../../../debug_router_connector/src/multiplexer/client/MultiplexerDiscovery");
const {
  FileLock,
} = require("../../../../debug_router_connector/src/multiplexer/utils/FileLock");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-mux-manager-"));
}

function createInfo(overrides = {}) {
  return {
    pid: 200,
    protocolVersion: 1,
    controlPort: 9000,
    heartbeat: 1000,
    startedAt: 900,
    ...overrides,
  };
}

function usable(info = createInfo()) {
  return {
    status: "usable",
    info,
    compatibility: {
      status: "compatible",
      reason: "same-version",
      daemonProtocolVersion: info.protocolVersion,
      connectorProtocolVersion: 1,
    },
  };
}

function replaceRequired(info = createInfo({ protocolVersion: 0 })) {
  return {
    status: "replace-required",
    info,
    compatibility: {
      status: "replace-required",
      reason: "daemon-older-than-connector",
      daemonProtocolVersion: info.protocolVersion,
      connectorProtocolVersion: 1,
    },
  };
}

function unusable(reason = "missing") {
  return {
    status: "unusable",
    reason,
  };
}

function createSequenceDiscovery(discoveryPath, sequence) {
  let index = 0;
  return {
    discoveryPath,
    staleTimeout: 1000,
    validateDiscovery() {
      const value = sequence[Math.min(index, sequence.length - 1)];
      index++;
      return typeof value === "function" ? value() : value;
    },
    calls() {
      return index;
    },
  };
}

function createSpawnRecorder() {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      const call = {
        command,
        args,
        options,
        unrefCalled: false,
      };
      calls.push(call);
      return {
        pid: 300,
        unref() {
          call.unrefCalled = true;
        },
      };
    },
  };
}

function createManager(tempDir, overrides = {}) {
  const discoveryPath = path.join(tempDir, "daemon.json");
  const spawnLockPath = path.join(tempDir, "spawn.lock");
  const daemonLockPath = path.join(tempDir, "daemon.lock");
  const spawnRecorder = overrides.spawnRecorder ?? createSpawnRecorder();
  const sleepCalls = [];
  const manager = new (overrides.ManagerClass ?? MultiplexerDaemonManager)({
    discovery:
      overrides.discovery ??
      createSequenceDiscovery(discoveryPath, [unusable("missing")]),
    spawnLockPath,
    daemonLockPath,
    daemonEntry: "/tmp/multiplexer-entry.js",
    startupTimeout: overrides.startupTimeout ?? 1000,
    staleTimeout: overrides.staleTimeout ?? 1000,
    localProtocolVersion: 1,
    controlPort: overrides.controlPort ?? 9111,
    heartbeatInterval: overrides.heartbeatInterval,
    daemonVersion: overrides.daemonVersion,
    capabilities: overrides.capabilities,
    readyPollInterval: overrides.readyPollInterval ?? 10,
    replacementTimeout: overrides.replacementTimeout ?? 20,
    spawn: spawnRecorder.spawn,
    kill: overrides.kill ?? (() => {}),
    sleep:
      overrides.sleep ??
      (async (duration) => {
        sleepCalls.push(duration);
      }),
    now: overrides.now,
  });

  return {
    manager,
    discoveryPath,
    spawnLockPath,
    daemonLockPath,
    spawnRecorder,
    sleepCalls,
  };
}

describe("MultiplexerDaemonManager", function () {
  let tempDir;

  beforeEach(function () {
    tempDir = createTempDir();
  });

  afterEach(function () {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reuses a usable daemon without acquiring spawn or spawning", async function () {
    const info = createInfo();
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(info)]
    );
    const { manager, spawnRecorder, spawnLockPath } = createManager(tempDir, {
      discovery,
    });

    assert.deepStrictEqual(await manager.ensureDaemon(), info);
    assert.deepStrictEqual(spawnRecorder.calls, []);
    assert.strictEqual(fs.existsSync(spawnLockPath), false);
  });

  it("spawns a daemon and waits until discovery becomes usable", async function () {
    const readyInfo = createInfo({ pid: 201 });
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [unusable("missing"), unusable("missing"), unusable("missing"), usable(readyInfo)]
    );
    const { manager, spawnRecorder, spawnLockPath, daemonLockPath } =
      createManager(tempDir, {
        discovery,
        heartbeatInterval: 250,
        daemonVersion: "0.0.1",
        capabilities: ["daemon", "manager"],
      });

    assert.deepStrictEqual(await manager.ensureDaemon(), readyInfo);
    assert.strictEqual(spawnRecorder.calls.length, 1);
    assert.strictEqual(spawnRecorder.calls[0].command, process.execPath);
    assert.deepStrictEqual(spawnRecorder.calls[0].args, [
      "/tmp/multiplexer-entry.js",
      "--discovery-path",
      discovery.discoveryPath,
      "--daemon-lock-path",
      daemonLockPath,
      "--protocol-version",
      "1",
      "--control-port",
      "9111",
      "--heartbeat-interval",
      "250",
      "--daemon-version",
      "0.0.1",
      "--capabilities",
      "daemon,manager",
    ]);
    assert.deepStrictEqual(spawnRecorder.calls[0].options, {
      detached: true,
      stdio: "ignore",
    });
    assert.strictEqual(spawnRecorder.calls[0].unrefCalled, true);
    assert.strictEqual(fs.existsSync(spawnLockPath), false);
  });

  it("waits for an in-flight spawn when spawn lock is held elsewhere", async function () {
    const readyInfo = createInfo({ pid: 202 });
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [unusable("missing"), unusable("missing"), usable(readyInfo)]
    );
    const { manager, spawnRecorder, spawnLockPath } = createManager(tempDir, {
      discovery,
    });
    const externalLock = new FileLock(spawnLockPath);

    assert.strictEqual(externalLock.acquire(), true);
    try {
      assert.deepStrictEqual(await manager.ensureDaemon(), readyInfo);
      assert.deepStrictEqual(spawnRecorder.calls, []);
    } finally {
      externalLock.release();
    }
  });

  it("replaces an older daemon by forcing stop when yield is unavailable", async function () {
    const oldInfo = createInfo({ pid: 300, protocolVersion: 0 });
    const readyInfo = createInfo({ pid: 301 });
    const killCalls = [];
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [replaceRequired(oldInfo), replaceRequired(oldInfo), usable(readyInfo)]
    );
    const { manager, spawnRecorder } = createManager(tempDir, {
      discovery,
      kill: (pid, signal) => killCalls.push([pid, signal]),
    });

    assert.deepStrictEqual(await manager.ensureDaemon(), readyInfo);
    assert.deepStrictEqual(killCalls, [
      [300, "SIGTERM"],
      [300, "SIGKILL"],
    ]);
    assert.strictEqual(spawnRecorder.calls.length, 1);
  });

  it("does not force kill when requestDaemonYield succeeds", async function () {
    class YieldingManager extends MultiplexerDaemonManager {
      async requestDaemonYield() {
        return true;
      }
    }

    const oldInfo = createInfo({ pid: 310, protocolVersion: 0 });
    const readyInfo = createInfo({ pid: 311 });
    const killCalls = [];
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [replaceRequired(oldInfo), replaceRequired(oldInfo), usable(readyInfo)]
    );
    const { manager, spawnRecorder } = createManager(tempDir, {
      ManagerClass: YieldingManager,
      discovery,
      kill: (pid, signal) => killCalls.push([pid, signal]),
    });

    assert.deepStrictEqual(await manager.ensureDaemon(), readyInfo);
    assert.deepStrictEqual(killCalls, []);
    assert.strictEqual(spawnRecorder.calls.length, 1);
  });

  it("times out while waiting for discovery to become usable", async function () {
    let now = 0;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [unusable("missing")]
    );
    const { manager } = createManager(tempDir, {
      discovery,
      startupTimeout: 25,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
    });

    await assert.rejects(
      () => manager.waitUntilReady(25),
      /Timed out waiting for multiplexer daemon: unusable\/missing/
    );
  });

  it("does not cleanup stale discovery when daemon lock is still fresh", function () {
    let now = 1000;
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    fs.writeFileSync(
      discoveryPath,
      JSON.stringify(createInfo({ heartbeat: 0 }))
    );
    fs.mkdirSync(daemonLockPath);
    fs.writeFileSync(
      path.join(daemonLockPath, "owner.json"),
      JSON.stringify({ pid: 1, createdAt: now })
    );

    const discovery = new MultiplexerDiscovery({
      discoveryPath,
      staleTimeout: 500,
      localProtocolVersion: 1,
      now: () => now,
    });
    const { manager } = createManager(tempDir, {
      discovery,
      daemonLockPath,
      staleTimeout: 500,
      now: () => now,
    });

    assert.strictEqual(manager.cleanupStaleDaemon(), false);
    assert.strictEqual(fs.existsSync(discoveryPath), true);
    assert.strictEqual(fs.existsSync(daemonLockPath), true);
  });

  it("cleans stale daemon lock and stale discovery", function () {
    const now = 5000;
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    fs.writeFileSync(
      discoveryPath,
      JSON.stringify(createInfo({ heartbeat: 0 }))
    );
    fs.mkdirSync(daemonLockPath);
    fs.writeFileSync(
      path.join(daemonLockPath, "owner.json"),
      JSON.stringify({ pid: 1, createdAt: 0 })
    );

    const discovery = new MultiplexerDiscovery({
      discoveryPath,
      staleTimeout: 500,
      localProtocolVersion: 1,
      now: () => now,
    });
    const { manager } = createManager(tempDir, {
      discovery,
      daemonLockPath,
      staleTimeout: 500,
      now: () => now,
    });

    assert.strictEqual(manager.cleanupStaleDaemon(), true);
    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
  });

  it("removes invalid discovery when no daemon lock exists", function () {
    const discoveryPath = path.join(tempDir, "daemon.json");
    fs.writeFileSync(discoveryPath, "{bad");
    const discovery = new MultiplexerDiscovery({
      discoveryPath,
      staleTimeout: 500,
      localProtocolVersion: 1,
    });
    const { manager } = createManager(tempDir, { discovery });

    assert.strictEqual(manager.cleanupStaleDaemon(), true);
    assert.strictEqual(fs.existsSync(discoveryPath), false);
  });

  it("ignores ESRCH when force stopping an already exited daemon", async function () {
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    fs.writeFileSync(discoveryPath, "{}");
    fs.mkdirSync(daemonLockPath);
    const { manager } = createManager(tempDir, {
      discovery: createSequenceDiscovery(discoveryPath, [unusable("missing")]),
      daemonLockPath,
      kill: () => {
        const error = new Error("missing process");
        error.code = "ESRCH";
        throw error;
      },
    });

    await manager.forceStopDaemon(createInfo({ pid: 404 }));

    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
  });

  it("rethrows unexpected kill errors while force stopping", async function () {
    const { manager } = createManager(tempDir, {
      kill: () => {
        const error = new Error("permission denied");
        error.code = "EPERM";
        throw error;
      },
    });

    await assert.rejects(
      () => manager.forceStopDaemon(createInfo({ pid: 405 })),
      /permission denied/
    );
  });
});
