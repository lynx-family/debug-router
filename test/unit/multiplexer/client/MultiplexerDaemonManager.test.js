// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const http = require("http");
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

class HealthReadyManager extends MultiplexerDaemonManager {
  async checkDaemonHealth() {
    return { ok: true };
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-mux-manager-"));
}

function writeLockOwner(lockPath, owner) {
  fs.writeFileSync(
    path.join(lockPath, "owner.json"),
    JSON.stringify({
      token: `${owner.pid}-${owner.createdAt}-test`,
      ...owner,
    })
  );
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

function connectorTooOld(
  info = createInfo({
    protocolVersion: 2,
    minSupportedProtocolVersion: 2,
  })
) {
  return {
    status: "unusable",
    reason: "connector-protocol-too-old",
    info,
    compatibility: {
      status: "incompatible",
      reason: "connector-older-than-daemon-min-supported",
      daemonProtocolVersion: info.protocolVersion,
      daemonMinSupportedProtocolVersion: info.minSupportedProtocolVersion,
      connectorProtocolVersion: 1,
    },
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
  const manager = new (overrides.ManagerClass ?? HealthReadyManager)({
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
    healthCheckTimeout: overrides.healthCheckTimeout,
    heartbeatInterval: overrides.heartbeatInterval,
    minSupportedProtocolVersion: overrides.minSupportedProtocolVersion,
    debugInfo: overrides.debugInfo,
    legacyDriverDir: overrides.legacyDriverDir,
    forceRespawnDaemon: overrides.forceRespawnDaemon,
    physicalConnectorOption: overrides.physicalConnectorOption,
    readyPollInterval: overrides.readyPollInterval ?? 10,
    replacementTimeout: overrides.replacementTimeout ?? 20,
    spawn: spawnRecorder.spawn,
    kill: overrides.kill ?? (() => {}),
    isProcessAlive: overrides.isProcessAlive,
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

function startHealthServer(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
    });
    handler(request, response, requests.length);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        server,
        port: server.address().port,
        requests,
      });
    });
  });
}

function closeHealthServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function writeHealthResponse(response, body, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

function createHealthResponse(info, overrides = {}) {
  return {
    ok: true,
    pid: info.pid,
    protocolVersion: info.protocolVersion,
    heartbeat: info.heartbeat,
    ...overrides,
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
    let now = 0;
    const readyInfo = createInfo({ pid: 201 });
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [
        unusable("missing"),
        unusable("missing"),
        unusable("missing"),
        unusable("missing"),
        unusable("missing"),
        unusable("missing"),
        unusable("missing"),
        usable(readyInfo),
      ]
    );
    const {
      manager,
      spawnRecorder,
      spawnLockPath,
      daemonLockPath,
    } = createManager(tempDir, {
      discovery,
      heartbeatInterval: 250,
      debugInfo: {
        daemonVersion: "0.0.1",
      },
      legacyDriverDir: "/tmp/legacy-driver",
      startupTimeout: 30,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
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
      "--min-supported-protocol-version",
      "1",
      "--control-port",
      "9111",
      "--heartbeat-interval",
      "250",
      "--debug-info",
      '{"daemonVersion":"0.0.1"}',
      "--legacy-driver-dir",
      "/tmp/legacy-driver",
    ]);
    assert.deepStrictEqual(spawnRecorder.calls[0].options, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    assert.strictEqual(spawnRecorder.calls[0].unrefCalled, true);
    assert.strictEqual(fs.existsSync(spawnLockPath), false);
  });

  it("passes serialized physical connector options to the daemon entry", async function () {
    let now = 0;
    const readyInfo = createInfo({ pid: 203 });
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [
        unusable("missing"),
        unusable("missing"),
        unusable("missing"),
        unusable("missing"),
        unusable("missing"),
        unusable("missing"),
        unusable("missing"),
        usable(readyInfo),
      ]
    );
    const physicalConnectorOption = {
      manualConnect: true,
      enableAndroid: true,
      enableIOS: false,
      enableHarmony: false,
      enableDesktop: false,
      enableNetworkDevice: false,
      adbHostPort: {
        host: "127.0.0.1",
        port: 5037,
      },
      usbConnectOpt: {
        retryTime: 5000,
      },
      traceRecorder: {
        shouldNotCrossProcessBoundary: true,
      },
    };
    const { manager, spawnRecorder } = createManager(tempDir, {
      discovery,
      physicalConnectorOption,
      startupTimeout: 30,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
    });

    assert.deepStrictEqual(await manager.ensureDaemon(), readyInfo);
    assert.strictEqual(spawnRecorder.calls.length, 1);
    const args = spawnRecorder.calls[0].args;
    const optionIndex = args.indexOf("--physical-connector-option");
    assert.notStrictEqual(optionIndex, -1);
    const serializedOption = JSON.parse(args[optionIndex + 1]);
    assert.strictEqual("traceRecorder" in serializedOption, false);
    assert.deepStrictEqual(serializedOption, {
      manualConnect: true,
      enableAndroid: true,
      enableIOS: false,
      enableHarmony: false,
      enableDesktop: false,
      enableNetworkDevice: false,
      adbHostPort: {
        host: "127.0.0.1",
        port: 5037,
      },
      usbConnectOpt: {
        retryTime: 5000,
      },
    });
  });

  it("force-respawns a healthy daemon once with the local daemon entry and options", async function () {
    class ForceRespawnManager extends HealthReadyManager {
      async requestDaemonYield(info, reason) {
        this.yieldCalls = this.yieldCalls ?? [];
        this.yieldCalls.push({ info, reason });
        return true;
      }
    }

    const oldInfo = createInfo({ pid: 210 });
    const readyInfo = createInfo({ pid: 211 });
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(oldInfo), usable(readyInfo), usable(readyInfo)]
    );
    const { manager, spawnRecorder } = createManager(tempDir, {
      ManagerClass: ForceRespawnManager,
      discovery,
      forceRespawnDaemon: true,
      isProcessAlive: (pid) => pid === oldInfo.pid,
    });

    assert.deepStrictEqual(await manager.ensureDaemon(), readyInfo);
    assert.deepStrictEqual(manager.yieldCalls, [
      {
        info: oldInfo,
        reason: "force-respawn",
      },
    ]);
    assert.strictEqual(spawnRecorder.calls.length, 1);
    assert.strictEqual(
      spawnRecorder.calls[0].args[0],
      "/tmp/multiplexer-entry.js"
    );

    assert.deepStrictEqual(await manager.ensureDaemon(), readyInfo);
    assert.strictEqual(spawnRecorder.calls.length, 1);
    assert.strictEqual(manager.yieldCalls.length, 1);
  });

  it("force-stops the daemon and removes discovery and daemon lock artifacts", async function () {
    class ForceStopManager extends HealthReadyManager {
      async requestDaemonYield(info, reason) {
        this.yieldCalls = this.yieldCalls ?? [];
        this.yieldCalls.push({ info, reason });
        return true;
      }
    }

    const oldInfo = createInfo({ pid: 212 });
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    fs.writeFileSync(discoveryPath, JSON.stringify(oldInfo));
    fs.mkdirSync(daemonLockPath);
    const discovery = createSequenceDiscovery(discoveryPath, [usable(oldInfo)]);
    const { manager, spawnRecorder } = createManager(tempDir, {
      ManagerClass: ForceStopManager,
      discovery,
      daemonLockPath,
      isProcessAlive: (pid) => pid === oldInfo.pid,
    });

    await manager.forceStopDaemon();

    assert.deepStrictEqual(manager.yieldCalls, [
      {
        info: oldInfo,
        reason: "force-stop",
      },
    ]);
    assert.deepStrictEqual(spawnRecorder.calls, []);
    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
    assert.strictEqual(fs.existsSync(manager.spawnLock.lockPath), false);
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

  it("keeps a spawn lock that is still inside the stale timeout window", function () {
    const now = 2500;
    const { manager, spawnLockPath } = createManager(tempDir, {
      startupTimeout: 1000,
      replacementTimeout: 500,
      now: () => now,
    });
    fs.mkdirSync(spawnLockPath, { recursive: true });
    writeLockOwner(spawnLockPath, { pid: process.pid, createdAt: 0 });

    assert.strictEqual(manager.acquireSpawnLock(), false);
    assert.strictEqual(fs.existsSync(spawnLockPath), true);
  });

  it("cleans an expired spawn lock before acquiring it", function () {
    const now = 2501;
    const { manager, spawnLockPath } = createManager(tempDir, {
      startupTimeout: 1000,
      replacementTimeout: 500,
      now: () => now,
    });
    fs.mkdirSync(spawnLockPath, { recursive: true });
    writeLockOwner(spawnLockPath, { pid: process.pid, createdAt: 0 });

    assert.strictEqual(manager.acquireSpawnLock(), true);
    assert.strictEqual(manager.spawnLock.isLocked(), true);

    manager.releaseSpawnLock();
  });

  it("rejects a daemon that no longer supports this connector", async function () {
    const unsupportedInfo = createInfo({
      pid: 290,
      protocolVersion: 2,
      minSupportedProtocolVersion: 2,
    });
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [connectorTooOld(unsupportedInfo)]
    );
    const { manager, spawnRecorder } = createManager(tempDir, {
      discovery,
    });

    await assert.rejects(
      () => manager.ensureDaemon(),
      /requires debug-router-connector protocol 2 or newer/
    );
    assert.deepStrictEqual(spawnRecorder.calls, []);
  });

  it("replaces an older daemon by forcing stop when yield is unavailable", async function () {
    class YieldUnavailableManager extends HealthReadyManager {
      async requestDaemonYield() {
        return false;
      }
    }

    const oldInfo = createInfo({ pid: 300, protocolVersion: 0 });
    const readyInfo = createInfo({ pid: 301 });
    const killCalls = [];
    let now = 0;
    let killed = false;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [
        replaceRequired(oldInfo),
        replaceRequired(oldInfo),
        unusable("missing"),
        usable(readyInfo),
      ]
    );
    const { manager, spawnRecorder } = createManager(tempDir, {
      ManagerClass: YieldUnavailableManager,
      discovery,
      kill: (pid, signal) => {
        killCalls.push([pid, signal]);
        if (signal === "SIGKILL") {
          killed = true;
        }
      },
      isProcessAlive: () => !killed,
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
    });

    assert.deepStrictEqual(await manager.ensureDaemon(), readyInfo);
    assert.deepStrictEqual(killCalls, [
      [300, "SIGTERM"],
      [300, "SIGKILL"],
    ]);
    assert.strictEqual(spawnRecorder.calls.length, 1);
  });

  it("does not force kill when requestDaemonYield succeeds", async function () {
    class YieldingManager extends HealthReadyManager {
      async requestDaemonYield() {
        return true;
      }
    }

    const oldInfo = createInfo({ pid: 310, protocolVersion: 0 });
    const readyInfo = createInfo({ pid: 311 });
    const killCalls = [];
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [
        replaceRequired(oldInfo),
        replaceRequired(oldInfo),
        unusable("missing"),
        usable(readyInfo),
      ]
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

  it("requestDaemonYield sends shutdown RPC through daemon client and waits for process exit only", async function () {
    const oldInfo = createInfo({ pid: 312, controlPort: 9012 });
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    fs.writeFileSync(discoveryPath, JSON.stringify(oldInfo));
    fs.mkdirSync(daemonLockPath);
    let alive = true;
    const daemonClientCalls = [];
    const daemonClient = {
      async callOnDiscovery(info, method, params) {
        daemonClientCalls.push({ info, method, params });
        alive = false;
        return undefined;
      },
    };

    const discovery = new MultiplexerDiscovery({
      discoveryPath,
      staleTimeout: 1000,
      localProtocolVersion: 1,
    });

    const { manager } = createManager(tempDir, {
      discovery,
      daemonLockPath,
      isProcessAlive: () => alive,
    });
    manager.setDaemonClient(daemonClient);

    assert.strictEqual(
      await manager.requestDaemonYield(oldInfo, "stale-daemon"),
      true
    );
    assert.deepStrictEqual(daemonClientCalls, [
      {
        info: oldInfo,
        method: "shutdownDaemon",
        params: { reason: "stale-daemon" },
      },
    ]);
    assert.strictEqual(fs.existsSync(discoveryPath), true);
    assert.strictEqual(fs.existsSync(daemonLockPath), true);
  });

  it("stopDaemonForReplacement cleans artifacts after graceful shutdown", async function () {
    class YieldingManager extends HealthReadyManager {
      async requestDaemonYield() {
        return true;
      }
    }

    const oldInfo = createInfo({ pid: 313, controlPort: 9013 });
    const readyInfo = createInfo({ pid: 314 });
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    fs.writeFileSync(discoveryPath, JSON.stringify(oldInfo));
    fs.mkdirSync(daemonLockPath);

    const discovery = createSequenceDiscovery(discoveryPath, [
      replaceRequired(oldInfo),
      replaceRequired(oldInfo),
      unusable("missing"),
      usable(readyInfo),
    ]);

    const { manager, spawnRecorder } = createManager(tempDir, {
      ManagerClass: YieldingManager,
      discovery,
      daemonLockPath,
    });

    assert.deepStrictEqual(await manager.ensureDaemon(), readyInfo);
    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
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

  it("waits until usable discovery also passes the health check", async function () {
    const info = createInfo({ pid: 410 });
    const healthServer = await startHealthServer((request, response) => {
      writeHealthResponse(response, createHealthResponse(info));
    });
    info.controlPort = healthServer.port;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(info)]
    );
    const { manager, sleepCalls } = createManager(tempDir, {
      ManagerClass: MultiplexerDaemonManager,
      discovery,
    });

    try {
      assert.deepStrictEqual(await manager.waitUntilReady(25), info);
      assert.deepStrictEqual(healthServer.requests, [
        { method: "GET", url: "/health" },
      ]);
      assert.deepStrictEqual(sleepCalls, []);
    } finally {
      await closeHealthServer(healthServer.server);
    }
  });

  it("keeps polling when the usable discovery has an invalid control port", async function () {
    let now = 0;
    const validInfo = createInfo({ pid: 411 });
    const invalidInfo = createInfo({ pid: 412, controlPort: 0 });
    const healthServer = await startHealthServer((request, response) => {
      writeHealthResponse(response, createHealthResponse(validInfo));
    });
    validInfo.controlPort = healthServer.port;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(invalidInfo), usable(validInfo)]
    );
    const { manager, sleepCalls } = createManager(tempDir, {
      ManagerClass: MultiplexerDaemonManager,
      discovery,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        sleepCalls.push(duration);
        now += duration;
      },
    });

    try {
      assert.deepStrictEqual(await manager.waitUntilReady(25), validInfo);
      assert.deepStrictEqual(healthServer.requests, [
        { method: "GET", url: "/health" },
      ]);
      assert.deepStrictEqual(sleepCalls, [10]);
    } finally {
      await closeHealthServer(healthServer.server);
    }
  });

  it("keeps polling when the health endpoint returns a non-200 status", async function () {
    let now = 0;
    const info = createInfo({ pid: 413 });
    const healthServer = await startHealthServer((request, response, call) => {
      if (call === 1) {
        writeHealthResponse(response, { ok: false }, 503);
        return;
      }
      writeHealthResponse(response, createHealthResponse(info));
    });
    info.controlPort = healthServer.port;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(info)]
    );
    const { manager, sleepCalls } = createManager(tempDir, {
      ManagerClass: MultiplexerDaemonManager,
      discovery,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        sleepCalls.push(duration);
        now += duration;
      },
    });

    try {
      assert.deepStrictEqual(await manager.waitUntilReady(25), info);
      assert.strictEqual(healthServer.requests.length, 2);
      assert.deepStrictEqual(sleepCalls, [10]);
    } finally {
      await closeHealthServer(healthServer.server);
    }
  });

  it("keeps polling when the health response is not valid JSON", async function () {
    let now = 0;
    const info = createInfo({ pid: 414 });
    const healthServer = await startHealthServer((request, response, call) => {
      if (call === 1) {
        writeHealthResponse(response, "{bad-json");
        return;
      }
      writeHealthResponse(response, createHealthResponse(info));
    });
    info.controlPort = healthServer.port;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(info)]
    );
    const { manager, sleepCalls } = createManager(tempDir, {
      ManagerClass: MultiplexerDaemonManager,
      discovery,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        sleepCalls.push(duration);
        now += duration;
      },
    });

    try {
      assert.deepStrictEqual(await manager.waitUntilReady(25), info);
      assert.strictEqual(healthServer.requests.length, 2);
      assert.deepStrictEqual(sleepCalls, [10]);
    } finally {
      await closeHealthServer(healthServer.server);
    }
  });

  it("keeps polling when the health response has an invalid shape", async function () {
    let now = 0;
    const info = createInfo({ pid: 415 });
    const healthServer = await startHealthServer((request, response, call) => {
      if (call === 1) {
        writeHealthResponse(response, {
          ok: true,
          pid: String(info.pid),
          protocolVersion: info.protocolVersion,
          heartbeat: info.heartbeat,
        });
        return;
      }
      writeHealthResponse(response, createHealthResponse(info));
    });
    info.controlPort = healthServer.port;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(info)]
    );
    const { manager, sleepCalls } = createManager(tempDir, {
      ManagerClass: MultiplexerDaemonManager,
      discovery,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        sleepCalls.push(duration);
        now += duration;
      },
    });

    try {
      assert.deepStrictEqual(await manager.waitUntilReady(25), info);
      assert.strictEqual(healthServer.requests.length, 2);
      assert.deepStrictEqual(sleepCalls, [10]);
    } finally {
      await closeHealthServer(healthServer.server);
    }
  });

  it("keeps polling when the health response belongs to another pid", async function () {
    let now = 0;
    const info = createInfo({ pid: 416 });
    const healthServer = await startHealthServer((request, response, call) => {
      writeHealthResponse(
        response,
        createHealthResponse(info, {
          pid: call === 1 ? info.pid + 1 : info.pid,
        })
      );
    });
    info.controlPort = healthServer.port;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(info)]
    );
    const { manager, sleepCalls } = createManager(tempDir, {
      ManagerClass: MultiplexerDaemonManager,
      discovery,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        sleepCalls.push(duration);
        now += duration;
      },
    });

    try {
      assert.deepStrictEqual(await manager.waitUntilReady(25), info);
      assert.strictEqual(healthServer.requests.length, 2);
      assert.deepStrictEqual(sleepCalls, [10]);
    } finally {
      await closeHealthServer(healthServer.server);
    }
  });

  it("keeps polling when the health response has another protocol version", async function () {
    let now = 0;
    const info = createInfo({ pid: 417, protocolVersion: 2 });
    const healthServer = await startHealthServer((request, response, call) => {
      writeHealthResponse(
        response,
        createHealthResponse(info, {
          protocolVersion:
            call === 1 ? info.protocolVersion - 1 : info.protocolVersion,
        })
      );
    });
    info.controlPort = healthServer.port;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(info)]
    );
    const { manager, sleepCalls } = createManager(tempDir, {
      ManagerClass: MultiplexerDaemonManager,
      discovery,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        sleepCalls.push(duration);
        now += duration;
      },
    });

    try {
      assert.deepStrictEqual(await manager.waitUntilReady(25), info);
      assert.strictEqual(healthServer.requests.length, 2);
      assert.deepStrictEqual(sleepCalls, [10]);
    } finally {
      await closeHealthServer(healthServer.server);
    }
  });

  it("keeps polling when the health response exceeds the size limit", async function () {
    let now = 0;
    const info = createInfo({ pid: 418 });
    const healthServer = await startHealthServer((request, response, call) => {
      if (call === 1) {
        writeHealthResponse(response, "x".repeat(4097));
        return;
      }
      writeHealthResponse(response, createHealthResponse(info));
    });
    info.controlPort = healthServer.port;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(info)]
    );
    const { manager, sleepCalls } = createManager(tempDir, {
      ManagerClass: MultiplexerDaemonManager,
      discovery,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        sleepCalls.push(duration);
        now += duration;
      },
    });

    try {
      assert.deepStrictEqual(await manager.waitUntilReady(25), info);
      assert.strictEqual(healthServer.requests.length, 2);
      assert.deepStrictEqual(sleepCalls, [10]);
    } finally {
      await closeHealthServer(healthServer.server);
    }
  });

  it("reports the last health failure when readiness times out", async function () {
    let now = 0;
    const info = createInfo({ pid: 419 });
    const healthServer = await startHealthServer((request, response) => {
      writeHealthResponse(response, { ok: false }, 503);
    });
    info.controlPort = healthServer.port;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(info)]
    );
    const { manager } = createManager(tempDir, {
      ManagerClass: MultiplexerDaemonManager,
      discovery,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
    });

    try {
      await assert.rejects(
        () => manager.waitUntilReady(15),
        /Timed out waiting for multiplexer daemon: usable, health-check:status:503/
      );
      assert.strictEqual(healthServer.requests.length, 2);
    } finally {
      await closeHealthServer(healthServer.server);
    }
  });

  it("reports connection errors from the health probe", async function () {
    let now = 0;
    const info = createInfo({ pid: 420, controlPort: 65534 });
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(info)]
    );
    const { manager } = createManager(tempDir, {
      ManagerClass: MultiplexerDaemonManager,
      discovery,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
    });

    await assert.rejects(
      () => manager.waitUntilReady(15),
      /Timed out waiting for multiplexer daemon: usable, health-check:/
    );
  });

  it("reports health probe timeouts", async function () {
    let now = 0;
    const info = createInfo({ pid: 421 });
    const healthServer = await startHealthServer(() => {});
    info.controlPort = healthServer.port;
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [usable(info)]
    );
    const { manager } = createManager(tempDir, {
      ManagerClass: MultiplexerDaemonManager,
      discovery,
      healthCheckTimeout: 10,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
    });

    try {
      await assert.rejects(
        () => manager.waitUntilReady(10),
        /Timed out waiting for multiplexer daemon: usable, health-check:multiplexer health check timed out/
      );
    } finally {
      await closeHealthServer(healthServer.server);
    }
  });

  it("stops stale daemon lock owner before spawning a replacement", async function () {
    let now = 1000;
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    const spawnCalls = [];
    const killCalls = [];
    const livePids = new Set([301]);
    const readyInfo = createInfo({
      pid: 302,
      heartbeat: now,
      startedAt: now,
    });
    fs.writeFileSync(
      discoveryPath,
      JSON.stringify(createInfo({ heartbeat: 0 }))
    );
    fs.mkdirSync(daemonLockPath);
    writeLockOwner(daemonLockPath, { pid: 301, createdAt: 0 });

    const discovery = new MultiplexerDiscovery({
      discoveryPath,
      staleTimeout: 50,
      localProtocolVersion: 1,
      now: () => now,
    });
    const { manager } = createManager(tempDir, {
      discovery,
      daemonLockPath,
      startupTimeout: 30,
      staleTimeout: 50,
      readyPollInterval: 10,
      now: () => now,
      isProcessAlive: (pid) => livePids.has(pid),
      kill: (pid, signal) => {
        killCalls.push([pid, signal]);
        livePids.delete(pid);
      },
      sleep: async (duration) => {
        now += duration;
      },
      spawnRecorder: {
        calls: spawnCalls,
        spawn(command, args, options) {
          spawnCalls.push({
            command,
            args,
            options,
            now,
            oldDiscoveryExists: fs.existsSync(discoveryPath),
            oldDaemonLockExists: fs.existsSync(daemonLockPath),
          });
          fs.writeFileSync(
            discoveryPath,
            JSON.stringify({
              ...readyInfo,
              heartbeat: now,
              startedAt: now,
            })
          );
          return {
            pid: readyInfo.pid,
            unref() {},
          };
        },
      },
    });

    const info = await manager.ensureDaemon();

    assert.strictEqual(info.pid, readyInfo.pid);
    assert.deepStrictEqual(killCalls, [[301, "SIGTERM"]]);
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].now, 1000);
    assert.strictEqual(spawnCalls[0].oldDiscoveryExists, false);
    assert.strictEqual(spawnCalls[0].oldDaemonLockExists, false);
  });

  it("does not reuse a fresh discovery when its daemon health check fails", async function () {
    class FailingThenReadyHealthManager extends MultiplexerDaemonManager {
      async checkDaemonHealth(info) {
        if (info.pid === 301) {
          return { ok: true };
        }
        return { ok: false, reason: "connect ECONNREFUSED" };
      }
    }

    let now = 1000;
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    const oldInfo = createInfo({
      pid: 200,
      heartbeat: now,
      startedAt: now,
    });
    const readyInfo = createInfo({
      pid: 301,
      heartbeat: 1060,
      startedAt: 1060,
    });
    const spawnCalls = [];
    fs.writeFileSync(discoveryPath, JSON.stringify(oldInfo));
    fs.mkdirSync(daemonLockPath);
    writeLockOwner(daemonLockPath, { pid: 987654321, createdAt: now });

    const discovery = new MultiplexerDiscovery({
      discoveryPath,
      staleTimeout: 50,
      localProtocolVersion: 1,
      now: () => now,
    });
    const { manager } = createManager(tempDir, {
      ManagerClass: FailingThenReadyHealthManager,
      discovery,
      daemonLockPath,
      startupTimeout: 30,
      staleTimeout: 1000,
      readyPollInterval: 10,
      now: () => now,
      isProcessAlive: () => false,
      sleep: async (duration) => {
        now += duration;
      },
      spawnRecorder: {
        calls: spawnCalls,
        spawn(command, args, options) {
          spawnCalls.push({
            command,
            args,
            options,
            now,
            oldDiscoveryExists: fs.existsSync(discoveryPath),
            oldDaemonLockExists: fs.existsSync(daemonLockPath),
          });
          fs.writeFileSync(
            discoveryPath,
            JSON.stringify({
              ...readyInfo,
              heartbeat: now,
              startedAt: now,
            })
          );
          return {
            pid: readyInfo.pid,
            unref() {},
          };
        },
      },
    });

    const info = await manager.ensureDaemon();

    assert.strictEqual(info.pid, readyInfo.pid);
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].now, 1000);
    assert.strictEqual(spawnCalls[0].oldDiscoveryExists, false);
    assert.strictEqual(spawnCalls[0].oldDaemonLockExists, false);
  });

  it("reuses a healthy daemon that recovers before spawn cleanup", async function () {
    class RecoveringHealthManager extends MultiplexerDaemonManager {
      async checkDaemonHealth(info) {
        if (info.pid === 301) {
          return { ok: true };
        }
        return { ok: false, reason: "connect ECONNREFUSED" };
      }
    }

    let now = 1000;
    const discoveryPath = path.join(tempDir, "daemon.json");
    const oldInfo = createInfo({
      pid: 200,
      heartbeat: now,
      startedAt: now,
    });
    const readyInfo = createInfo({
      pid: 301,
      heartbeat: 1010,
      startedAt: 1010,
    });
    const discovery = createSequenceDiscovery(discoveryPath, [
      usable(oldInfo),
      usable(oldInfo),
      usable(readyInfo),
      usable(readyInfo),
    ]);
    const { manager, spawnRecorder } = createManager(tempDir, {
      ManagerClass: RecoveringHealthManager,
      discovery,
      startupTimeout: 30,
      readyPollInterval: 10,
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
    });

    const info = await manager.ensureDaemon();

    assert.strictEqual(info.pid, readyInfo.pid);
    assert.deepStrictEqual(spawnRecorder.calls, []);
  });

  it("stops an unhealthy daemon before spawning a replacement", async function () {
    class FailingHealthManager extends MultiplexerDaemonManager {
      async checkDaemonHealth(info) {
        if (info.pid === 301) {
          return { ok: true };
        }
        return { ok: false, reason: "connect ECONNREFUSED" };
      }
    }

    let now = 1000;
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    const killCalls = [];
    const livePids = new Set([200]);
    const oldInfo = createInfo({
      pid: 200,
      heartbeat: now,
      startedAt: now,
    });
    const readyInfo = createInfo({
      pid: 301,
      heartbeat: 1010,
      startedAt: 1010,
    });
    fs.writeFileSync(discoveryPath, JSON.stringify(oldInfo));
    fs.mkdirSync(daemonLockPath);
    writeLockOwner(daemonLockPath, { pid: oldInfo.pid, createdAt: now });
    const spawnCalls = [];

    const discovery = new MultiplexerDiscovery({
      discoveryPath,
      staleTimeout: 1000,
      localProtocolVersion: 1,
      now: () => now,
    });
    const { manager } = createManager(tempDir, {
      ManagerClass: FailingHealthManager,
      discovery,
      daemonLockPath,
      startupTimeout: 30,
      staleTimeout: 1000,
      readyPollInterval: 10,
      now: () => now,
      isProcessAlive: (pid) => livePids.has(pid),
      kill: (pid, signal) => {
        killCalls.push([pid, signal]);
        livePids.delete(pid);
      },
      sleep: async (duration) => {
        now += duration;
      },
      spawnRecorder: {
        calls: spawnCalls,
        spawn(command, args, options) {
          spawnCalls.push({
            command,
            args,
            options,
            now,
            oldDiscoveryExists: fs.existsSync(discoveryPath),
            oldDaemonLockExists: fs.existsSync(daemonLockPath),
          });
          fs.writeFileSync(
            discoveryPath,
            JSON.stringify({
              ...readyInfo,
              heartbeat: now,
              startedAt: now,
            })
          );
          return {
            pid: readyInfo.pid,
            unref() {},
          };
        },
      },
    });

    const info = await manager.ensureDaemon();

    assert.strictEqual(info.pid, readyInfo.pid);
    assert.deepStrictEqual(killCalls, [[oldInfo.pid, "SIGTERM"]]);
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].now, 1030);
    assert.strictEqual(spawnCalls[0].oldDiscoveryExists, false);
    assert.strictEqual(spawnCalls[0].oldDaemonLockExists, false);
  });

  it("removes unusable discovery and inactive daemon lock before spawning", async function () {
    let now = 5000;
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    const readyInfo = createInfo({
      pid: 301,
      heartbeat: now,
      startedAt: now,
    });
    const spawnCalls = [];
    fs.writeFileSync(
      discoveryPath,
      JSON.stringify(createInfo({ heartbeat: 0 }))
    );
    fs.mkdirSync(daemonLockPath);
    writeLockOwner(daemonLockPath, { pid: 987654321, createdAt: 0 });

    const discovery = new MultiplexerDiscovery({
      discoveryPath,
      staleTimeout: 500,
      localProtocolVersion: 1,
      now: () => now,
    });
    const { manager } = createManager(tempDir, {
      discovery,
      daemonLockPath,
      startupTimeout: 30,
      staleTimeout: 500,
      now: () => now,
      isProcessAlive: () => false,
      sleep: async (duration) => {
        now += duration;
      },
      spawnRecorder: {
        calls: spawnCalls,
        spawn(command, args, options) {
          spawnCalls.push({
            command,
            args,
            options,
            now,
            oldDiscoveryExists: fs.existsSync(discoveryPath),
            oldDaemonLockExists: fs.existsSync(daemonLockPath),
          });
          fs.writeFileSync(
            discoveryPath,
            JSON.stringify({
              ...readyInfo,
              heartbeat: now,
              startedAt: now,
            })
          );
          return {
            pid: readyInfo.pid,
            unref() {},
          };
        },
      },
    });

    const info = await manager.ensureDaemon();

    assert.strictEqual(info.pid, readyInfo.pid);
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].now, 5000);
    assert.strictEqual(spawnCalls[0].oldDiscoveryExists, false);
    assert.strictEqual(spawnCalls[0].oldDaemonLockExists, false);
  });

  it("removes invalid discovery without daemon lock before spawning", async function () {
    let now = 5000;
    const discoveryPath = path.join(tempDir, "daemon.json");
    const readyInfo = createInfo({
      pid: 302,
      heartbeat: now,
      startedAt: now,
    });
    const spawnCalls = [];
    fs.writeFileSync(discoveryPath, "{bad");
    const discovery = new MultiplexerDiscovery({
      discoveryPath,
      staleTimeout: 500,
      localProtocolVersion: 1,
      now: () => now,
    });
    const { manager } = createManager(tempDir, {
      discovery,
      startupTimeout: 30,
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
      spawnRecorder: {
        calls: spawnCalls,
        spawn(command, args, options) {
          spawnCalls.push({
            command,
            args,
            options,
            now,
            oldDiscoveryExists: fs.existsSync(discoveryPath),
          });
          fs.writeFileSync(
            discoveryPath,
            JSON.stringify({
              ...readyInfo,
              heartbeat: now,
              startedAt: now,
            })
          );
          return {
            pid: readyInfo.pid,
            unref() {},
          };
        },
      },
    });

    const info = await manager.ensureDaemon();

    assert.strictEqual(info.pid, readyInfo.pid);
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].now, 5000);
    assert.strictEqual(spawnCalls[0].oldDiscoveryExists, false);
  });

  it("ignores ESRCH when force stopping an already exited daemon", async function () {
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    const killCalls = [];
    let isProcessAliveCalls = 0;
    fs.writeFileSync(discoveryPath, "{}");
    fs.mkdirSync(daemonLockPath);
    const { manager } = createManager(tempDir, {
      discovery: createSequenceDiscovery(discoveryPath, [unusable("missing")]),
      daemonLockPath,
      kill: (pid, signal) => {
        killCalls.push([pid, signal]);
        const error = new Error("missing process");
        error.code = "ESRCH";
        throw error;
      },
      isProcessAlive: () => {
        isProcessAliveCalls++;
        return true;
      },
    });

    await manager.stopDaemonForReplacement(
      createInfo({ pid: 404 }),
      "stale-daemon"
    );

    assert.strictEqual(fs.existsSync(discoveryPath), false);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
    assert.deepStrictEqual(killCalls, [[404, "SIGTERM"]]);
    assert.strictEqual(isProcessAliveCalls, 0);
  });

  it("ignores ESRCH when the daemon exits before SIGKILL", async function () {
    const killCalls = [];
    let now = 0;
    const { manager } = createManager(tempDir, {
      replacementTimeout: 0,
      kill: (pid, signal) => {
        killCalls.push([pid, signal]);
        if (signal === "SIGKILL") {
          const error = new Error("missing process");
          error.code = "ESRCH";
          throw error;
        }
      },
      isProcessAlive: () => true,
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
    });

    await manager.stopDaemonForReplacement(
      createInfo({ pid: 406 }),
      "stale-daemon"
    );

    assert.deepStrictEqual(killCalls, [
      [406, "SIGTERM"],
      [406, "SIGKILL"],
    ]);
  });

  it("rethrows unexpected kill errors while force stopping", async function () {
    const killCalls = [];
    let now = 0;
    const { manager } = createManager(tempDir, {
      kill: (pid, signal) => {
        killCalls.push([pid, signal]);
        const error = new Error("permission denied");
        error.code = "EPERM";
        throw error;
      },
      isProcessAlive: () => true,
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
    });

    await assert.rejects(
      () =>
        manager.stopDaemonForReplacement(
          createInfo({ pid: 405 }),
          "stale-daemon"
        ),
      /permission denied/
    );
    assert.deepStrictEqual(killCalls, [
      [405, "SIGTERM"],
      [405, "SIGKILL"],
    ]);
  });
});
