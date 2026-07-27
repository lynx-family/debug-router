// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

const {
  connectDriverWebSocket,
  createCustomizedEnvelope,
  createIntegrationContext,
  parseCustomizedEnvelope,
  platformTimeout,
  processExists,
  waitFor,
  waitForSocketMessage,
} = require("./helpers/integration_harness");

describe("multiplexer integration compatibility upgrade", function () {
  this.timeout(platformTimeout(15000));

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("replaces older daemons as newer connector protocol versions arrive and restores compatible frontends", async function () {
    context = createIntegrationContext("compat-staged-upgrade", {
      heartbeatInterval: 25,
      readyPollInterval: 10,
      replacementTimeout: platformTimeout(50),
      staleTimeout: platformTimeout(500),
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "compat-upgrade",
      },
    });

    const v1 = createVersionedControl("connector-v1", 1, 1);
    await connectRuntime(v1.client);
    const daemonV1 = await currentDiscovery(1);
    assert.strictEqual(daemonV1.protocolVersion, 1);
    assert.strictEqual(daemonV1.minSupportedProtocolVersion, 1);
    assert.strictEqual(daemonV1.debugInfo.daemonVersion, "connector-v1");

    const v2 = createVersionedControl("connector-v2", 2, 1);
    await connectRuntime(v2.client);
    const daemonV2 = await currentDiscovery(2);
    assert.notStrictEqual(daemonV2.pid, daemonV1.pid);
    assert.strictEqual(daemonV2.protocolVersion, 2);
    assert.strictEqual(daemonV2.minSupportedProtocolVersion, 1);
    assert.strictEqual(daemonV2.debugInfo.daemonVersion, "connector-v2");
    await waitFor(() => !processExists(daemonV1.pid), 3000);

    await v1.client.reconnect();
    assert.deepStrictEqual(await listDeviceSerials(v1.client), ["device-1"]);
    assert.deepStrictEqual(await listClientIds(v1.client), [1]);
    assert.deepStrictEqual(await listDeviceSerials(v2.client), ["device-1"]);
    assert.deepStrictEqual(await listClientIds(v2.client), [1]);

    const v3 = createVersionedControl("connector-v3", 3, 2);
    await connectRuntime(v3.client);
    const daemonV3 = await currentDiscovery(3);
    assert.notStrictEqual(daemonV3.pid, daemonV2.pid);
    assert.strictEqual(daemonV3.protocolVersion, 3);
    assert.strictEqual(daemonV3.minSupportedProtocolVersion, 2);
    assert.strictEqual(daemonV3.debugInfo.daemonVersion, "connector-v3");
    await waitFor(() => !processExists(daemonV2.pid), 3000);

    await assert.rejects(
      () => v1.client.reconnect(),
      /requires debug-router-connector protocol 2 or newer/i,
    );
    await v2.client.reconnect();
    await v3.client.reconnect();
    assert.deepStrictEqual(await listDeviceSerials(v2.client), ["device-1"]);
    assert.deepStrictEqual(await listClientIds(v2.client), [1]);
    assert.deepStrictEqual(await listDeviceSerials(v3.client), ["device-1"]);
    assert.deepStrictEqual(await listClientIds(v3.client), [1]);

    const started = daemonStartedPids();
    assert.deepStrictEqual(
      started,
      [daemonV1.pid, daemonV2.pid, daemonV3.pid],
      "each protocol upgrade should start exactly one replacement daemon",
    );
    assert.strictEqual(
      started.filter((pid) => processExists(pid)).length,
      1,
      "only the newest daemon should remain alive",
    );
  });

  it("recovers connector and WebSocket frontends after a daemon protocol upgrade", async function () {
    context = createIntegrationContext("compat-websocket-upgrade", {
      heartbeatInterval: 25,
      readyPollInterval: 10,
      replacementTimeout: platformTimeout(50),
      staleTimeout: platformTimeout(500),
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "compat-upgrade-web",
      },
    });

    const v1 = createVersionedControl("connector-v1", 1, 1);
    await connectRuntime(v1.client);
    const serverV1 = await v1.client.call("startWSServer", {});
    const urlV1 = webSocketUrl(serverV1.port);
    const webA = await connectDriverWebSocket(urlV1, { app: "web-a-v1" });
    const webB = await connectDriverWebSocket(urlV1, { app: "web-b-v1" });
    context.trackSocket(webA.socket);
    context.trackSocket(webB.socket);
    await waitForClientIds([webA, webB], [1]);

    const daemonV1 = await currentDiscovery(1);
    const oldWebSocketsClosed = Promise.all([
      waitForSocketClose(webA.socket),
      waitForSocketClose(webB.socket),
    ]);
    const v2 = createVersionedControl("connector-v2", 2, 1);
    await connectRuntime(v2.client);
    const daemonV2 = await currentDiscovery(2);
    assert.notStrictEqual(daemonV2.pid, daemonV1.pid);
    await oldWebSocketsClosed;
    await waitFor(() => !processExists(daemonV1.pid), 3000);

    await v1.client.reconnect();
    assert.deepStrictEqual(await listDeviceSerials(v1.client), ["device-1"]);
    assert.deepStrictEqual(await listClientIds(v1.client), [1]);

    const serverV2 = await v2.client.call("startWSServer", {});
    const urlV2 = webSocketUrl(serverV2.port);
    const webC = await connectDriverWebSocket(urlV2, { app: "web-c-v2" });
    const webD = await connectDriverWebSocket(urlV2, { app: "web-d-v2" });
    context.trackSocket(webC.socket);
    context.trackSocket(webD.socket);
    await waitForClientIds([webC, webD], [1]);

    const responses = [
      waitForSocketMessage(webC.socket, (value) =>
        hasCustomizedMarker(value, "web-c-v2"),
      ),
      waitForSocketMessage(webD.socket, (value) =>
        hasCustomizedMarker(value, "web-d-v2"),
      ),
    ];
    webC.socket.send(createCustomizedEnvelope(1, 7, "web-c-v2"));
    webD.socket.send(createCustomizedEnvelope(1, 7, "web-d-v2"));
    const [responseC, responseD] = await Promise.all(responses);
    assert.deepStrictEqual(
      parseCustomizedEnvelope(responseC.text).cdp.result.params,
      { marker: "web-c-v2" },
    );
    assert.deepStrictEqual(
      parseCustomizedEnvelope(responseD.text).cdp.result.params,
      { marker: "web-d-v2" },
    );
  });

  function createVersionedControl(name, protocolVersion, minSupportedVersion) {
    const manager = context.createManager({
      localProtocolVersion: protocolVersion,
      minSupportedProtocolVersion: minSupportedVersion,
      debugInfo: {
        daemonVersion: name,
      },
      readyPollInterval: 10,
      replacementTimeout: platformTimeout(50),
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "compat-upgrade",
      },
    });
    const client = context.createClient({
      manager,
      debugInfo: {
        protocolVersion,
        clientVersion: name,
      },
      rpcTimeout: platformTimeout(2000),
    });
    return { manager, client };
  }

  async function connectRuntime(client) {
    assert.deepStrictEqual(await listDeviceSerials(client), ["device-1"]);
    assert.deepStrictEqual(await listClientIds(client), [1]);
  }

  async function listDeviceSerials(client) {
    const devices = await client.call("connectDevices", {
      timeout: -1,
      serial: null,
      isAutoListenClients: true,
    });
    return devices.map((device) => device.serial);
  }

  async function listClientIds(client) {
    const clients = await client.call("connectUsbClients", {
      deviceId: "device-1",
      timeout: -1,
      waitTimeout: true,
      clientName: null,
    });
    return clients.map((client) => client.id);
  }

  async function currentDiscovery(expectedProtocolVersion) {
    return waitFor(() => {
      const info = context.discovery.readDiscovery();
      if (info?.protocolVersion === expectedProtocolVersion) {
        return info;
      }
      return null;
    }, 3000);
  }

  function daemonStartedPids() {
    return context
      .readLog()
      .filter((entry) => entry.event === "daemon-started")
      .map((entry) => entry.pid);
  }
});

function webSocketUrl(port) {
  return `ws://127.0.0.1:${port}/mdevices/page/android`;
}

function latestClientIds(messages) {
  const clientLists = messages.filter((message) => message?.event === "ClientList");
  if (clientLists.length === 0) {
    return [];
  }
  return clientLists[clientLists.length - 1].data
    .map((client) => client.id)
    .sort((first, second) => first - second);
}

async function waitForClientIds(frontends, expectedIds) {
  const expected = [...expectedIds].sort((first, second) => first - second);
  await waitFor(
    () =>
      frontends.every((frontend) =>
        arraysEqual(latestClientIds(frontend.messages), expected),
      ),
    3000,
  );
}

function waitForSocketClose(socket) {
  if (socket.readyState === 3) {
    return Promise.resolve();
  }
  return new Promise((resolve) => socket.once("close", resolve));
}

function hasCustomizedMarker(value, marker) {
  if (value?.event !== "Customized") {
    return false;
  }
  return (
    parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params?.marker ===
    marker
  );
}

function arraysEqual(first, second) {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}
