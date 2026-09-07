// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");

const {
  connectDriverWebSocket,
  connectRuntimeWebSocket,
  createIntegrationContext,
  getUsableDiscovery,
  platformTimeout,
  processExists,
  waitFor,
} = require("./helpers/integration_harness");
const {
  MultiOpenStatus,
} = require("../../../debug_router_connector/dist/cjs/src/connector/MultiOpenCallBack");

describe("multiplexer integration legacy preemption", function () {
  this.timeout(platformTimeout(12000));

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("preserves Driver mirrors, removes devices and USB/WiFi runtimes, and reacquires the legacy owner", async function () {
    context = createIntegrationContext("legacy-preemption", {
      readyPollInterval: 10,
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "legacy-preemption",
      },
    });

    const connector = context.createConnector({
      rpcTimeout: 3000,
      enableWebSocket: true,
    });
    const multiOpenStatuses = [];
    const disconnectedDevices = [];
    const disconnectedClients = [];
    const disconnectedWifiRuntimes = [];
    const disconnectedDrivers = [];
    connector.setMultiOpenCallback({
      statusChanged(status) {
        multiOpenStatuses.push(status);
      },
    });
    connector.on("device-disconnected", (device) =>
      disconnectedDevices.push(device.serial)
    );
    connector.on("client-disconnected", (id) => disconnectedClients.push(id));
    connector.on("websocket-app-client-disconnected", (id) =>
      disconnectedWifiRuntimes.push(id)
    );
    connector.on("websocket-web-client-disconnected", (id) =>
      disconnectedDrivers.push(id)
    );

    await connector.connectDevices(-1, null, true);
    const initialWatchCount = countLogEvents(
      context,
      "device-start-watch"
    );
    connector.startWatchAllClients(false);
    await waitFor(
      () =>
        countLogEvents(context, "device-start-watch") > initialWatchCount,
      2000
    );
    await connector.connectUsbClients("device-1", -1, true, null);
    await connector.startWSServer();
    const websocketUrl = `ws://127.0.0.1:${connector.wssPort}/mdevices/page/android`;
    const runtime = await connectRuntimeWebSocket(websocketUrl, {
      app: "ownership-wifi-runtime",
    });
    const driver = await connectDriverWebSocket(websocketUrl, {
      app: "ownership-driver",
    });
    context.trackSocket(runtime.socket);
    context.trackSocket(driver.socket);
    await waitFor(
      () =>
        connector
          .getAllWebsocketAppClients()
          .some((client) => client.clientId() === runtime.id) &&
        connector.websocketWebClients.has(driver.id),
      2000
    );

    const daemonInfo = await waitFor(
      () => getUsableDiscovery(context.discovery),
      3000
    );
    assert(processExists(daemonInfo.pid), "daemon should be alive");
    await waitFor(
      () => readOwnerPid(context.legacyOwnerPath) === daemonInfo.pid,
      3000
    );

    fs.mkdirSync(context.legacyDriverDir, { recursive: true });
    fs.writeFileSync(context.legacyOwnerPath, `${process.pid}`, "utf8");

    await waitFor(
      () => multiOpenStatuses.includes(MultiOpenStatus.unattached),
      3000
    );
    await waitFor(() => connector.devices.size === 0, 3000);
    await waitFor(() => connector.usbClients.size === 0, 3000);
    await waitFor(
      () => countLogEvents(context, "disable-all-clients") > 0,
      3000
    );
    await waitFor(
      () => connector.getAllWebsocketAppClients().length === 0,
      3000
    );
    await waitFor(() => connector.websocketWebClients.has(driver.id), 3000);
    assert.deepStrictEqual(disconnectedClients, [1]);
    assert.deepStrictEqual(disconnectedDevices, ["device-1"]);
    assert.deepStrictEqual(disconnectedWifiRuntimes, [runtime.id]);
    assert.deepStrictEqual(disconnectedDrivers, []);
    await waitFor(() => runtime.socket.readyState === 3, 2000);
    assert.strictEqual(driver.socket.readyState, 1);

    const clientListCount = driver.messages.filter(
      (message) => message?.event === "ClientList"
    ).length;
    driver.socket.send(JSON.stringify({ event: "ListClients" }));
    const emptyClientList = await waitFor(() => {
      const lists = driver.messages.filter(
        (message) => message?.event === "ClientList"
      );
      return lists.length > clientListCount ? lists[lists.length - 1] : null;
    }, 2000);
    assert.deepStrictEqual(emptyClientList.data, []);
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
            entry.event === "device-added" && entry.serial === "device-2"
        ) &&
        log.some((entry) => entry.event === "client-added" && entry.id === 2)
      );
    }, 2000);
    assert.strictEqual(connector.devices.has("device-2"), false);
    assert.strictEqual(connector.usbClients.has(2), false);

    const reacquireWatchCount = countLogEvents(
      context,
      "device-start-watch"
    );
    connector.startWatchAllClients(false);
    await waitFor(
      () =>
        multiOpenStatuses.includes(MultiOpenStatus.attached) &&
        connector.devices.has("device-2") &&
        connector.usbClients.has(2) &&
        countLogEvents(context, "device-start-watch") > reacquireWatchCount,
      3000
    );
    assert.strictEqual(readOwnerPid(context.legacyOwnerPath), daemonInfo.pid);

    const devices = await connector.connectDevices(-1, null, true);
    const clients = await connector.connectUsbClients(
      "device-2",
      -1,
      true,
      null
    );
    assert(
      devices.some((device) => device.serial === "device-2"),
      "device-2 should be discoverable after daemon reacquires legacy owner"
    );
    assert.deepStrictEqual(
      clients.map((client) => client.clientId()),
      [2]
    );
    const recoveredClientListCount = driver.messages.filter(
      (message) => message?.event === "ClientList"
    ).length;
    driver.socket.send(JSON.stringify({ event: "ListClients" }));
    const recoveredClientList = await waitFor(() => {
      const lists = driver.messages.filter(
        (message) => message?.event === "ClientList"
      );
      return lists.length > recoveredClientListCount
        ? lists[lists.length - 1]
        : null;
    }, 2000);
    assert.deepStrictEqual(
      recoveredClientList.data.map((client) => [
        client.id,
        client.info.network,
      ]),
      [[2, "USB"]]
    );
    assert.strictEqual(driver.socket.readyState, 1);
  });
});

function readOwnerPid(filePath) {
  try {
    return Number(fs.readFileSync(filePath, "utf8").trim());
  } catch (_error) {
    return undefined;
  }
}

function countLogEvents(context, event) {
  return context.readLog().filter((entry) => entry.event === event).length;
}
