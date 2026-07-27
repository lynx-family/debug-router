// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");

const {
  createIntegrationContext,
  getHealth,
  platformTimeout,
  processExists,
  readJsonFile,
  waitFor,
} = require("./helpers/integration_harness");

describe("multiplexer integration daemon lifecycle", function () {
  this.timeout(platformTimeout(10000));

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("spawns a real daemon process, serves health, refreshes heartbeat, and cleans up on SIGTERM", async function () {
    context = createIntegrationContext("daemon-lifecycle", {
      heartbeatInterval: 25,
      staleTimeout: 500,
      debugInfo: {
        daemonVersion: "integration-test-daemon",
      },
    });

    const info = await context.manager.ensureDaemon();
    assert(processExists(info.pid), "daemon process should exist");
    assert.strictEqual(fs.existsSync(context.paths.discoveryPath), true);
    assert.strictEqual(fs.existsSync(context.paths.daemonLockPath), true);
    assert.strictEqual(info.protocolVersion > 0, true);
    assert.strictEqual(info.minSupportedProtocolVersion > 0, true);
    assert.strictEqual(info.controlPort > 0, true);
    assert.strictEqual(info.debugInfo.daemonVersion, "integration-test-daemon");
    assert.strictEqual(info.debugInfo.processId, info.pid);
    assert.strictEqual(typeof info.debugInfo.timestamp, "number");

    const health = await getHealth(info.controlPort);
    assert.strictEqual(health.statusCode, 200);
    assert.strictEqual(health.body.pid, info.pid);
    assert.strictEqual(health.body.protocolVersion, info.protocolVersion);
    assert.strictEqual(
      health.body.minSupportedProtocolVersion,
      info.minSupportedProtocolVersion
    );
    assert.strictEqual(
      health.body.debugInfo.daemonVersion,
      "integration-test-daemon"
    );
    assert.strictEqual(health.body.debugInfo.processId, info.pid);
    assert.strictEqual(typeof health.body.debugInfo.timestamp, "number");

    assert(
      context
        .readLog()
        .some(
          (entry) =>
            entry.event === "fake-physical-created" &&
            entry.devices === 1 &&
            entry.clients === 1
        ),
      "fake physical should be created in the daemon process"
    );

    const firstHeartbeat = readJsonFile(context.paths.discoveryPath, null)
      .heartbeat;
    await waitFor(() => {
      const current = readJsonFile(context.paths.discoveryPath, null);
      return current && current.heartbeat > firstHeartbeat;
    }, 1500);

    const client = context.createClient();
    const snapshots = [];
    client.subscribe((event) => {
      if (event.event === "snapshot") {
        snapshots.push(event.data);
      }
    });
    await client.connect();
    await waitFor(() => snapshots.length > 0);
    assert.deepStrictEqual(
      snapshots[0].devices.map((device) => device.serial),
      ["device-1"]
    );
    assert.deepStrictEqual(
      snapshots[0].clients.map((runtime) => runtime.id),
      [1]
    );

    await stopDaemonForPlatform(context, info);
    await waitFor(() => !fs.existsSync(context.paths.discoveryPath), 2000);
    await waitFor(() => !fs.existsSync(context.paths.daemonLockPath), 2000);
  });

  it("lets daemon idle timeout remove discovery and daemon lock when no control clients are connected", async function () {
    context = createIntegrationContext("daemon-idle", {
      heartbeatInterval: 25,
      multiplexerDaemonIdleTimeout: 50,
      staleTimeout: 500,
    });

    const info = await context.manager.ensureDaemon();
    assert(processExists(info.pid), "daemon process should exist before idle");

    await waitFor(() => !fs.existsSync(context.paths.discoveryPath), 2000);
    await waitFor(() => !fs.existsSync(context.paths.daemonLockPath), 2000);

    const log = context.readLog();
    assert(
      log.some((entry) => entry.event === "fake-physical-closed"),
      "fake physical connector should be closed during idle cleanup"
    );
  });

  it("stops the daemon when its forceRespawnDaemon Connector closes", async function () {
    context = createIntegrationContext("daemon-force-close", {
      heartbeatInterval: 25,
      multiplexerDaemonIdleTimeout: 30000,
      staleTimeout: 500,
    });

    const connector = context.createConnector({
      forceRespawnDaemon: true,
    });
    await connector.connectDevices(-1, null, false);
    const info = readJsonFile(context.paths.discoveryPath, null);
    assert(info && processExists(info.pid), "forced daemon should be running");

    await connector.close();

    await waitFor(() => !fs.existsSync(context.paths.discoveryPath), 2000);
    await waitFor(() => !fs.existsSync(context.paths.daemonLockPath), 2000);
    await waitFor(() => !processExists(info.pid), 2000);
  });

  it("keeps the daemon and other controls alive when one control WebSocket errors", async function () {
    context = createIntegrationContext("daemon-control-socket-error", {
      heartbeatInterval: 25,
      staleTimeout: 500,
    });

    const info = await context.manager.ensureDaemon();
    const failedClient = context.createClient();
    const healthyClient = context.createClient();
    const failedClientStates = [];
    failedClient.subscribeConnectionState((state) => {
      failedClientStates.push(state.state);
    });
    await failedClient.connect();
    await healthyClient.connect();

    context.appendCommand({
      type: "emit-control-socket-error",
      message: "integration control socket error",
    });

    await waitFor(() => !failedClient.ready, 3000);

    assert(processExists(info.pid), "daemon process should remain alive");
    assert.strictEqual(healthyClient.ready, true);
    assert.strictEqual(fs.existsSync(context.paths.discoveryPath), true);
    assert.strictEqual(fs.existsSync(context.paths.daemonLockPath), true);
    assert.strictEqual((await getHealth(info.controlPort)).body.pid, info.pid);
    assert.deepStrictEqual(
      (
        await healthyClient.call("connectDevices", {
          isAutoListenClients: false,
        })
      ).map((device) => device.serial),
      ["device-1"]
    );
    assert.deepStrictEqual(failedClientStates, ["connected", "disconnected"]);

    const log = context.readLog();
    assert(
      !log.some((entry) => entry.event === "daemon-uncaught-exception"),
      "socket errors should not reach the daemon uncaught exception handler"
    );
    assert(
      !log.some((entry) => entry.event === "fake-physical-closed"),
      "isolating one control socket should not close physical resources"
    );
  });
});

async function stopDaemonForPlatform(context, info) {
  if (process.platform === "win32") {
    await context.manager.stopDaemonForReplacement(info, "stale-daemon");
    return;
  }

  process.kill(info.pid, "SIGTERM");
}
