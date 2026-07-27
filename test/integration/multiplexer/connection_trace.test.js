// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  createIntegrationContext,
  platformTimeout,
  waitFor,
} = require("./helpers/integration_harness");

const TRACE_DAEMON_IDLE_TIMEOUT_MS = 1000;

describe("multiplexer integration connection trace", function () {
  this.timeout(platformTimeout(10000));

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("writes one daemon-owned trace file without connector trace APIs", async function () {
    context = createIntegrationContext("connection-trace", {
      heartbeatInterval: 25,
      staleTimeout: 500,
      multiplexerDaemonIdleTimeout: TRACE_DAEMON_IDLE_TIMEOUT_MS,
    });
    const tracePath = path.join(context.rootDir, "connection-trace.ndjson");
    const first = context.createConnector({
      connectionTrace: {
        enabled: true,
        output: tracePath,
      },
    });

    // The first operation starts the daemon, so this connector's trace option
    // becomes the daemon-global startup configuration.
    await first.connectDevices(-1, null, true);

    const second = context.createConnector();
    await second.connectDevices(-1, null, true);
    context.appendCommand({
      type: "record-client-watch-start",
      deviceId: "device-1",
      source: "integration-test",
    });

    await waitFor(
      () =>
        fs.existsSync(tracePath) &&
        fs.readFileSync(tracePath, "utf8").includes("integration-test"),
      3000
    );

    await first.close();
    await second.close();

    await waitFor(
      () =>
        fs.existsSync(tracePath) &&
        fs.readFileSync(tracePath, "utf8").includes("daemon_stopped"),
      3000
    );

    const trace = fs
      .readFileSync(tracePath, "utf8")
      .split(/\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const recorded = trace.filter(
      (node) =>
        node.event === "client_watch_started" &&
        node.metadata?.source === "integration-test"
    );
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0].deviceId, "device-1");
    assert.deepStrictEqual(recorded[0].metadata, {
      source: "integration-test",
    });
    const coreLifecycleEvents = new Set([
      "daemon_started",
      "control_socket_connected",
      "client_watch_started",
      "control_socket_disconnected",
      "daemon_idle_timeout_reached",
      "daemon_stopped",
    ]);
    assert.deepStrictEqual(
      trace
        .map((node) => node.event)
        .filter((event) => coreLifecycleEvents.has(event)),
      [
        "daemon_started",
        "control_socket_connected",
        "control_socket_connected",
        "client_watch_started",
        "control_socket_disconnected",
        "control_socket_disconnected",
        "daemon_idle_timeout_reached",
        "daemon_stopped",
      ]
    );
    assert.deepStrictEqual(
      trace.find((node) => node.event === "daemon_idle_timeout_reached")
        .metadata,
      {
        idleTimeout: TRACE_DAEMON_IDLE_TIMEOUT_MS,
      }
    );
    assert.strictEqual(
      trace.find((node) => node.event === "daemon_stopped").metadata.reason,
      "idle_timeout"
    );
    assert.deepStrictEqual(
      trace
        .filter((node) => node.event === "control_socket_connected")
        .map((node) => node.metadata.activeControlCount),
      [1, 2]
    );
    assert.deepStrictEqual(
      trace
        .filter((node) => node.event === "control_socket_disconnected")
        .map((node) => node.metadata.activeControlCount),
      [1, 0]
    );
    assert.deepStrictEqual(
      trace.map((node) => node.sequence),
      trace.map((_node, index) => index + 1)
    );
  });
});
