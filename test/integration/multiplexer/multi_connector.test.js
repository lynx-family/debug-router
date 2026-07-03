// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

const {
  collectConnectorEvents,
  createIntegrationContext,
  parseCustomizedEnvelope,
  platformTimeout,
  waitFor,
} = require("./helpers/integration_harness");

describe("multiplexer integration multi connector", function () {
  this.timeout(platformTimeout(10000));

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("shares one daemon across connector facades and keeps device/client mirrors consistent", async function () {
    context = createIntegrationContext("multi-connector", {
      heartbeatInterval: 25,
      staleTimeout: 500,
    });

    const first = context.createConnector();
    const second = context.createConnector();

    const firstDevices = await first.connectDevices(-1, null, true);
    const secondDevices = await second.connectDevices(-1, null, true);
    assert.deepStrictEqual(
      firstDevices.map((device) => device.serial),
      ["device-1"],
    );
    assert.deepStrictEqual(
      secondDevices.map((device) => device.serial),
      ["device-1"],
    );

    const [firstClients, secondClients] = await Promise.all([
      first.connectUsbClients("device-1", -1, true, null),
      second.connectUsbClients("device-1", -1, true, null),
    ]);
    assert.deepStrictEqual(
      firstClients.map((client) => client.clientId()),
      [1],
    );
    assert.deepStrictEqual(
      secondClients.map((client) => client.clientId()),
      [1],
    );
    assert.strictEqual(first.usbClients.get(1), firstClients[0]);
    assert.strictEqual(second.usbClients.get(1), secondClients[0]);
    assert.notStrictEqual(first.usbClients.get(1), second.usbClients.get(1));

    const log = context.readLog();
    const startedPids = new Set(
      log
        .filter((entry) => entry.event === "daemon-started")
        .map((entry) => entry.pid),
    );
    assert.strictEqual(startedPids.size, 1);
  });

  it("broadcasts physical client and USB message events to every connected facade", async function () {
    context = createIntegrationContext("multi-connector-events", {
      heartbeatInterval: 25,
      staleTimeout: 500,
    });

    const first = context.createConnector();
    const second = context.createConnector();
    await Promise.all([
      first.connectDevices(-1, null, true),
      second.connectDevices(-1, null, true),
    ]);

    const firstConnected = collectConnectorEvents(first, "client-connected");
    const secondConnected = collectConnectorEvents(second, "client-connected");
    const firstMessages = collectConnectorEvents(first, "usb-client-message");
    const secondMessages = collectConnectorEvents(second, "usb-client-message");

    context.appendCommand({
      type: "add-client",
      client: {
        id: 2,
        deviceId: "device-1",
        app: "Dynamic",
        processName: "com.dynamic",
        port: 9102,
      },
    });

    await waitFor(
      () => first.usbClients.has(2) && second.usbClients.has(2),
      2000,
    );
    assert.deepStrictEqual(
      firstConnected.map((client) => client.clientId()),
      [2],
    );
    assert.deepStrictEqual(
      secondConnected.map((client) => client.clientId()),
      [2],
    );

    const notification = JSON.stringify({
      event: "Customized",
      data: {
        type: "CDP",
        data: {
          message: JSON.stringify({
            method: "Runtime.consoleAPICalled",
            params: { marker: "broadcast" },
          }),
        },
        sender: 0,
      },
    });
    context.appendCommand({
      type: "emit-usb-message",
      id: 2,
      message: notification,
    });

    await waitFor(
      () => firstMessages.length === 1 && secondMessages.length === 1,
      2000,
    );
    assert.strictEqual(firstMessages[0].id, 2);
    assert.strictEqual(secondMessages[0].id, 2);
    assert.deepStrictEqual(
      parseCustomizedEnvelope(firstMessages[0].message).cdp.params,
      { marker: "broadcast" },
    );
    assert.deepStrictEqual(
      parseCustomizedEnvelope(secondMessages[0].message).cdp.params,
      { marker: "broadcast" },
    );
  });

  it("keeps RPC responses isolated between connector facades", async function () {
    context = createIntegrationContext("multi-connector-rpc", {
      heartbeatInterval: 25,
      staleTimeout: 500,
    });

    const first = context.createConnector();
    const second = context.createConnector();
    await Promise.all([
      first.connectDevices(-1, null, true),
      second.connectDevices(-1, null, true),
    ]);
    const [firstClient] = await first.connectUsbClients(
      "device-1",
      -1,
      true,
      null,
    );
    const [secondClient] = await second.connectUsbClients(
      "device-1",
      -1,
      true,
      null,
    );

    const [firstResponse, secondResponse] = await Promise.all([
      firstClient.sendClientMessage("Runtime.evaluate", {
        marker: "first",
      }),
      secondClient.sendClientMessage("Runtime.evaluate", {
        marker: "second",
      }),
    ]);

    assert.deepStrictEqual(JSON.parse(firstResponse).result.params, {
      marker: "first",
    });
    assert.deepStrictEqual(JSON.parse(secondResponse).result.params, {
      marker: "second",
    });

    const rawMessage = {
      event: "Customized",
      data: {
        type: "CDP",
        data: {
          client_id: 1,
          session_id: 7,
          message: {
            id: 77,
            method: "Runtime.getProperties",
            params: { objectId: "node-1" },
          },
        },
        sender: 0,
      },
    };
    assert.deepStrictEqual(
      await firstClient.sendRawMessage(rawMessage),
      {
        event: "Customized",
        data: {
          type: "CDP",
          data: {
            client_id: 1,
            session_id: 7,
            message: JSON.stringify({
              id: 77,
              result: {
                clientId: 1,
                method: "Runtime.getProperties",
                params: { objectId: "node-1" },
              },
            }),
          },
          sender: 0,
        },
      },
    );
    firstClient.close();
    second.startWatchAllClients(true);

    await waitFor(() => {
      const log = context.readLog();
      return (
        log.some(
          (entry) =>
            entry.event === "client-send-raw-message" &&
            entry.id === 1 &&
            entry.message.data?.data?.message?.method ===
              "Runtime.getProperties",
        ) &&
        log.some((entry) => entry.event === "client-close" && entry.id === 1) &&
        log.some(
          (entry) =>
            entry.event === "device-start-watch" &&
            entry.serial === "device-1",
        )
      );
    }, 2000);
  });
});
