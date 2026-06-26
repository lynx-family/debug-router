// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  connectDriverWebSocket,
  createCustomizedEnvelope,
  createIntegrationContext,
  parseCustomizedEnvelope,
  processExists,
  waitFor,
  waitForSocketMessage,
} = require("./helpers/integration_harness");

const COMMAND_FILE_NAME = "fake_physical_commands.jsonl";
const HIGH_PRESSURE_CONNECTOR_FRONTENDS = 100;
const HIGH_PRESSURE_WEBSOCKET_FRONTENDS = 100;
const HIGH_PRESSURE_CONNECTOR_MESSAGES = 500;
const HIGH_PRESSURE_WEBSOCKET_MESSAGES = 500;
const HIGH_PRESSURE_SETUP_BATCH_SIZE = 20;

describe("multiplexer integration stability, stress, and recovery", function () {
  this.timeout(120000);

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("keeps connector mirrors and RPC routing stable under repeated facade churn and parallel requests", async function () {
    context = createIntegrationContext("stability-facade-stress", {
      heartbeatInterval: 25,
      readyPollInterval: 10,
      staleTimeout: 500,
      state: createState({
        deviceCount: 2,
        clientCount: 4,
      }),
    });

    const connectors = Array.from({ length: 5 }, () => context.createConnector());
    const deviceLists = await Promise.all(
      connectors.map((connector) => connector.connectDevices(-1, null, true)),
    );
    for (const devices of deviceLists) {
      assert.deepStrictEqual(
        devices.map((device) => device.serial).sort(),
        ["device-1", "device-2"],
      );
    }

    await Promise.all(
      connectors.flatMap((connector) => [
        connector.connectUsbClients("device-1", -1, true, null),
        connector.connectUsbClients("device-2", -1, true, null),
      ]),
    );
    for (const connector of connectors) {
      assert.deepStrictEqual(
        Array.from(connector.usbClients.keys()).sort((a, b) => a - b),
        [1, 2, 3, 4],
      );
    }

    for (let round = 0; round < 6; round++) {
      const responses = await Promise.all(
        connectors.flatMap((connector, connectorIndex) =>
          Array.from(connector.usbClients.values()).map((client) => {
            const marker = `round-${round}-connector-${connectorIndex}-client-${client.clientId()}`;
            return client
              .sendClientMessage("Runtime.evaluate", { marker })
              .then((response) => ({
                marker,
                response: JSON.parse(response),
              }));
          }),
        ),
      );

      for (const { marker, response } of responses) {
        assert.deepStrictEqual(response.result.params, { marker });
      }
    }

    await Promise.all([connectors[1].close(), connectors[3].close()]);

    context.appendCommand({
      type: "add-client",
      client: {
        id: 5,
        deviceId: "device-2",
        app: "DynamicStress",
        processName: "com.dynamic.stress",
        port: 9205,
      },
    });
    await waitFor(
      () =>
        connectors[0].usbClients.has(5) &&
        connectors[2].usbClients.has(5) &&
        connectors[4].usbClients.has(5),
      2000,
    );

    const activeConnectors = [connectors[0], connectors[2], connectors[4]];
    const activeResponses = await Promise.all(
      activeConnectors.map((connector, index) =>
        connector.usbClients
          .get(5)
          .sendClientMessage("Runtime.evaluate", {
            marker: `active-after-churn-${index}`,
          })
          .then((response) => JSON.parse(response)),
      ),
    );
    assert.deepStrictEqual(
      activeResponses.map((response) => response.result.params.marker),
      [
        "active-after-churn-0",
        "active-after-churn-1",
        "active-after-churn-2",
      ],
    );
    assert.strictEqual(startedDaemonPids().size, 1);
  });

  it("keeps WebSocket frontend routing isolated during repeated concurrent requests and frontend churn", async function () {
    context = createIntegrationContext("stability-websocket-stress", {
      heartbeatInterval: 25,
      readyPollInterval: 10,
      staleTimeout: 500,
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "stability-websocket-stress",
      },
      state: createState({
        deviceCount: 1,
        clientCount: 2,
      }),
    });

    const connector = context.createConnector({ enableWebSocket: true });
    await connector.connectDevices(-1, null, true);
    await connector.connectUsbClients("device-1", -1, true, null);
    await connector.startWSServer();

    const url = `ws://127.0.0.1:${connector.wssPort}/mdevices/page/android`;
    const frontends = [];
    for (const app of ["driver-a", "driver-b", "driver-c"]) {
      const frontend = await connectDriverWebSocket(url, { app });
      context.trackSocket(frontend.socket);
      frontends.push({ app, ...frontend });
    }
    await waitForClientIds(frontends, [1, 2]);

    for (let round = 0; round < 5; round++) {
      const waits = frontends.map(({ app, socket }) => {
        const marker = `${app}-round-${round}`;
        return waitForSocketMessage(socket, (value) => {
          if (value?.event !== "Customized") {
            return false;
          }
          return (
            parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
              ?.marker === marker
          );
        }).then((message) => ({
          marker,
          response: parseCustomizedEnvelope(message.text).cdp,
        }));
      });

      for (const { app, socket } of frontends) {
        socket.send(createCustomizedEnvelope(1, 7, `${app}-round-${round}`));
      }

      const responses = await Promise.all(waits);
      assert.deepStrictEqual(
        responses.map(({ response }) => response.id),
        [7, 7, 7],
      );
      assert.deepStrictEqual(
        responses.map(({ response }) => response.result.params.marker),
        frontends.map(({ app }) => `${app}-round-${round}`),
      );
    }

    frontends[1].socket.close();
    await waitFor(
      () =>
        context
          .readLog()
          .some((entry) => entry.event === "client-send-message"),
      2000,
    );

    const replacement = await connectDriverWebSocket(url, {
      app: "driver-b-reconnected",
    });
    context.trackSocket(replacement.socket);
    frontends[1] = { app: "driver-b-reconnected", ...replacement };
    await waitForClientIds(frontends, [1, 2]);

    const waits = frontends.map(({ app, socket }, index) =>
      waitForSocketMessage(socket, (value) => {
        if (value?.event !== "Customized") {
          return false;
        }
        return (
          parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
            ?.marker === `${app}-after-churn-${index}`
        );
      }),
    );
    frontends.forEach(({ app, socket }, index) => {
      socket.send(createCustomizedEnvelope(2, 9, `${app}-after-churn-${index}`));
    });

    const messages = await Promise.all(waits);
    assert.deepStrictEqual(
      messages.map(
        (message) => parseCustomizedEnvelope(message.text).cdp.result.params,
      ),
      frontends.map(({ app }, index) => ({
        marker: `${app}-after-churn-${index}`,
      })),
    );
    assert.strictEqual(startedDaemonPids().size, 1);
  });

  it("handles three-digit connector and WebSocket frontends with four-digit concurrent routed messages", async function () {
    context = createIntegrationContext("stability-combined-high-pressure", {
      heartbeatInterval: 25,
      readyPollInterval: 10,
      staleTimeout: 500,
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "stability-combined-high-pressure",
      },
      state: createState({
        deviceCount: 2,
        clientCount: 4,
      }),
    });

    const connectors = Array.from(
      { length: HIGH_PRESSURE_CONNECTOR_FRONTENDS },
      () => context.createConnector({ enableWebSocket: true }),
    );
    await runInBatches(connectors, HIGH_PRESSURE_SETUP_BATCH_SIZE, (connector) =>
      connector.connectDevices(-1, null, true),
    );
    await runInBatches(connectors, HIGH_PRESSURE_SETUP_BATCH_SIZE, (connector) =>
      Promise.all([
        connector.connectUsbClients("device-1", -1, true, null),
        connector.connectUsbClients("device-2", -1, true, null),
      ]),
    );

    for (const connector of connectors) {
      assert.deepStrictEqual(
        Array.from(connector.devices.keys()).sort(),
        ["device-1", "device-2"],
      );
      assert.deepStrictEqual(
        Array.from(connector.usbClients.keys()).sort((a, b) => a - b),
        [1, 2, 3, 4],
      );
    }

    await connectors[0].startWSServer();
    const url = `ws://127.0.0.1:${connectors[0].wssPort}/mdevices/page/android`;
    const frontends = await runInBatches(
      Array.from(
        { length: HIGH_PRESSURE_WEBSOCKET_FRONTENDS },
        (_unused, index) => index,
      ),
      HIGH_PRESSURE_SETUP_BATCH_SIZE,
      async (index) => {
        const frontend = await connectDriverWebSocket(url, {
          app: `high-pressure-driver-${index}`,
        });
        context.trackSocket(frontend.socket);
        return {
          app: `high-pressure-driver-${index}`,
          ...frontend,
        };
      },
    );
    await waitForClientIds(frontends, [1, 2, 3, 4]);

    const connectorRequests = Array.from(
      { length: HIGH_PRESSURE_CONNECTOR_MESSAGES },
      (_unused, index) => {
        const connector = connectors[index % connectors.length];
        const clientId = (index % 4) + 1;
        const marker = `connector-message-${index}`;
        return connector.usbClients
          .get(clientId)
          .sendClientMessage("Runtime.evaluate", { marker })
          .then((response) => ({
            marker,
            response: JSON.parse(response),
          }));
      },
    );

    const websocketRequests = Array.from(
      { length: HIGH_PRESSURE_WEBSOCKET_MESSAGES },
      (_unused, index) => {
        const frontend = frontends[index % frontends.length];
        const clientId = (index % 4) + 1;
        const marker = `websocket-message-${index}`;
        const wait = waitForSocketMessage(
          frontend.socket,
          (value) =>
            value?.event === "Customized" &&
            parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
              ?.marker === marker,
          10000,
        ).then((message) => ({
          marker,
          response: parseCustomizedEnvelope(message.text).cdp,
        }));

        frontend.socket.send(createCustomizedEnvelope(clientId, 77, marker));
        return wait;
      },
    );

    const [connectorResponses, websocketResponses] = await Promise.all([
      Promise.all(connectorRequests),
      Promise.all(websocketRequests),
    ]);

    assert.strictEqual(
      connectorResponses.length + websocketResponses.length,
      HIGH_PRESSURE_CONNECTOR_MESSAGES + HIGH_PRESSURE_WEBSOCKET_MESSAGES,
    );
    assert.deepStrictEqual(
      connectorResponses.map(({ marker, response }) => [
        marker,
        response.result.params.marker,
      ]),
      connectorResponses.map(({ marker }) => [marker, marker]),
    );
    assert.deepStrictEqual(
      websocketResponses.map(({ marker, response }) => [
        marker,
        response.id,
        response.result.params.marker,
      ]),
      websocketResponses.map(({ marker }) => [marker, 77, marker]),
    );
    assert.strictEqual(startedDaemonPids().size, 1);
  });

  it("recovers from daemon-side uncaught exceptions and continues serving concurrent connector traffic", async function () {
    context = createIntegrationContext("stability-exception-recovery", {
      heartbeatInterval: 25,
      readyPollInterval: 10,
      replacementTimeout: 20,
      staleTimeout: 80,
      state: {
        ...createState({
          deviceCount: 1,
          clientCount: 1,
        }),
        responseDelayMs: 1000,
      },
    });

    const connector = context.createConnector();
    await connector.connectDevices(-1, null, true);
    const [client] = await connector.connectUsbClients(
      "device-1",
      -1,
      true,
      null,
    );
    const initialInfo = await waitFor(
      () => context.discovery.getReusableDiscovery(),
      3000,
    );

    const pending = client.sendClientMessage("Runtime.evaluate", {
      marker: "pending-before-exception",
    });
    context.appendCommand({
      type: "throw-uncaught-error",
      message: "integration forced daemon exception",
    });

    await assert.rejects(pending, /closed|socket|Multiplexer/i);
    await waitFor(() => !processExists(initialInfo.pid), 3000);
    await waitFor(
      () =>
        !fs.existsSync(context.paths.discoveryPath) &&
        !fs.existsSync(context.paths.daemonLockPath),
      3000,
    );
    truncateCommandLog(context);

    assert(
      context
        .readLog()
        .some(
          (entry) =>
            entry.event === "daemon-uncaught-exception" &&
            entry.message === "integration forced daemon exception",
        ),
      "daemon should log the forced uncaught exception before cleanup",
    );

    context.writeState(
      createState({
        deviceCount: 1,
        clientCount: 3,
        firstClientId: 10,
      }),
    );

    const recoveredDevices = await connector.connectDevices(-1, null, true);
    assert.deepStrictEqual(
      recoveredDevices.map((device) => device.serial),
      ["device-1"],
    );
    const replacementInfo = await waitFor(() => {
      const info = context.discovery.getReusableDiscovery();
      if (
        info?.pid &&
        info.pid !== initialInfo.pid &&
        processExists(info.pid)
      ) {
        return info;
      }
      return null;
    }, 3000);

    const connectors = [
      connector,
      context.createConnector(),
      context.createConnector(),
    ];
    await Promise.all(
      connectors.map((candidate) => candidate.connectDevices(-1, null, true)),
    );
    await Promise.all(
      connectors.map((candidate) =>
        candidate.connectUsbClients("device-1", -1, true, null),
      ),
    );
    for (const candidate of connectors) {
      assert.deepStrictEqual(
        Array.from(candidate.usbClients.keys()).sort((a, b) => a - b),
        [10, 11, 12],
      );
    }

    const responses = await Promise.all(
      connectors.flatMap((candidate, connectorIndex) =>
        Array.from(candidate.usbClients.values()).map((runtime) => {
          const marker = `recovered-${connectorIndex}-${runtime.clientId()}`;
          return runtime
            .sendClientMessage("Runtime.evaluate", { marker })
            .then((response) => JSON.parse(response));
        }),
      ),
    );
    assert.deepStrictEqual(
      responses.map((response) => response.result.params.marker).sort(),
      [
        "recovered-0-10",
        "recovered-0-11",
        "recovered-0-12",
        "recovered-1-10",
        "recovered-1-11",
        "recovered-1-12",
        "recovered-2-10",
        "recovered-2-11",
        "recovered-2-12",
      ],
    );

    assert.deepStrictEqual(
      Array.from(startedDaemonPids()).sort(),
      [initialInfo.pid, replacementInfo.pid].sort(),
    );
  });

  function startedDaemonPids() {
    return new Set(
      context
        .readLog()
        .filter((entry) => entry.event === "daemon-started")
        .map((entry) => entry.pid),
    );
  }
});

function createState({ deviceCount, clientCount, firstClientId = 1 }) {
  const devices = Array.from({ length: deviceCount }, (_unused, index) => {
    const id = index + 1;
    return {
      serial: `device-${id}`,
      os: "Android",
      title: `Pixel ${id}`,
      ports: [9000 + id],
      host: "127.0.0.1",
    };
  });
  const clients = Array.from({ length: clientCount }, (_unused, index) => {
    const id = firstClientId + index;
    const deviceId = devices[index % devices.length].serial;
    return {
      id,
      deviceId,
      app: `Demo ${id}`,
      os: "Android",
      device: `Pixel ${deviceId}`,
      deviceModel: `Pixel ${deviceId}`,
      processName: `com.demo.${id}`,
      appName: `Demo ${id}`,
      port: 9100 + id,
    };
  });

  return {
    devices,
    clients,
  };
}

async function waitForClientIds(frontends, expectedIds) {
  const expected = [...expectedIds].sort((first, second) => first - second);
  await waitFor(
    () =>
      frontends.every((frontend) => arraysEqual(latestClientIds(frontend), expected)),
    3000,
  );
}

function latestClientIds(frontend) {
  const clientLists = frontend.messages.filter(
    (message) => message?.event === "ClientList",
  );
  if (clientLists.length === 0) {
    return [];
  }
  return clientLists[clientLists.length - 1].data
    .map((client) => client.id)
    .sort((first, second) => first - second);
}

function arraysEqual(first, second) {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

async function runInBatches(items, batchSize, task) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map((item) => task(item)));
    results.push(...batchResults);
  }
  return results;
}

function truncateCommandLog(context) {
  fs.writeFileSync(path.join(context.paths.dataDir, COMMAND_FILE_NAME), "");
}
