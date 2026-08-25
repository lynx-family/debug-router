// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { spawn: spawnChildProcess } = require("child_process");
const { once } = require("events");
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

function response(protocolVersion = 1) {
  return {
    kind: "health-response",
    ok: true,
    protocolVersion,
    isInUse: false,
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

function olderDaemonInUse() {
  return {
    status: "unusable",
    reason: "daemon-upgrade-blocked-by-active-connections",
    daemonProtocolVersion: 0,
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

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForChildExit(child, timeout = 2000) {
  if (!child.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  let timer;
  try {
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for child ${child.pid}`)),
          timeout
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createManager(tempDir, values, overrides = {}) {
  const controlEndpoint = path.join(tempDir, "control.sock");
  const discovery =
    overrides.discovery ?? sequenceDiscovery(controlEndpoint, values);
  const spawnCalls = [];
  const sleepCalls = [];
  let now = 0;
  const manager = new MultiplexerDaemonManager({
    discovery,
    daemonProcessName:
      overrides.daemonProcessName ?? `${path.basename(tempDir)}-muxDaemon`,
    controlEndpoint,
    spawnLockPath: path.join(tempDir, "spawn.lock"),
    daemonEntry: "/tmp/entry.js",
    multiplexerDaemonIdleTimeout: overrides.multiplexerDaemonIdleTimeout ?? -1,
    startupTimeout: overrides.startupTimeout ?? 100,
    readyPollInterval: overrides.readyPollInterval ?? 10,
    replacementTimeout: overrides.replacementTimeout ?? 20,
    localProtocolVersion: 1,
    debugInfo: overrides.debugInfo,
    legacyDriverDir: overrides.legacyDriverDir,
    enableWebSocket: overrides.enableWebSocket,
    connectionTrace: overrides.connectionTrace,
    websocketOption: overrides.websocketOption,
    physicalConnectorOption: overrides.physicalConnectorOption,
    spawn(command, args, options) {
      const call = { command, args, options, unref: false };
      spawnCalls.push(call);
      overrides.onSpawn?.(call);
      return { unref: () => (call.unref = true) };
    },
    kill: overrides.kill ?? (() => {}),
    isProcessAlive: overrides.isProcessAlive ?? (() => false),
    sleep:
      overrides.sleep ??
      (async (duration) => {
        sleepCalls.push(duration);
        now += duration;
      }),
    now: overrides.now ?? (() => now),
  });
  return { manager, discovery, spawnCalls, sleepCalls, controlEndpoint };
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

    await manager.stopDaemonForDebugging();
    assert.deepStrictEqual(spawnCalls, []);
    assert.strictEqual(fs.existsSync(spawnLockPath), false);
  });

  it("[v1 compatibility gate] spawns once with the required daemon contract", async function () {
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
      getArgumentValue(spawnCalls[0].args, "--multiplexer-daemon-idle-timeout"),
      "-1"
    );
    assert.strictEqual(spawnCalls[0].options.argv0, manager.daemonProcessName);
    assert.strictEqual(spawnCalls[0].options.detached, true);
    assert.strictEqual(spawnCalls[0].options.stdio, "ignore");
    assert.strictEqual(spawnCalls[0].options.windowsHide, true);
    assert.strictEqual(spawnCalls[0].unref, true);
  });

  it("[v1 compatibility gate] forwards optional daemon startup arguments", async function () {
    const debugInfo = { clientVersion: "1.2.3" };
    const connectionTrace = {
      enabled: true,
      output: "/tmp/multiplexer-trace.jsonl",
      bufferSize: 32,
    };
    const physicalConnectorOption = {
      manualConnect: true,
      enableAndroid: false,
    };
    const { manager, spawnCalls } = createManager(tempDir, [usable()], {
      debugInfo,
      legacyDriverDir: "/tmp/legacy-driver",
      multiplexerDaemonIdleTimeout: 4321,
      enableWebSocket: false,
      websocketOption: { port: 0, roomId: "" },
      connectionTrace,
      physicalConnectorOption,
    });

    await manager.spawnDaemon();

    assert.strictEqual(spawnCalls.length, 1);
    const args = spawnCalls[0].args;
    assert.deepStrictEqual(
      JSON.parse(getArgumentValue(args, "--debug-info")),
      debugInfo
    );
    assert.strictEqual(
      getArgumentValue(args, "--legacy-driver-dir"),
      "/tmp/legacy-driver"
    );
    assert.strictEqual(
      getArgumentValue(args, "--multiplexer-daemon-idle-timeout"),
      "4321"
    );
    assert.strictEqual(getArgumentValue(args, "--enable-websocket"), "false");
    assert.strictEqual(getArgumentValue(args, "--websocket-port"), "0");
    assert.strictEqual(getArgumentValue(args, "--websocket-room-id"), "");
    assert.deepStrictEqual(
      JSON.parse(getArgumentValue(args, "--connection-trace")),
      connectionTrace
    );
    assert.deepStrictEqual(
      JSON.parse(getArgumentValue(args, "--physical-connector-option")),
      physicalConnectorOption
    );
  });

  it("reuses a daemon that becomes usable during health retries", async function () {
    const { manager, discovery, spawnCalls } = createManager(tempDir, [
      unavailable(),
      usable(),
    ]);

    assert.strictEqual(await manager.ensureDaemon(), undefined);
    assert.deepStrictEqual(spawnCalls, []);
  });

  it("[v1 compatibility gate] retries every transient health failure", async function () {
    for (const reason of [
      "unreachable",
      "timeout",
      "invalid-frame",
      "invalid-response",
    ]) {
      const caseDir = path.join(tempDir, reason);
      fs.mkdirSync(caseDir);
      const {
        manager,
        discovery,
        spawnCalls,
        sleepCalls,
      } = createManager(caseDir, [unavailable(reason), usable()]);

      await manager.ensureDaemon();

      assert.strictEqual(discovery.calls, 2, reason);
      assert.deepStrictEqual(sleepCalls, [10], reason);
      assert.deepStrictEqual(spawnCalls, [], reason);
    }
  });

  it("[v1 compatibility gate] performs only three delayed health retries", async function () {
    const {
      manager,
      discovery,
      spawnCalls,
      sleepCalls,
    } = createManager(tempDir, [
      unavailable(),
      unavailable("timeout"),
      unavailable("invalid-frame"),
      unavailable("invalid-response"),
      usable(),
    ]);
    const owner = new FileLock(manager.spawnLock.lockPath);
    assert.strictEqual(owner.acquire(), true);
    try {
      await manager.ensureDaemon();
    } finally {
      owner.release();
    }

    assert.strictEqual(discovery.calls, 5);
    assert.deepStrictEqual(sleepCalls, [10, 10, 10]);
    assert.deepStrictEqual(spawnCalls, []);
  });

  it("retries discovery without waiting when another manager owns spawn.lock", async function () {
    const { manager, discovery, spawnCalls } = createManager(tempDir, [
      replaceRequired(),
      usable(),
    ]);
    manager.waitUntilReady = async () => {
      throw new Error("waitUntilReady must not run without spawn.lock");
    };
    const owner = new FileLock(manager.spawnLock.lockPath);
    assert.strictEqual(owner.acquire(), true);
    try {
      assert.strictEqual(await manager.ensureDaemon(), undefined);
      assert.strictEqual(discovery.calls, 2);
      assert.deepStrictEqual(spawnCalls, []);
    } finally {
      owner.release();
    }
  });

  it("reports the last validation and health error on readiness timeout", async function () {
    const lastError = new Error("last health probe failed");
    const { manager, discovery } = createManager(tempDir, [
      unavailable(),
      unavailable("timeout"),
      unavailable("invalid-frame", lastError),
    ]);

    await assert.rejects(
      () => manager.waitUntilReady(20),
      (error) => {
        assert.match(error.message, /Timed out waiting for multiplexer daemon/);
        assert.match(error.message, /unusable\/invalid-frame/);
        assert.match(error.message, /last health probe failed/);
        return true;
      }
    );
    assert.strictEqual(discovery.calls, 3);
  });

  it("waitUntilReady exits early when daemon replacement is required", async function () {
    const shouldNotProbeAgain = () => {
      throw new Error("terminal protocol result must stop readiness polling");
    };
    const replaceContext = createManager(tempDir, [
      replaceRequired(),
      shouldNotProbeAgain,
    ]);
    await assert.rejects(() => replaceContext.manager.waitUntilReady(100));
  });

  it("rejects an older daemon that is still in use without replacing it", async function () {
    const { manager, discovery, spawnCalls } = createManager(tempDir, [
      olderDaemonInUse(),
      usable(),
    ]);

    await assert.rejects(
      () => manager.ensureDaemon(),
      /daemon is still in use by a connector or WebSocket frontend/
    );
    assert.strictEqual(discovery.calls, 1);
    assert.deepStrictEqual(spawnCalls, []);
    assert.strictEqual(fs.existsSync(manager.spawnLock.lockPath), false);
  });

  it("waitUntilReady exits early when an older daemon is in use", async function () {
    const shouldNotProbeAgain = () => {
      throw new Error("terminal protocol result must stop readiness polling");
    };
    const { manager } = createManager(tempDir, [
      olderDaemonInUse(),
      shouldNotProbeAgain,
    ]);

    await assert.rejects(
      () => manager.waitUntilReady(100),
      /daemon is still in use by a connector or WebSocket frontend/
    );
  });

  it("propagates readiness failures after spawning its own daemon", async function () {
    let spawned = false;
    const discovery = {
      controlEndpoint: path.join(tempDir, "control.sock"),
      async probeHealth() {
        return spawned ? replaceRequired() : unavailable();
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

  it("releases spawn.lock when spawning throws", async function () {
    const spawnError = new Error("spawn failed");
    const { manager, spawnCalls } = createManager(tempDir, [], {
      onSpawn() {
        throw spawnError;
      },
    });

    await assert.rejects(
      () => manager.handleDiscoveryResult(unavailable()),
      (error) => error === spawnError
    );

    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(fs.existsSync(manager.spawnLock.lockPath), false);
  });

  it("[v1 compatibility gate] requests graceful shutdown for protocol replacement", async function () {
    const calls = [];
    const { manager, discovery, spawnCalls } = createManager(tempDir, [
      replaceRequired(),
      usable(),
    ]);
    manager.setDaemonClient({
      async call(method, params, ensureDaemon) {
        calls.push([method, params, ensureDaemon]);
        return {};
      },
    });
    const originalError = defaultLogger.error;
    defaultLogger.error = () => {};
    try {
      await manager.ensureDaemon();
    } finally {
      defaultLogger.error = originalError;
    }
    assert.deepStrictEqual(calls, [
      [
        "shutdownDaemon",
        { reason: "daemon-protocol-older-than-connector" },
        false,
      ],
    ]);
    assert.strictEqual(discovery.calls, 2);
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(fs.existsSync(manager.spawnLock.lockPath), false);
  });

  it("finds and stops a Unix daemon by its argv0 marker", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(5000);

    const daemonProcessName = `${path.basename(tempDir)}-lookup-muxDaemon`;
    const child = spawnChildProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        argv0: daemonProcessName,
        stdio: "ignore",
      }
    );

    try {
      await once(child, "spawn");
      const { manager, controlEndpoint } = createManager(tempDir, [usable()], {
        daemonProcessName,
        replacementTimeout: 1000,
        kill: (pid, signal) => process.kill(pid, signal),
        isProcessAlive,
        sleep: (duration) =>
          new Promise((resolve) => setTimeout(resolve, duration)),
        now: Date.now,
      });
      fs.writeFileSync(controlEndpoint, "stale");

      await manager.tryGracefullyStopDaemon("force-stop");
      await waitForChildExit(child);

      assert.strictEqual(isProcessAlive(child.pid), false);
      assert.strictEqual(fs.existsSync(controlEndpoint), false);
    } finally {
      if (isProcessAlive(child.pid)) child.kill("SIGKILL");
      await waitForChildExit(child);
    }
  });

  it("escalates to SIGKILL when the marked Unix daemon ignores SIGTERM", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(5000);

    const daemonProcessName = `${path.basename(tempDir)}-stubborn-muxDaemon`;
    const child = spawnChildProcess(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); " +
          "process.send('ready'); setInterval(() => {}, 1000)",
      ],
      {
        argv0: daemonProcessName,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }
    );
    const signals = [];

    try {
      await once(child, "spawn");
      await once(child, "message");
      const { manager } = createManager(tempDir, [usable()], {
        daemonProcessName,
        replacementTimeout: 50,
        kill: (pid, signal) => {
          signals.push([pid, signal]);
          process.kill(pid, signal);
        },
        isProcessAlive,
        sleep: (duration) =>
          new Promise((resolve) => setTimeout(resolve, duration)),
        now: Date.now,
      });

      await manager.tryGracefullyStopDaemon("force-stop");
      await waitForChildExit(child);

      assert.deepStrictEqual(signals, [
        [child.pid, "SIGTERM"],
        [child.pid, "SIGKILL"],
      ]);
      assert.strictEqual(child.signalCode, "SIGKILL");
    } finally {
      if (isProcessAlive(child.pid)) child.kill("SIGKILL");
      await waitForChildExit(child);
    }
  });

  it("reports and returns when graceful shutdown cannot find a daemon pid", async function () {
    const errors = [];
    const controlEndpoint = path.join(tempDir, "control.sock");
    const { manager } = createManager(tempDir, [usable()]);
    const calls = [];
    manager.setDaemonClient({
      async call(method, params, ensureDaemon) {
        calls.push([method, params, ensureDaemon]);
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
      ["shutdownDaemon", { reason: "force-stop" }, false],
    ]);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes(manager.daemonProcessName));
    assert.strictEqual(fs.existsSync(controlEndpoint), true);
  });
});
