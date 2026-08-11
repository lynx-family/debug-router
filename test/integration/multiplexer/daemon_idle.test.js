// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const {
  createIntegrationContext,
  delay,
  getUsableDiscovery,
  platformTimeout,
  processExists,
  waitFor,
} = require("./helpers/integration_harness");

describe("multiplexer integration daemon idle", function () {
  this.timeout(platformTimeout(10000));

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("keeps the daemon alive while a control client is connected and idles after disconnect", async function () {
    context = createIntegrationContext("daemon-idle-control", {
      multiplexerDaemonIdleTimeout: 80,
    });

    const client = context.createClient();
    await client.connect();
    const info = await waitFor(
      () => getUsableDiscovery(context.discovery),
      3000
    );
    assert(info, "daemon discovery should be usable after control connect");
    assert.strictEqual(processExists(info.pid), true);

    await delay(180);
    assert.strictEqual(
      processExists(info.pid),
      true,
      "active control client should keep daemon alive"
    );

    await client.close();
    await waitFor(() => !processExists(info.pid), 2000);
    assert(
      context.readLog().some((entry) => entry.event === "fake-physical-closed"),
      "fake physical connector should close after daemon idles"
    );
  });

  it("cancels and reschedules idle shutdown across repeated control connect and disconnect cycles", async function () {
    context = createIntegrationContext("daemon-idle-repeat", {
      multiplexerDaemonIdleTimeout: 120,
    });

    const first = context.createClient();
    await first.connect();
    const firstInfo = await waitFor(
      () => getUsableDiscovery(context.discovery),
      3000
    );
    assert(firstInfo, "first control connection should start a daemon");
    await first.close();

    await delay(60);
    const second = context.createClient();
    await second.connect();
    const secondInfo = await waitFor(
      () => getUsableDiscovery(context.discovery),
      3000
    );
    assert.strictEqual(
      secondInfo.pid,
      firstInfo.pid,
      "reconnecting before idle timeout should keep the same daemon"
    );
    await delay(150);
    assert.strictEqual(
      processExists(firstInfo.pid),
      true,
      "second active control client should cancel the first idle timer"
    );
    await second.close();

    await delay(60);
    const third = context.createClient();
    await third.connect();
    const thirdInfo = await waitFor(
      () => getUsableDiscovery(context.discovery),
      3000
    );
    assert.strictEqual(
      thirdInfo.pid,
      firstInfo.pid,
      "third control connection should still reuse the same daemon"
    );
    await delay(150);
    assert.strictEqual(
      processExists(firstInfo.pid),
      true,
      "third active control client should cancel the second idle timer"
    );
    await third.close();

    await waitFor(() => !processExists(firstInfo.pid), 2000);
    assert.strictEqual(
      context
        .readLog()
        .filter((entry) => entry.event === "fake-physical-closed").length,
      1,
      "daemon resources should be cleaned exactly once after final idle"
    );
  });

  it("does not schedule idle shutdown when the daemon idle timeout is disabled", async function () {
    context = createIntegrationContext("daemon-idle-disabled", {});

    await context.manager.ensureDaemon();
    const info = await waitFor(() => getUsableDiscovery(context.discovery));
    assert(info.pid > 0);
    await delay(160);

    assert.strictEqual(processExists(info.pid), true);
    assert.strictEqual(
      context.readLog().some((entry) => entry.event === "fake-physical-closed"),
      false
    );
  });
});
