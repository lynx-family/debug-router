// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");

const {
  createIntegrationContext,
  processExists,
  waitFor,
} = require("./helpers/integration_harness");
const {
  MultiOpenStatus,
} = require("../../../debug_router_connector/src/connector/MultiOpenCallBack");

describe("multiplexer integration legacy preemption", function () {
  this.timeout(12000);

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("notifies facades, clears mirrors, and reacquires the legacy owner", async function () {
    context = createIntegrationContext("legacy-preemption", {
      heartbeatInterval: 25,
      readyPollInterval: 10,
      staleTimeout: 500,
    });

    const connector = context.createConnector({ rpcTimeout: 3000 });
    const multiOpenStatuses = [];
    const disconnectedDevices = [];
    const disconnectedClients = [];
    connector.setMultiOpenCallback({
      statusChanged(status) {
        multiOpenStatuses.push(status);
      },
    });
    connector.on("device-disconnected", (device) =>
      disconnectedDevices.push(device.serial),
    );
    connector.on("client-disconnected", (id) => disconnectedClients.push(id));

    await connector.connectDevices(-1, null, true);
    await connector.connectUsbClients("device-1", -1, true, null);
    connector.startWatchAllClients(false);
    await waitFor(() => connector.watchAllClientsStarted, 2000);

    const daemonInfo = await waitFor(
      () => context.discovery.getReusableDiscovery(),
      3000,
    );
    assert(processExists(daemonInfo.pid), "daemon should be alive");
    await waitFor(
      () => readOwnerPid(context.legacyOwnerPath) === daemonInfo.pid,
      3000,
    );

    fs.mkdirSync(context.legacyDriverDir, { recursive: true });
    fs.writeFileSync(context.legacyOwnerPath, `${process.pid}`, "utf8");

    await waitFor(
      () => multiOpenStatuses.includes(MultiOpenStatus.unattached),
      3000,
    );
    await waitFor(
      () =>
        connector.devices.size === 0 &&
        connector.usbClients.size === 0 &&
        connector.watchAllClientsStarted === false,
      3000,
    );
    assert.deepStrictEqual(disconnectedClients, [1]);
    assert.deepStrictEqual(disconnectedDevices, ["device-1"]);
    assert.strictEqual(readOwnerPid(context.legacyOwnerPath), process.pid);

    context.appendCommand({
      type: "add-device",
      device: {
        serial: "device-2",
        os: "Android",
        title: "Preempted Device",
        ports: [9201],
      },
    });
    context.appendCommand({
      type: "add-client",
      client: {
        id: 2,
        deviceId: "device-2",
        app: "IgnoredWhilePreempted",
        processName: "com.preempted",
        port: 9202,
      },
    });
    await waitFor(() => {
      const log = context.readLog();
      return (
        log.some(
          (entry) =>
            entry.event === "device-added" && entry.serial === "device-2",
        ) &&
        log.some((entry) => entry.event === "client-added" && entry.id === 2)
      );
    }, 2000);
    assert.strictEqual(connector.devices.has("device-2"), false);
    assert.strictEqual(connector.usbClients.has(2), false);

    connector.startWatchAllClients(false);
    await waitFor(
      () =>
        multiOpenStatuses.includes(MultiOpenStatus.attached) &&
        connector.watchAllClientsStarted,
      3000,
    );
    assert.strictEqual(readOwnerPid(context.legacyOwnerPath), daemonInfo.pid);

    const devices = await connector.connectDevices(-1, null, true);
    const clients = await connector.connectUsbClients(
      "device-2",
      -1,
      true,
      null,
    );
    assert(
      devices.some((device) => device.serial === "device-2"),
      "device-2 should be discoverable after daemon reacquires legacy owner",
    );
    assert.deepStrictEqual(
      clients.map((client) => client.clientId()),
      [2],
    );
  });
});

function readOwnerPid(filePath) {
  try {
    return Number(fs.readFileSync(filePath, "utf8").trim());
  } catch (_error) {
    return undefined;
  }
}
