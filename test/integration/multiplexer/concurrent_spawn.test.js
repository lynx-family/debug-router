// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");

const {
  assertSamePid,
  createIntegrationContext,
  platformTimeout,
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
      heartbeatInterval: 25,
      readyPollInterval: 10,
      staleTimeout: 500,
    });

    const managers = Array.from({ length: 6 }, () =>
      context.createManager({
        readyPollInterval: 10,
        staleTimeout: 500,
      }),
    );

    const infos = await Promise.all(
      managers.map((manager) => manager.ensureDaemon()),
    );
    const pid = assertSamePid(infos);
    assert(Number.isInteger(pid));
    assert.strictEqual(fs.existsSync(context.paths.spawnLockPath), false);
    assert.strictEqual(fs.existsSync(context.paths.daemonLockPath), true);

    const log = context.readLog();
    assert.strictEqual(
      log.filter((entry) => entry.event === "daemon-entry-start").length,
      1,
    );
    assert.strictEqual(
      log.filter((entry) => entry.event === "daemon-started").length,
      1,
    );
  });

  it("makes later managers reuse the daemon created by the first manager", async function () {
    context = createIntegrationContext("sequential-reuse", {
      heartbeatInterval: 25,
      staleTimeout: 500,
    });

    const first = await context.manager.ensureDaemon();
    const secondManager = context.createManager();
    const thirdManager = context.createManager();
    const [second, third] = await Promise.all([
      secondManager.ensureDaemon(),
      thirdManager.ensureDaemon(),
    ]);

    assert.strictEqual(second.pid, first.pid);
    assert.strictEqual(third.pid, first.pid);
    assert.strictEqual(
      context
        .readLog()
        .filter((entry) => entry.event === "daemon-entry-start").length,
      1,
    );
  });
});
