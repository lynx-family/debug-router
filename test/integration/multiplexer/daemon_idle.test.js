// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");

const {
  createIntegrationContext,
  delay,
  waitFor,
} = require("./helpers/integration_harness");

describe("multiplexer integration daemon idle", function () {
  this.timeout(10000);

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("keeps the daemon alive while a control client is connected and idles after disconnect", async function () {
    context = createIntegrationContext("daemon-idle-control", {
      heartbeatInterval: 25,
      multiplexerDaemonIdleTimeout: 80,
      staleTimeout: 500,
    });

    const client = context.createClient();
    await client.connect();
    const info = await waitFor(
      () => context.discovery.getReusableDiscovery(),
      3000,
    );
    assert(info, "daemon discovery should be usable after control connect");
    assert.strictEqual(fs.existsSync(context.paths.discoveryPath), true);
    assert.strictEqual(fs.existsSync(context.paths.daemonLockPath), true);

    await delay(180);
    assert.strictEqual(
      fs.existsSync(context.paths.discoveryPath),
      true,
      "active control client should suppress idle cleanup",
    );
    assert.strictEqual(
      fs.existsSync(context.paths.daemonLockPath),
      true,
      "active control client should keep daemon lock",
    );

    await client.close();
    await waitFor(() => !fs.existsSync(context.paths.discoveryPath), 2000);
    await waitFor(() => !fs.existsSync(context.paths.daemonLockPath), 2000);
    assert(
      context
        .readLog()
        .some((entry) => entry.event === "fake-physical-closed"),
      "fake physical connector should close after daemon idles",
    );
  });

  it("cancels and reschedules idle shutdown across repeated control connect and disconnect cycles", async function () {
    context = createIntegrationContext("daemon-idle-repeat", {
      heartbeatInterval: 25,
      multiplexerDaemonIdleTimeout: 120,
      staleTimeout: 500,
    });

    const first = context.createClient();
    await first.connect();
    const firstInfo = await waitFor(
      () => context.discovery.getReusableDiscovery(),
      3000,
    );
    assert(firstInfo, "first control connection should start a daemon");
    await first.close();

    await delay(60);
    const second = context.createClient();
    await second.connect();
    const secondInfo = await waitFor(
      () => context.discovery.getReusableDiscovery(),
      3000,
    );
    assert.strictEqual(
      secondInfo.pid,
      firstInfo.pid,
      "reconnecting before idle timeout should keep the same daemon",
    );
    await delay(150);
    assert.strictEqual(
      fs.existsSync(context.paths.discoveryPath),
      true,
      "second active control client should cancel the first idle timer",
    );
    await second.close();

    await delay(60);
    const third = context.createClient();
    await third.connect();
    const thirdInfo = await waitFor(
      () => context.discovery.getReusableDiscovery(),
      3000,
    );
    assert.strictEqual(
      thirdInfo.pid,
      firstInfo.pid,
      "third control connection should still reuse the same daemon",
    );
    await delay(150);
    assert.strictEqual(
      fs.existsSync(context.paths.discoveryPath),
      true,
      "third active control client should cancel the second idle timer",
    );
    await third.close();

    await waitFor(() => !fs.existsSync(context.paths.discoveryPath), 2000);
    await waitFor(() => !fs.existsSync(context.paths.daemonLockPath), 2000);
    assert.strictEqual(
      context
        .readLog()
        .filter((entry) => entry.event === "fake-physical-closed").length,
      1,
      "daemon resources should be cleaned exactly once after final idle",
    );
  });

  it("does not schedule idle shutdown when the daemon idle timeout is disabled", async function () {
    context = createIntegrationContext("daemon-idle-disabled", {
      heartbeatInterval: 25,
      staleTimeout: 500,
    });

    const info = await context.manager.ensureDaemon();
    assert(info.pid > 0);
    await delay(160);

    assert.strictEqual(fs.existsSync(context.paths.discoveryPath), true);
    assert.strictEqual(fs.existsSync(context.paths.daemonLockPath), true);
    assert.strictEqual(
      context
        .readLog()
        .some((entry) => entry.event === "fake-physical-closed"),
      false,
    );
  });
});
