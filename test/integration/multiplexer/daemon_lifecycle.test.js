// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const {
  createIntegrationContext,
  getHealth,
  getUsableDiscovery,
  platformTimeout,
  processExists,
  waitFor,
} = require("./helpers/integration_harness");

describe("multiplexer integration daemon lifecycle", function () {
  this.timeout(platformTimeout(10000));
  let context;

  afterEach(async function () {
    if (context) await context.cleanup();
    context = undefined;
  });

  it("spawns a daemon, serves framed IPC Health, and creates no discovery files", async function () {
    context = createIntegrationContext("daemon-lifecycle", {
      debugInfo: { daemonVersion: "integration-test-daemon" },
    });
    await context.manager.ensureDaemon();
    const info = await waitFor(() => getUsableDiscovery(context.discovery));

    assert(processExists(info.pid));
    assert.strictEqual(
      fs.existsSync(path.join(context.paths.dataDir, "daemon.lock")),
      false
    );
    assert.strictEqual(
      fs.existsSync(path.join(context.paths.dataDir, "daemon.json")),
      false
    );
    const directHealth = await getHealth(context.paths.controlEndpoint);
    assert.strictEqual(directHealth.statusCode, 200);
    assert.strictEqual(directHealth.body.kind, "health-response");
    assert.strictEqual(Object.hasOwn(directHealth.body, "pid"), false);
    assert.strictEqual(
      directHealth.body.debugInfo.daemonVersion,
      "integration-test-daemon"
    );
    assert.strictEqual(directHealth.body.debugInfo.processId, info.pid);

    const client = context.createClient();
    const snapshots = [];
    client.subscribe((event) => {
      if (event.event === "snapshot") snapshots.push(event.data);
    });
    await client.connect();
    await waitFor(() => snapshots.length > 0);
    assert.deepStrictEqual(
      snapshots[0].devices.map((device) => device.serial),
      ["device-1"]
    );

    process.kill(info.pid, "SIGTERM");
    await waitFor(() => !processExists(info.pid), 2000);
    if (process.platform !== "win32") {
      await waitFor(() => !fs.existsSync(context.paths.controlEndpoint), 2000);
    }
  });

  it("idles without any discovery heartbeat artifact", async function () {
    context = createIntegrationContext("daemon-idle", {
      multiplexerDaemonIdleTimeout: 50,
    });
    await context.manager.ensureDaemon();
    const info = await waitFor(() => getUsableDiscovery(context.discovery));
    assert(processExists(info.pid));
    await waitFor(() => !processExists(info.pid), 2000);
    assert.strictEqual(
      fs.existsSync(path.join(context.paths.dataDir, "daemon.json")),
      false
    );
  });

  it("stops a forceRespawnDaemon daemon when its Connector closes", async function () {
    context = createIntegrationContext("daemon-force-close", {
      multiplexerDaemonIdleTimeout: 30000,
    });
    const connector = context.createConnector({ forceRespawnDaemon: true });
    await connector.connectDevices(-1, null, false);
    const info = await waitFor(() => getUsableDiscovery(context.discovery));
    await connector.close();
    await waitFor(() => !processExists(info.pid), 2000);
  });

  it("finds an unreachable daemon by argv0 marker and force-stops only the exact match", async function () {
    context = createIntegrationContext("daemon-process-name-cleanup", {
      replacementTimeout: platformTimeout(100),
    });
    const daemonProcess = spawnIdleProcess(context.paths.daemonProcessName);
    const decoyProcess =
      process.platform === "win32"
        ? undefined
        : spawnIdleProcess(`${context.paths.daemonProcessName}-decoy`);

    try {
      await waitFor(() => processExists(daemonProcess.pid), 1000);
      if (decoyProcess) {
        await waitFor(() => processExists(decoyProcess.pid), 1000);
      }
      assert.strictEqual(fs.existsSync(context.paths.controlEndpoint), false);

      await context.manager.stopDaemonForDebugging();

      await waitFor(() => !processExists(daemonProcess.pid), 2000);
      if (decoyProcess) {
        assert.strictEqual(processExists(decoyProcess.pid), true);
      }
    } finally {
      await stopProcess(daemonProcess);
      await stopProcess(decoyProcess);
    }
  });

  it("isolates one control socket error from the daemon and other controls", async function () {
    context = createIntegrationContext("daemon-control-socket-error");
    await context.manager.ensureDaemon();
    const info = await waitFor(() => getUsableDiscovery(context.discovery));
    const failedClient = context.createClient();
    const healthyClient = context.createClient();
    await failedClient.connect();
    await healthyClient.connect();

    context.appendCommand({
      type: "emit-control-socket-error",
      message: "integration control socket error",
    });
    await waitFor(() => !failedClient.ready, 3000);

    assert(processExists(info.pid));
    assert.strictEqual(healthyClient.ready, true);
    assert.strictEqual(
      (await getHealth(context.paths.controlEndpoint)).body.ok,
      true
    );
    assert.deepStrictEqual(
      (
        await healthyClient.call("connectDevices", {
          isAutoListenClients: false,
        })
      ).map((device) => device.serial),
      ["device-1"]
    );
  });
});

function spawnIdleProcess(argv0) {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    argv0,
    stdio: "ignore",
  });
}

async function stopProcess(child) {
  if (!child?.pid || !processExists(child.pid)) {
    return;
  }
  try {
    process.kill(child.pid, "SIGTERM");
  } catch (_error) {}
  await waitFor(() => !processExists(child.pid), 1000).catch(() => {});
  if (!processExists(child.pid)) {
    return;
  }
  try {
    process.kill(child.pid, "SIGKILL");
  } catch (_error) {}
  await waitFor(() => !processExists(child.pid), 1000).catch(() => {});
}
