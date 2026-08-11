// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");

const {
  createIntegrationContext,
  getUsableDiscovery,
  platformTimeout,
  waitFor,
} = require("./helpers/integration_harness");

describe("multiplexer integration concurrent spawn", function () {
  this.timeout(platformTimeout(10000));

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("serializes concurrent ensureDaemon calls so only one detached daemon becomes ready", async function () {
    context = createIntegrationContext("concurrent-spawn", {
      readyPollInterval: 10,
    });

    const managers = Array.from({ length: 6 }, () =>
      context.createManager({
        readyPollInterval: 10,
      })
    );

    await Promise.all(managers.map((manager) => manager.ensureDaemon()));
    const daemon = await waitFor(
      () => getUsableDiscovery(context.discovery),
      3000
    );
    assert(Number.isInteger(daemon.pid));
    assert.strictEqual(fs.existsSync(context.paths.spawnLockPath), false);
    assert.strictEqual(Object.hasOwn(context.paths, "daemonLockPath"), false);

    const log = context.readLog();
    assert.strictEqual(
      log.filter((entry) => entry.event === "daemon-entry-start").length,
      1
    );
    assert.strictEqual(
      log.filter((entry) => entry.event === "daemon-started").length,
      1
    );
  });

  it("makes later managers reuse the daemon created by the first manager", async function () {
    context = createIntegrationContext("sequential-reuse");

    await context.manager.ensureDaemon();
    const firstDaemon = await waitFor(
      () => getUsableDiscovery(context.discovery),
      3000
    );
    const secondManager = context.createManager();
    const thirdManager = context.createManager();
    await Promise.all([
      secondManager.ensureDaemon(),
      thirdManager.ensureDaemon(),
    ]);
    assert.strictEqual(
      getUsableDiscovery(context.discovery).pid,
      firstDaemon.pid
    );
    assert.strictEqual(
      context.readLog().filter((entry) => entry.event === "daemon-entry-start")
        .length,
      1
    );
  });
});
