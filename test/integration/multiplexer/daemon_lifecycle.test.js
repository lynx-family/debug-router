// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
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

  it("spawns a daemon, serves framed IPC Health, and creates no daemon.json", async function () {
    context = createIntegrationContext("daemon-lifecycle", {
      debugInfo: { daemonVersion: "integration-test-daemon" },
    });
    await context.manager.ensureDaemon();
    const info = await waitFor(() => getUsableDiscovery(context.discovery));

    assert(processExists(info.pid));
    assert.strictEqual(fs.existsSync(context.paths.daemonLockPath), true);
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
    await waitFor(() => !fs.existsSync(context.paths.daemonLockPath), 2000);
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
    await waitFor(() => !fs.existsSync(context.paths.daemonLockPath), 2000);
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
    await waitFor(() => !fs.existsSync(context.paths.daemonLockPath), 2000);
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
