// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");

const {
  createIntegrationContext,
  getHealth,
  processExists,
  readJsonFile,
  waitFor,
} = require("./helpers/integration_harness");

describe("multiplexer integration daemon lifecycle", function () {
  this.timeout(10000);

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
      daemonVersion: "integration-test-daemon",
      capabilities: ["fake-physical", "integration"],
    });

    const info = await context.manager.ensureDaemon();
    assert(processExists(info.pid), "daemon process should exist");
    assert.strictEqual(fs.existsSync(context.paths.discoveryPath), true);
    assert.strictEqual(fs.existsSync(context.paths.daemonLockPath), true);
    assert.strictEqual(info.protocolVersion > 0, true);
    assert.strictEqual(info.minSupportedProtocolVersion > 0, true);
    assert.strictEqual(info.controlPort > 0, true);
    assert.strictEqual(info.daemonVersion, "integration-test-daemon");
    assert.deepStrictEqual(info.capabilities, [
      "fake-physical",
      "integration",
    ]);

    const health = await getHealth(info.controlPort);
    assert.strictEqual(health.statusCode, 200);
    assert.strictEqual(health.body.pid, info.pid);
    assert.strictEqual(health.body.protocolVersion, info.protocolVersion);
    assert.strictEqual(
      health.body.minSupportedProtocolVersion,
      info.minSupportedProtocolVersion,
    );
    assert.strictEqual(health.body.daemonVersion, "integration-test-daemon");
    assert.deepStrictEqual(health.body.capabilities, [
      "fake-physical",
      "integration",
    ]);

    assert(
      context
        .readLog()
        .some(
          (entry) =>
            entry.event === "fake-physical-created" &&
            entry.devices === 1 &&
            entry.clients === 1,
        ),
      "fake physical should be created in the daemon process",
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
      ["device-1"],
    );
    assert.deepStrictEqual(
      snapshots[0].clients.map((runtime) => runtime.id),
      [1],
    );

    process.kill(info.pid, "SIGTERM");
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
      "fake physical connector should be closed during idle cleanup",
    );
  });
});
