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
    daemonVersion: overrides.daemonVersion,
    capabilities: overrides.capabilities,
    legacyDriverDir: overrides.legacyDriverDir,
    physicalConnectorOption: overrides.physicalConnectorOption,
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
    const readyInfo = createInfo({ pid: 201 });
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [
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
      daemonVersion: "0.0.1",
      capabilities: ["daemon", "manager"],
      legacyDriverDir: "/tmp/legacy-driver",
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
      "--daemon-version",
      "0.0.1",
      "--capabilities",
      "daemon,manager",
      "--legacy-driver-dir",
      "/tmp/legacy-driver",
    ]);
    assert.deepStrictEqual(spawnRecorder.calls[0].options, {
      detached: true,
      stdio: "ignore",
    });
    assert.strictEqual(spawnRecorder.calls[0].unrefCalled, true);
    assert.strictEqual(fs.existsSync(spawnLockPath), false);
  });

  it("passes serialized physical connector options to the daemon entry", async function () {
    const readyInfo = createInfo({ pid: 203 });
    const discovery = createSequenceDiscovery(
      path.join(tempDir, "daemon.json"),
      [unusable("missing"), unusable("missing"), usable(readyInfo)]
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
    };
    const { manager, spawnRecorder } = createManager(tempDir, {
      discovery,
      physicalConnectorOption,
    });

    assert.deepStrictEqual(await manager.ensureDaemon(), readyInfo);
    assert.strictEqual(spawnRecorder.calls.length, 1);
    const args = spawnRecorder.calls[0].args;
    const optionIndex = args.indexOf("--physical-connector-option");
    assert.notStrictEqual(optionIndex, -1);
    assert.deepStrictEqual(
      JSON.parse(args[optionIndex + 1]),
      physicalConnectorOption
    );
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
    fs.writeFileSync(
      path.join(spawnLockPath, "owner.json"),
      JSON.stringify({ pid: 1, createdAt: 0 })
    );

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
    fs.writeFileSync(
      path.join(spawnLockPath, "owner.json"),
      JSON.stringify({ pid: 1, createdAt: 0 })
    );

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

  it("requestDaemonYield asks the daemon to stop and succeeds after health disappears", async function () {
    class HealthGoneManager extends MultiplexerDaemonManager {
      async checkDaemonHealth() {
        return { ok: false, reason: "connect ECONNREFUSED" };
      }
    }

    const killCalls = [];
    const { manager } = createManager(tempDir, {
      ManagerClass: HealthGoneManager,
      kill: (pid, signal) => killCalls.push([pid, signal]),
    });

    assert.strictEqual(
      await manager.requestDaemonYield(
        createInfo({ pid: 312 }),
        "stale-daemon"
      ),
      true
    );
    assert.deepStrictEqual(killCalls, [[312, "SIGTERM"]]);
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

  it("waits for a fresh daemon lock to become stale before spawning a replacement", async function () {
    let now = 1000;
    const discoveryPath = path.join(tempDir, "daemon.json");
    const daemonLockPath = path.join(tempDir, "daemon.lock");
    const readyInfo = createInfo({
      pid: 301,
      heartbeat: 1060,
      startedAt: 1060,
    });
    const spawnCalls = [];
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
      staleTimeout: 50,
      localProtocolVersion: 1,
      now: () => now,
    });
    const { manager } = createManager(tempDir, {
      discovery,
      daemonLockPath,
      staleTimeout: 50,
      readyPollInterval: 10,
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
    assert.strictEqual(spawnCalls[0].now, 1060);
    assert.strictEqual(fs.existsSync(daemonLockPath), false);
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
    fs.writeFileSync(
      path.join(daemonLockPath, "owner.json"),
      JSON.stringify({ pid: oldInfo.pid, createdAt: now })
    );

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
      staleTimeout: 50,
      readyPollInterval: 10,
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
    assert.strictEqual(spawnCalls[0].now, 1060);
    assert.strictEqual(spawnCalls[0].oldDiscoveryExists, false);
    assert.strictEqual(spawnCalls[0].oldDaemonLockExists, false);
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
