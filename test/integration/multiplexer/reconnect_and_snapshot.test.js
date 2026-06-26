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

describe("multiplexer integration reconnect and snapshot", function () {
  this.timeout(12000);

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("rejects pending RPCs when the daemon dies and rebuilds snapshot after stale cleanup and respawn", async function () {
    context = createIntegrationContext("reconnect-snapshot", {
      heartbeatInterval: 25,
      readyPollInterval: 10,
      replacementTimeout: 20,
      staleTimeout: 80,
      state: {
        responseDelayMs: 1000,
        devices: [
          {
            serial: "device-old",
            os: "Android",
            title: "Old Device",
            ports: [9001],
          },
        ],
        clients: [
          {
            id: 1,
            deviceId: "device-old",
            app: "OldApp",
            processName: "com.old",
            port: 9101,
          },
        ],
      },
    });

    const client = context.createClient({ rpcTimeout: 2000 });
    await client.connect();
    assert.deepStrictEqual(
      (await client.call("connectDevices", {
        timeout: -1,
        serial: null,
        isAutoListenClients: true,
      })).map((device) => device.serial),
      ["device-old"],
    );

    const initialInfo = await waitFor(
      () => context.discovery.getReusableDiscovery(),
      3000,
    );
    const pending = client.call("sendCustomizedMessage", {
      clientId: 1,
      method: "Runtime.evaluate",
      params: { marker: "pending-before-crash" },
      sessionId: 1,
      type: "CDP",
    });
    process.kill(initialInfo.pid, "SIGKILL");

    await assert.rejects(
      pending,
      /closed|socket|ECONNRESET|Multiplexer/i,
    );
    await waitFor(
      () => !processExists(initialInfo.pid),
      3000,
    );

    context.writeState({
      devices: [
        {
          serial: "device-new",
          os: "Android",
          title: "New Device",
          ports: [9201],
          host: "127.0.0.2",
        },
      ],
      clients: [
        {
          id: 2,
          deviceId: "device-new",
          app: "NewApp",
          processName: "com.new",
          port: 9202,
        },
      ],
    });

    await waitFor(() => {
      const stat = fs.existsSync(context.paths.daemonLockPath)
        ? fs.statSync(context.paths.daemonLockPath)
        : null;
      return !stat || Date.now() - stat.mtimeMs > 100;
    }, 3000);

    await client.reconnect();
    const nextInfo = await waitFor(
      () => context.discovery.getReusableDiscovery(),
      3000,
    );
    assert.notStrictEqual(nextInfo.pid, initialInfo.pid);
    assert.strictEqual(
      processExists(initialInfo.pid),
      false,
      "SIGKILLed daemon process should not remain alive after reconnect",
    );
    assert.strictEqual(
      processExists(nextInfo.pid),
      true,
      "new daemon process should be alive after reconnect",
    );
    assert.strictEqual(
      fs.existsSync(context.paths.daemonLockPath),
      true,
      "new daemon should recreate daemon.lock",
    );

    const devices = await client.call("connectDevices", {
      timeout: -1,
      serial: null,
      isAutoListenClients: true,
    });
    const clients = await client.call("connectUsbClients", {
      deviceId: "device-new",
      timeout: -1,
      waitTimeout: true,
      clientName: null,
    });

    assert.deepStrictEqual(devices, [
      {
        os: "Android",
        title: "New Device",
        serial: "device-new",
        ports: [9201],
        host: "127.0.0.2",
      },
    ]);
    assert.deepStrictEqual(
      clients.map((runtime) => runtime.id),
      [2],
    );

    const managers = Array.from({ length: 3 }, () =>
      context.createManager({
        readyPollInterval: 10,
        staleTimeout: 80,
      }),
    );
    const infos = await Promise.all(
      managers.map((manager) => manager.ensureDaemon()),
    );
    for (const info of infos) {
      assert.strictEqual(
        info.pid,
        nextInfo.pid,
        "all recovery managers should reuse the single new daemon",
      );
    }

    const startedPids = new Set(
      context
        .readLog()
        .filter((entry) => entry.event === "daemon-started")
        .map((entry) => entry.pid),
    );
    assert.deepStrictEqual(
      Array.from(startedPids).sort(),
      [initialInfo.pid, nextInfo.pid].sort(),
      "only the killed daemon and one replacement daemon should have started",
    );
  });

  it("clears connector websocket mirror on daemon loss and rebuilds it from desired state after respawn", async function () {
    context = createIntegrationContext("connector-wss-recovery", {
      heartbeatInterval: 25,
      readyPollInterval: 10,
      replacementTimeout: 20,
      staleTimeout: 80,
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "connector-wss-recovery",
      },
    });

    const connector = context.createConnector({
      enableWebSocket: true,
      rpcTimeout: 3000,
    });
    const disconnectedDevices = [];
    const disconnectedClients = [];
    connector.on("device-disconnected", (device) =>
      disconnectedDevices.push(device.serial),
    );
    connector.on("client-disconnected", (id) => disconnectedClients.push(id));

    await connector.connectDevices(-1, null, true);
    await connector.connectUsbClients("device-1", -1, true, null);
    connector.startWatchAllClients(false);
    await waitFor(() => connector.watchAllClientsStarted, 2000);
    await connector.startWSServer();

    const initialInfo = await waitFor(
      () => context.discovery.getReusableDiscovery(),
      3000,
    );
    assert.strictEqual(connector.desiredWSServerStarted, true);
    assert.strictEqual(connector.webSocketServerStarted, true);
    assert(connector.wssPort > 0, "websocket port should be assigned");
    assert.deepStrictEqual(connector.wss, {
      wssPath: `ws://${connector.wssHost}/mdevices/page/android`,
    });

    process.kill(initialInfo.pid, "SIGKILL");
    await waitFor(
      () =>
        connector.wss === null &&
        connector.webSocketServerStarted === false &&
        connector.devices.size === 0 &&
        connector.usbClients.size === 0,
      3000,
    );
    assert.strictEqual(connector.desiredWSServerStarted, true);
    assert.strictEqual(connector.desiredWatchAllClientsForce, false);
    assert.deepStrictEqual(disconnectedClients, [1]);
    assert.deepStrictEqual(disconnectedDevices, ["device-1"]);
    await waitFor(() => !processExists(initialInfo.pid), 3000);

    await waitFor(() => {
      const nextInfo = context.discovery.getReusableDiscovery();
      return (
        nextInfo?.pid !== initialInfo.pid &&
        processExists(nextInfo.pid) &&
        connector.watchAllClientsStarted &&
        connector.webSocketServerStarted &&
        connector.wss?.wssPath ===
          `ws://${connector.wssHost}/mdevices/page/android`
      );
    }, 5000);

    const nextInfo = await waitFor(() => {
      const info = context.discovery.getReusableDiscovery();
      if (info?.pid && info.pid !== initialInfo.pid) {
        return info;
      }
      return null;
    }, 3000);
    assert.notStrictEqual(nextInfo.pid, initialInfo.pid);
    assert.strictEqual(connector.desiredWSServerStarted, true);
    assert.strictEqual(connector.webSocketServerStarted, true);
    assert.deepStrictEqual(connector.wss, {
      wssPath: `ws://${connector.wssHost}/mdevices/page/android`,
    });
    assert.strictEqual(connector.watchAllClientsStarted, true);
  });
});
