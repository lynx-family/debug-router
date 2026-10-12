// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

const {
  collectConnectorEvents,
  connectDriverWebSocket,
  connectRuntimeWebSocket,
  createCustomizedEnvelope,
  createCustomizedResponseEnvelope,
  createIntegrationContext,
  delay,
  getUsableDiscovery,
  parseCustomizedEnvelope,
  platformTimeout,
  processExists,
  waitFor,
  waitForSocketMessage,
} = require("./helpers/integration_harness");
const {
  MultiplexerWebSocketClient,
} = require("../../../debug_router_connector/dist/cjs/src/multiplexer/client/MultiplexerWebSocketClient");

describe("multiplexer integration WiFi runtime ideal behavior", function () {
  this.timeout(platformTimeout(12000));

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("lists a registered WiFi runtime in Driver ClientList", async function () {
    const { connector, url } = await startWebSocketConnector("wifi-list");
    const webConnected = collectConnectorEvents(
      connector,
      "websocket-web-client-connected"
    );
    const runtime = await connectRuntimeWebSocket(url, {
      app: "wifi-runtime-list",
    });
    context.trackSocket(runtime.socket);

    const driver = await connectDriverWebSocket(url, { app: "driver-list" });
    context.trackSocket(driver.socket);

    const clientList = [...driver.messages]
      .reverse()
      .find((message) => message?.event === "ClientList");
    const listed = clientList.data.find((client) => client.id === runtime.id);
    assert(listed, "Driver ClientList should contain the WiFi runtime");
    assert.strictEqual(listed.info.network, "WiFi");
    assert.strictEqual(listed.info.app, "wifi-runtime-list");

    await waitFor(
      () => webConnected.find((client) => clientIdOf(client) === driver.id),
      2000
    );
    await connector.close();
  });

  it("publishes WiFi runtime connection events and mirrors to every connector", async function () {
    const { connector: first, url } = await startWebSocketConnector(
      "wifi-lifecycle"
    );
    const second = context.createConnector({ enableWebSocket: true });
    const firstSpecific = collectConnectorEvents(
      first,
      "websocket-app-client-connected"
    );
    const firstGeneric = collectConnectorEvents(first, "app-client-connected");
    const secondSpecific = collectConnectorEvents(
      second,
      "websocket-app-client-connected"
    );
    await second.startWSServer();

    const runtime = await connectRuntimeWebSocket(url, {
      app: "wifi-runtime-lifecycle",
    });
    context.trackSocket(runtime.socket);

    await waitFor(
      () =>
        firstSpecific.some((client) => clientIdOf(client) === runtime.id) &&
        firstGeneric.some((client) => clientIdOf(client) === runtime.id) &&
        secondSpecific.some((client) => clientIdOf(client) === runtime.id),
      2000
    );
    const connectedClient = firstSpecific.find(
      (client) => clientIdOf(client) === runtime.id
    );
    assert.strictEqual(
      connectedClient instanceof MultiplexerWebSocketClient,
      true
    );
    assert.strictEqual(
      typeof connectedClient.clientId,
      "function",
      "the compatibility event should expose a WebSocket client proxy"
    );
    assert.strictEqual(connectedClient.type(), "runtime");
    assert.strictEqual(connectedClient.info.network, "WiFi");
    const firstInfo = connectedClient.info;
    const secondInfo = connectedClient.info;
    assert.strictEqual(firstInfo, secondInfo);
    assert.strictEqual(
      typeof connectedClient.sendCustomizedMessage,
      "function"
    );
    assert.strictEqual(typeof connectedClient.close, "function");
    assert.deepStrictEqual(first.getAllWebsocketAppClients().map(clientIdOf), [
      runtime.id,
    ]);
    assert.deepStrictEqual(second.getAllWebsocketAppClients().map(clientIdOf), [
      runtime.id,
    ]);
    assert.strictEqual(
      first
        .getAllAppClients()
        .some((client) => clientIdOf(client) === runtime.id),
      true
    );
  });

  it("keeps WiFi state private to facades that requested the shared websocket server", async function () {
    const { connector: owner, url } = await startWebSocketConnector(
      "wifi-requester-visibility"
    );
    const passive = context.createConnector({ enableWebSocket: true });
    const passiveConnected = collectConnectorEvents(
      passive,
      "websocket-app-client-connected"
    );
    const passiveMessages = collectConnectorEvents(
      passive,
      "ws-client-message"
    );
    await passive.connectDevices(0);

    const runtime = await connectRuntimeWebSocket(url, {
      app: "wifi-runtime-requester-visibility",
    });
    context.trackSocket(runtime.socket);
    await waitFor(
      () =>
        owner
          .getAllWebsocketAppClients()
          .some((client) => clientIdOf(client) === runtime.id),
      2000
    );
    await delay(100);

    assert.deepStrictEqual(passiveConnected, []);
    assert.deepStrictEqual(passiveMessages, []);
    assert.deepStrictEqual(passive.getAllWebsocketAppClients(), []);
    assert.strictEqual(
      passive
        .getAllAppClients()
        .some((client) => clientIdOf(client) === runtime.id),
      false
    );

    await passive.startWSServer();
    await waitFor(
      () =>
        passive
          .getAllWebsocketAppClients()
          .some((client) => clientIdOf(client) === runtime.id),
      2000
    );
    runtime.socket.send(
      JSON.stringify({
        event: "RuntimeNotification",
        data: { marker: "visible-after-start" },
      })
    );
    await waitFor(
      () =>
        passiveMessages.some(
          (event) =>
            JSON.parse(event.message).data?.marker === "visible-after-start"
        ),
      2000
    );
  });

  it("forwards raw WiFi runtime and Driver messages to connector listeners", async function () {
    const { connector, url } = await startWebSocketConnector("wifi-raw-events");
    const runtimeEvents = collectConnectorEvents(
      connector,
      "ws-client-message"
    );
    const driverEvents = collectConnectorEvents(connector, "ws-web-message");
    const runtime = await connectRuntimeWebSocket(url, {
      app: "wifi-runtime-events",
    });
    const driver = await connectDriverWebSocket(url, {
      app: "driver-events",
    });
    context.trackSocket(runtime.socket);
    context.trackSocket(driver.socket);

    const runtimeMessage = JSON.stringify({
      event: "RuntimeNotification",
      data: { marker: "from-wifi-runtime" },
      sender: runtime.id,
    });
    const driverMessage = JSON.stringify({ event: "Ping" });
    runtime.socket.send(runtimeMessage);
    driver.socket.send(driverMessage);

    await waitFor(
      () =>
        runtimeEvents.some(
          (event) => event.id === runtime.id && event.message === runtimeMessage
        ) &&
        driverEvents.some(
          (event) => event.id === driver.id && event.message === driverMessage
        ),
      2000
    );
  });

  it("routes Driver requests to a WiFi runtime and restores the response id", async function () {
    const { url } = await startWebSocketConnector("wifi-driver-routing");
    const runtime = await connectRuntimeWebSocket(url, {
      app: "wifi-runtime-routing",
    });
    const driver = await connectDriverWebSocket(url, {
      app: "driver-wifi-routing",
    });
    context.trackSocket(runtime.socket);
    context.trackSocket(driver.socket);

    const runtimeRequest = waitForSocketMessage(runtime.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      return (
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.params?.marker ===
        "driver-to-wifi"
      );
    });
    driver.socket.send(
      createCustomizedEnvelope(runtime.id, 41, "driver-to-wifi")
    );
    const request = await runtimeRequest;
    const routed = parseCustomizedEnvelope(request.text);
    assert.strictEqual(
      routed.envelope.data.data.client_id,
      runtime.id,
      "the native WiFi Processor drops CDP messages addressed to another client id"
    );

    const driverResponse = waitForSocketMessage(driver.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      return (
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.marker ===
        "wifi-to-driver"
      );
    });
    runtime.socket.send(
      createCustomizedResponseEnvelope(
        runtime.id,
        routed.cdp.id,
        "wifi-to-driver"
      )
    );

    const response = parseCustomizedEnvelope((await driverResponse).text);
    assert.strictEqual(response.cdp.id, 41);
    assert.strictEqual(response.cdp.result.marker, "wifi-to-driver");
  });

  it("routes Connector requests to a WiFi runtime and targets the response", async function () {
    const { connector: first, url } = await startWebSocketConnector(
      "wifi-control-routing"
    );
    const second = context.createConnector({ enableWebSocket: true });
    const firstEvents = collectConnectorEvents(first, "ws-client-message");
    const secondEvents = collectConnectorEvents(second, "ws-client-message");
    await second.startWSServer();
    const runtime = await connectRuntimeWebSocket(url, {
      app: "wifi-runtime-control",
    });
    context.trackSocket(runtime.socket);

    const runtimeRequest = waitForSocketMessage(runtime.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      return (
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.params?.marker ===
        "connector-to-wifi"
      );
    });
    first.sendMessageToApp(
      runtime.id,
      createCustomizedEnvelope(runtime.id, 51, "connector-to-wifi")
    );
    const request = parseCustomizedEnvelope((await runtimeRequest).text);
    assert.strictEqual(
      request.envelope.data.data.client_id,
      runtime.id,
      "WiFi proxy requests built with client_id -1 must be addressed to the runtime"
    );
    runtime.socket.send(
      createCustomizedResponseEnvelope(
        runtime.id,
        request.cdp.id,
        "wifi-to-connector"
      )
    );

    const response = await waitFor(
      () =>
        firstEvents.find(
          (event) =>
            parseCustomizedEnvelope(event.message).cdp.result?.marker ===
            "wifi-to-connector"
        ),
      2000
    );
    assert.strictEqual(parseCustomizedEnvelope(response.message).cdp.id, 51);
    assert.strictEqual(secondEvents.length, 0);
  });

  it("exposes a functional legacy-compatible WiFi client proxy", async function () {
    const { connector, url } = await startWebSocketConnector("wifi-proxy");
    const runtime = await connectRuntimeWebSocket(url, {
      app: "wifi-runtime-proxy",
    });
    context.trackSocket(runtime.socket);
    const proxy = await waitFor(
      () =>
        connector
          .getAllWebsocketAppClients()
          .find((client) => clientIdOf(client) === runtime.id),
      2000
    );

    const runtimeRequest = waitForSocketMessage(runtime.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      return (
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.params?.marker ===
        "proxy-customized"
      );
    });
    const responsePromise = proxy.sendCustomizedMessage(
      "Runtime.evaluate",
      { marker: "proxy-customized" },
      1,
      "CDP"
    );
    const request = parseCustomizedEnvelope((await runtimeRequest).text);
    runtime.socket.send(
      createCustomizedResponseEnvelope(
        runtime.id,
        request.cdp.id,
        "proxy-response"
      )
    );
    const response = JSON.parse(await responsePromise);
    assert.strictEqual(response.result.marker, "proxy-response");

    const rawMessage = JSON.stringify({ event: "ProxyRawMessage" });
    const rawWait = waitForSocketMessage(
      runtime.socket,
      (_value, text) => text === rawMessage
    );
    proxy.sendMessage(rawMessage);
    await rawWait;

    const closed = new Promise((resolve) =>
      runtime.socket.once("close", resolve)
    );
    proxy.close();
    await closed;
  });

  it("contains invalid WiFi targets without closing the Driver WebSocket", async function () {
    const { url } = await startWebSocketConnector("wifi-error-isolation");
    const driver = await connectDriverWebSocket(url, {
      app: "driver-error-isolation",
    });
    context.trackSocket(driver.socket);

    driver.socket.send(
      createCustomizedEnvelope(999999, 61, "missing-wifi-target")
    );
    await delay(50);
    const pong = waitForSocketMessage(
      driver.socket,
      (value) => value?.event === "Pong"
    );
    driver.socket.send(JSON.stringify({ event: "Ping" }));
    await pong;
    assert.strictEqual(driver.socket.readyState, 1);
  });

  it("includes existing WiFi runtimes in a late connector snapshot", async function () {
    const { url } = await startWebSocketConnector("wifi-late-snapshot");
    const runtime = await connectRuntimeWebSocket(url, {
      app: "wifi-runtime-before-connector",
    });
    context.trackSocket(runtime.socket);

    const late = context.createConnector({ enableWebSocket: true });
    await late.startWSServer();
    await waitFor(
      () =>
        late
          .getAllWebsocketAppClients()
          .some((client) => clientIdOf(client) === runtime.id),
      2000
    );
  });

  it("publishes disconnect events and removes WiFi runtime mirrors", async function () {
    const { connector, url } = await startWebSocketConnector("wifi-disconnect");
    const disconnected = collectConnectorEvents(
      connector,
      "websocket-app-client-disconnected"
    );
    const appDisconnected = collectConnectorEvents(
      connector,
      "app-client-disconnected"
    );
    const runtime = await connectRuntimeWebSocket(url, {
      app: "wifi-runtime-disconnect",
    });
    context.trackSocket(runtime.socket);
    await delay(50);

    runtime.socket.close();
    await waitFor(
      () =>
        disconnected.includes(runtime.id) &&
        appDisconnected.includes(runtime.id) &&
        !connector
          .getAllWebsocketAppClients()
          .some((client) => clientIdOf(client) === runtime.id),
      2000
    );
  });

  it("keeps the daemon for connected Connectors, then idles despite a remaining WiFi runtime", async function () {
    context = createIntegrationContext("wifi-runtime-idle", {
      multiplexerDaemonIdleTimeout: 150,
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "wifi-runtime-idle",
      },
      state: { devices: [], clients: [] },
    });
    const first = context.createConnector({ enableWebSocket: true });
    const second = context.createConnector({ enableWebSocket: true });
    await first.startWSServer();
    await second.startWSServer();
    const runtime = await connectRuntimeWebSocket(
      `ws://127.0.0.1:${first.wssPort}/mdevices/page/android`,
      { app: "wifi-runtime-idle" }
    );
    context.trackSocket(runtime.socket);
    const discovery = await waitFor(
      () => getUsableDiscovery(context.discovery),
      2000
    );

    await first.close();
    await delay(350);
    assert.strictEqual(
      processExists(discovery.pid),
      true,
      "the remaining websocket Connector should keep the daemon alive"
    );
    assert.strictEqual(runtime.socket.readyState, 1);

    await second.close();
    await waitFor(() => runtime.socket.readyState === 3, 2000);
    await waitFor(() => !processExists(discovery.pid), 2000);
  });

  async function startWebSocketConnector(name) {
    context = createIntegrationContext(name, {
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "wifi-runtime-integration",
      },
      state: { devices: [], clients: [] },
    });
    const connector = context.createConnector({ enableWebSocket: true });
    await connector.connectDevices(-1, null, true);
    await connector.startWSServer();
    return {
      connector,
      url: `ws://127.0.0.1:${connector.wssPort}/mdevices/page/android`,
    };
  }
});

function clientIdOf(client) {
  return typeof client?.clientId === "function"
    ? client.clientId()
    : client?.id;
}
