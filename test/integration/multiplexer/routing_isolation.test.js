// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

const {
  collectConnectorEvents,
  connectDriverWebSocket,
  createCustomizedEnvelope,
  createCustomizedResponseEnvelope,
  createIntegrationContext,
  delay,
  parseCustomizedEnvelope,
  platformTimeout,
  waitFor,
  waitForSocketMessage,
} = require("./helpers/integration_harness");

describe("multiplexer integration routing isolation", function () {
  this.timeout(platformTimeout(12000));

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("routes duplicate WebSocket request ids back only to the originating frontend", async function () {
    context = createIntegrationContext("routing-websocket", {
      heartbeatInterval: 25,
      staleTimeout: 500,
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "integration-room",
      },
    });

    const client = context.createClient({ rpcTimeout: 1500 });
    const controlEvents = [];
    client.subscribe((event) => controlEvents.push(event));
    await client.connect();
    await client.call("connectDevices", {
      timeout: -1,
      serial: null,
      isAutoListenClients: true,
    });
    await client.call("connectUsbClients", {
      deviceId: "device-1",
      timeout: -1,
      waitTimeout: true,
      clientName: null,
    });
    const serverInfo = await client.call("startWSServer", {});
    assert(serverInfo.port > 0);

    const url = `ws://127.0.0.1:${serverInfo.port}/mdevices/page/android`;
    const webA = await connectDriverWebSocket(url, { app: "driver-a" });
    const webB = await connectDriverWebSocket(url, { app: "driver-b" });
    context.trackSocket(webA.socket);
    context.trackSocket(webB.socket);

    const responseA = waitForSocketMessage(webA.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      const parsed = parseCustomizedEnvelope(JSON.stringify(value));
      return parsed.cdp.result?.params?.marker === "web-a";
    });
    const responseB = waitForSocketMessage(webB.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      const parsed = parseCustomizedEnvelope(JSON.stringify(value));
      return parsed.cdp.result?.params?.marker === "web-b";
    });

    webA.socket.send(createCustomizedEnvelope(1, 1, "web-a"));
    webB.socket.send(createCustomizedEnvelope(1, 1, "web-b"));

    const [a, b] = await Promise.all([responseA, responseB]);
    const parsedA = parseCustomizedEnvelope(a.text);
    const parsedB = parseCustomizedEnvelope(b.text);
    assert.strictEqual(parsedA.cdp.id, 1);
    assert.strictEqual(parsedB.cdp.id, 1);
    assert.deepStrictEqual(parsedA.cdp.result.params, { marker: "web-a" });
    assert.deepStrictEqual(parsedB.cdp.result.params, { marker: "web-b" });

    const unexpectedA = [];
    const unexpectedB = [];
    webA.socket.on("message", (data) => {
      const parsed = parseMaybeCustomized(data.toString());
      if (parsed?.cdp?.result?.params?.marker === "web-b") {
        unexpectedA.push(parsed);
      }
    });
    webB.socket.on("message", (data) => {
      const parsed = parseMaybeCustomized(data.toString());
      if (parsed?.cdp?.result?.params?.marker === "web-a") {
        unexpectedB.push(parsed);
      }
    });
    await delay(100);
    assert.deepStrictEqual(unexpectedA, []);
    assert.deepStrictEqual(unexpectedB, []);
  });

  it("keeps control and WebSocket routes separate when they use the same original request id", async function () {
    context = createIntegrationContext("routing-control-websocket", {
      heartbeatInterval: 25,
      staleTimeout: 500,
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "integration-room",
      },
    });

    const client = context.createClient({ rpcTimeout: 1500 });
    const controlEvents = [];
    client.subscribe((event) => controlEvents.push(event));
    await client.connect();
    await client.call("connectDevices", {
      timeout: -1,
      serial: null,
      isAutoListenClients: true,
    });
    await client.call("connectUsbClients", {
      deviceId: "device-1",
      timeout: -1,
      waitTimeout: true,
      clientName: null,
    });
    const serverInfo = await client.call("startWSServer", {});
    const web = await connectDriverWebSocket(
      `ws://127.0.0.1:${serverInfo.port}/mdevices/page/android`,
      { app: "driver-control-mix" },
    );
    context.trackSocket(web.socket);

    const webResponse = waitForSocketMessage(web.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      return (
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
          ?.marker === "web-route"
      );
    });

    const controlResponse = waitFor(() => {
      return controlEvents.find((event) => {
        if (event.event !== "usb-client-message") {
          return false;
        }
        return (
          parseCustomizedEnvelope(event.data.message).cdp.result?.params
            ?.marker === "control-route"
        );
      });
    }, 2000);

    web.socket.send(createCustomizedEnvelope(1, 1, "web-route"));
    await client.call("sendMessageToApp", {
      id: 1,
      message: createCustomizedEnvelope(1, 1, "control-route"),
    });

    const [webMessage, controlEvent] = await Promise.all([
      webResponse,
      controlResponse,
    ]);
    const webParsed = parseCustomizedEnvelope(webMessage.text);
    const controlParsed = parseCustomizedEnvelope(controlEvent.data.message);

    assert.strictEqual(webParsed.cdp.id, 1);
    assert.strictEqual(controlParsed.cdp.id, 1);
    assert.deepStrictEqual(webParsed.cdp.result.params, {
      marker: "web-route",
    });
    assert.deepStrictEqual(controlParsed.cdp.result.params, {
      marker: "control-route",
    });
    await waitFor(() => {
      const sentMessages = context
        .readLog()
        .filter((entry) => entry.event === "client-send-message");
      return (
        sentMessages.filter(
          (entry) => entry.id === 1 && entry.message?.event === "Customized",
        ).length >= 2
      );
    }, 2000);
  });

  it("routes duplicate control request ids back only to the originating control connection", async function () {
    context = createIntegrationContext("routing-control-control", {
      heartbeatInterval: 25,
      staleTimeout: 500,
      enableWebSocket: false,
    });

    const controlA = context.createClient({ rpcTimeout: 1500 });
    const controlB = context.createClient({ rpcTimeout: 1500 });
    const eventsA = [];
    const eventsB = [];
    controlA.subscribe((event) => eventsA.push(event));
    controlB.subscribe((event) => eventsB.push(event));
    await Promise.all([controlA.connect(), controlB.connect()]);
    await controlA.call("connectDevices", {
      timeout: -1,
      serial: null,
      isAutoListenClients: true,
    });
    await controlA.call("connectUsbClients", {
      deviceId: "device-1",
      timeout: -1,
      waitTimeout: true,
      clientName: null,
    });

    const responseA = waitFor(() =>
      eventsA.find(
        (event) =>
          event.event === "usb-client-message" &&
          parseCustomizedEnvelope(event.data.message).cdp.result?.params
            ?.marker === "control-a",
      ),
    );
    const responseB = waitFor(() =>
      eventsB.find(
        (event) =>
          event.event === "usb-client-message" &&
          parseCustomizedEnvelope(event.data.message).cdp.result?.params
            ?.marker === "control-b",
      ),
    );

    await Promise.all([
      controlA.call("sendMessageToApp", {
        id: 1,
        message: createCustomizedEnvelope(1, 1, "control-a"),
      }),
      controlB.call("sendMessageToApp", {
        id: 1,
        message: createCustomizedEnvelope(1, 1, "control-b"),
      }),
    ]);

    const [eventA, eventB] = await Promise.all([responseA, responseB]);
    const parsedA = parseCustomizedEnvelope(eventA.data.message);
    const parsedB = parseCustomizedEnvelope(eventB.data.message);
    assert.strictEqual(parsedA.cdp.id, 1);
    assert.strictEqual(parsedB.cdp.id, 1);
    assert.deepStrictEqual(parsedA.cdp.result.params, { marker: "control-a" });
    assert.deepStrictEqual(parsedB.cdp.result.params, { marker: "control-b" });
    assert.strictEqual(
      eventsA.some(
        (event) =>
          event.event === "usb-client-message" &&
          event.data.message.includes("control-b"),
      ),
      false,
    );
    assert.strictEqual(
      eventsB.some(
        (event) =>
          event.event === "usb-client-message" &&
          event.data.message.includes("control-a"),
      ),
      false,
    );
  });

  it("isolates simultaneous routes from multiple connectors and multiple WebSocket frontends", async function () {
    context = createIntegrationContext("routing-many-frontends", {
      heartbeatInterval: 25,
      staleTimeout: 500,
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "integration-room",
      },
    });

    const connectorA = context.createConnector({ enableWebSocket: true });
    const connectorB = context.createConnector({ enableWebSocket: true });
    const connectorEventsA = collectConnectorEvents(
      connectorA,
      "usb-client-message",
    );
    const connectorEventsB = collectConnectorEvents(
      connectorB,
      "usb-client-message",
    );
    await Promise.all([
      connectorA.connectDevices(-1, null, true),
      connectorB.connectDevices(-1, null, true),
    ]);
    await Promise.all([
      connectorA.connectUsbClients("device-1", -1, true, null),
      connectorB.connectUsbClients("device-1", -1, true, null),
    ]);
    await Promise.all([connectorA.startWSServer(), connectorB.startWSServer()]);

    const url = `ws://127.0.0.1:${connectorA.wssPort}/mdevices/page/android`;
    const webA = await connectDriverWebSocket(url, { app: "driver-a" });
    const webB = await connectDriverWebSocket(url, { app: "driver-b" });
    context.trackSocket(webA.socket);
    context.trackSocket(webB.socket);

    const connectorResponseA = waitFor(() =>
      connectorEventsA.find(
        (event) =>
          parseCustomizedEnvelope(event.message).cdp.result?.params?.marker ===
          "connector-a",
      ),
    );
    const connectorResponseB = waitFor(() =>
      connectorEventsB.find(
        (event) =>
          parseCustomizedEnvelope(event.message).cdp.result?.params?.marker ===
          "connector-b",
      ),
    );
    const webResponseA = waitForSocketMessage(webA.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      return (
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
          ?.marker === "web-a"
      );
    });
    const webResponseB = waitForSocketMessage(webB.socket, (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      return (
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
          ?.marker === "web-b"
      );
    });

    connectorA.sendMessageToApp(1, createCustomizedEnvelope(1, 1, "connector-a"));
    connectorB.sendMessageToApp(1, createCustomizedEnvelope(1, 1, "connector-b"));
    webA.socket.send(createCustomizedEnvelope(1, 1, "web-a"));
    webB.socket.send(createCustomizedEnvelope(1, 1, "web-b"));

    const [eventA, eventB, socketA, socketB] = await Promise.all([
      connectorResponseA,
      connectorResponseB,
      webResponseA,
      webResponseB,
    ]);
    assert.deepStrictEqual(
      parseCustomizedEnvelope(eventA.message).cdp.result.params,
      { marker: "connector-a" },
    );
    assert.deepStrictEqual(
      parseCustomizedEnvelope(eventB.message).cdp.result.params,
      { marker: "connector-b" },
    );
    assert.deepStrictEqual(
      parseCustomizedEnvelope(socketA.text).cdp.result.params,
      { marker: "web-a" },
    );
    assert.deepStrictEqual(
      parseCustomizedEnvelope(socketB.text).cdp.result.params,
      { marker: "web-b" },
    );

    assert.strictEqual(
      connectorEventsA.some((event) => event.message.includes("connector-b")),
      false,
    );
    assert.strictEqual(
      connectorEventsB.some((event) => event.message.includes("connector-a")),
      false,
    );
  });

  it("keeps many frontends current when they connect before SDK clients and churn with connectors", async function () {
    context = createIntegrationContext("routing-frontend-churn", {
      heartbeatInterval: 25,
      staleTimeout: 500,
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "integration-room",
      },
      state: {
        devices: [
          {
            serial: "device-1",
            os: "Android",
            title: "Pixel 8",
            ports: [9001, 9002],
            host: "127.0.0.1",
          },
        ],
        clients: [],
      },
    });

    const connectorA = context.createConnector({ enableWebSocket: true });
    const connectorB = context.createConnector({ enableWebSocket: true });
    await Promise.all([
      connectorA.connectDevices(-1, null, true),
      connectorB.connectDevices(-1, null, true),
    ]);
    await Promise.all([connectorA.startWSServer(), connectorB.startWSServer()]);

    const url = `ws://127.0.0.1:${connectorA.wssPort}/mdevices/page/android`;
    const frontendA = await connectDriverWebSocket(url, { app: "agent-a" });
    const frontendB = await connectDriverWebSocket(url, { app: "agent-b" });
    const frontendC = await connectDriverWebSocket(url, { app: "devtool-c" });
    context.trackSocket(frontendA.socket);
    context.trackSocket(frontendB.socket);
    context.trackSocket(frontendC.socket);
    assert.deepStrictEqual(latestClientIds(frontendA.messages), []);
    assert.deepStrictEqual(latestClientIds(frontendB.messages), []);
    assert.deepStrictEqual(latestClientIds(frontendC.messages), []);

    context.appendCommand({
      type: "add-client",
      client: {
        id: 1,
        deviceId: "device-1",
        app: "FirstRuntime",
        processName: "com.first",
        port: 9101,
      },
    });
    await waitForClientIds([frontendA, frontendB, frontendC], [1]);
    await waitFor(
      () => connectorA.usbClients.has(1) && connectorB.usbClients.has(1),
      2000,
    );

    const frontendD = await connectDriverWebSocket(url, { app: "agent-d" });
    context.trackSocket(frontendD.socket);
    assert.deepStrictEqual(latestClientIds(frontendD.messages), [1]);

    context.appendCommand({ type: "remove-client", id: 1 });
    await waitForClientIds([frontendA, frontendB, frontendC, frontendD], []);
    await waitFor(
      () => !connectorA.usbClients.has(1) && !connectorB.usbClients.has(1),
      2000,
    );

    frontendB.socket.close();
    await delay(100);

    context.appendCommand({
      type: "add-client",
      client: {
        id: 2,
        deviceId: "device-1",
        app: "SecondRuntime",
        processName: "com.second",
        port: 9102,
      },
    });
    await waitForClientIds([frontendA, frontendC, frontendD], [2]);
    await waitFor(
      () => connectorA.usbClients.has(2) && connectorB.usbClients.has(2),
      2000,
    );

    context.appendCommand({ type: "remove-client", id: 2 });
    context.appendCommand({ type: "remove-device", serial: "device-1" });
    await waitForClientIds([frontendA, frontendC, frontendD], []);
    await waitFor(
      () => connectorA.devices.size === 0 && connectorB.devices.size === 0,
      2000,
    );

    context.appendCommand({
      type: "add-device",
      device: {
        serial: "device-1",
        os: "Android",
        title: "Pixel 8 Replugged",
        ports: [9003],
        host: "127.0.0.1",
      },
    });
    context.appendCommand({
      type: "add-client",
      client: {
        id: 3,
        deviceId: "device-1",
        app: "ReconnectedRuntime",
        processName: "com.reconnected",
        port: 9103,
      },
    });
    await waitForClientIds([frontendA, frontendC, frontendD], [3]);
    await waitFor(
      () =>
        connectorA.devices.has("device-1") &&
        connectorB.devices.has("device-1") &&
        connectorA.usbClients.has(3) &&
        connectorB.usbClients.has(3),
      2000,
    );

    const frontendBReconnect = await connectDriverWebSocket(url, {
      app: "agent-b-reconnect",
    });
    const frontendE = await connectDriverWebSocket(url, { app: "devtool-e" });
    context.trackSocket(frontendBReconnect.socket);
    context.trackSocket(frontendE.socket);
    assert.deepStrictEqual(latestClientIds(frontendBReconnect.messages), [3]);
    assert.deepStrictEqual(latestClientIds(frontendE.messages), [3]);

    const frontends = [
      ["agent-a", frontendA],
      ["devtool-c", frontendC],
      ["agent-d", frontendD],
      ["agent-b-reconnect", frontendBReconnect],
      ["devtool-e", frontendE],
    ];
    const responses = frontends.map(([marker, frontend]) =>
      waitForSocketMessage(frontend.socket, (value) => {
        if (value?.event !== "Customized") {
          return false;
        }
        return (
          parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
            ?.marker === marker
        );
      }),
    );

    for (const [marker, frontend] of frontends) {
      frontend.socket.send(createCustomizedEnvelope(3, 1, marker));
    }

    const received = await Promise.all(responses);
    assert.deepStrictEqual(
      received.map((message) =>
        parseCustomizedEnvelope(message.text).cdp.result.params.marker,
      ),
      frontends.map(([marker]) => marker),
    );
    for (const [marker, frontend] of frontends) {
      const unexpectedMarkers = frontends
        .map(([other]) => other)
        .filter((other) => other !== marker);
      assert.strictEqual(
        frontend.messages.some((message) =>
          unexpectedMarkers.some((other) =>
            JSON.stringify(message).includes(other),
          ),
        ),
        false,
        `${marker} should not receive another frontend response`,
      );
    }
  });

  it("keeps 10+ control and WebSocket frontends isolated through seeded SDK churn", async function () {
    context = createIntegrationContext("routing-large-random-churn", {
      heartbeatInterval: 25,
      staleTimeout: 500,
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "integration-room",
      },
      state: {
        devices: [],
        clients: [],
      },
    });

    const random = createSeededRandom(0x5eed1234);
    const connectors = [];
    const connectorEvents = new Map();
    const frontends = [];
    const activeDevices = new Set();
    const activeClients = new Map();

    const openConnector = async (label) => {
      const connector = context.createConnector({ enableWebSocket: true });
      connectorEvents.set(
        connector,
        collectConnectorEvents(connector, "usb-client-message"),
      );
      await connector.connectDevices(-1, null, true);
      for (const deviceId of activeDevices) {
        await connector.connectUsbClients(deviceId, -1, true, null);
      }
      await connector.startWSServer();
      connectors.push({ label, connector, closed: false });
      return connector;
    };

    const openFrontend = async (label, url) => {
      const frontend = await connectDriverWebSocket(url, { app: label });
      context.trackSocket(frontend.socket);
      frontends.push({ label, frontend, closed: false });
      return frontend;
    };

    const addDevice = (index) => {
      const serial = `device-${index}`;
      context.appendCommand({
        type: "add-device",
        device: createStressDevice(index),
      });
      activeDevices.add(serial);
      return serial;
    };

    const addClient = (id, deviceId) => {
      context.appendCommand({
        type: "add-client",
        client: createStressClient(id, deviceId),
      });
      activeClients.set(id, deviceId);
      return id;
    };

    const removeClient = (id) => {
      context.appendCommand({ type: "remove-client", id });
      activeClients.delete(id);
    };

    const removeDevice = (deviceId) => {
      for (const [clientId, clientDeviceId] of [...activeClients.entries()]) {
        if (clientDeviceId === deviceId) {
          removeClient(clientId);
        }
      }
      context.appendCommand({ type: "remove-device", serial: deviceId });
      activeDevices.delete(deviceId);
    };

    const baseConnector = await openConnector("connector-base");
    const url = `ws://127.0.0.1:${baseConnector.wssPort}/mdevices/page/android`;

    for (let index = 1; index <= 11; index++) {
      await openConnector(`connector-${index}`);
    }
    for (let index = 1; index <= 12; index++) {
      await openFrontend(`frontend-${index}`, url);
    }
    assert.strictEqual(openConnectors(connectors).length, 12);
    assert.strictEqual(openFrontends(frontends).length, 12);
    await waitForClientIds(
      openFrontends(frontends).map((entry) => entry.frontend),
      [],
    );

    for (const deviceIndex of shuffleWithRandom([1, 2, 3], random)) {
      addDevice(deviceIndex);
    }
    for (const [clientId, deviceId] of shuffleWithRandom(
      [
        [101, "device-1"],
        [102, "device-1"],
        [201, "device-2"],
        [202, "device-2"],
        [301, "device-3"],
        [302, "device-3"],
      ],
      random,
    )) {
      addClient(clientId, deviceId);
    }
    await waitForFrontendAndConnectorState(
      frontends,
      connectors,
      activeDevices,
      activeClients,
    );

    for (const entry of takeRandom(openFrontends(frontends), 5, random)) {
      entry.closed = true;
      entry.frontend.socket.close();
    }
    for (const entry of takeRandom(openConnectors(connectors).slice(1), 4, random)) {
      entry.closed = true;
      await entry.connector.close();
    }

    for (const clientId of takeRandom([...activeClients.keys()], 3, random)) {
      removeClient(clientId);
    }
    removeDevice(pickRandom([...activeDevices], random));
    await waitForFrontendAndConnectorState(
      frontends,
      connectors,
      activeDevices,
      activeClients,
    );

    const repluggedDeviceId = addDevice(4);
    for (const clientId of shuffleWithRandom([401, 402, 403], random)) {
      addClient(clientId, repluggedDeviceId);
    }
    for (let index = 12; index <= 15; index++) {
      await openConnector(`connector-reconnect-${index}`);
    }
    for (let index = 12; index <= 16; index++) {
      await openFrontend(`frontend-reconnect-${index}`, url);
    }
    assert.strictEqual(openConnectors(connectors).length >= 12, true);
    assert.strictEqual(openFrontends(frontends).length >= 12, true);
    await waitForFrontendAndConnectorState(
      frontends,
      connectors,
      activeDevices,
      activeClients,
    );

    const targetClientId = pickRandom([...activeClients.keys()], random);
    const selectedConnectors = takeRandom(openConnectors(connectors), 10, random);
    const selectedFrontends = takeRandom(openFrontends(frontends), 10, random);
    const connectorResponses = selectedConnectors.map((entry) => {
      const events = connectorEvents.get(entry.connector);
      return waitFor(() =>
        events.find(
          (event) =>
            parseCustomizedEnvelope(event.message).cdp.result?.params?.marker ===
            entry.label,
        ),
      );
    });
    const frontendResponses = selectedFrontends.map((entry) =>
      waitForSocketMessage(entry.frontend.socket, (value) => {
        if (value?.event !== "Customized") {
          return false;
        }
        return (
          parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
            ?.marker === entry.label
        );
      }, 2500),
    );

    for (const entry of selectedConnectors) {
      entry.connector.sendMessageToApp(
        targetClientId,
        createCustomizedEnvelope(targetClientId, 17, entry.label),
      );
    }
    for (const entry of selectedFrontends) {
      entry.frontend.socket.send(
        createCustomizedEnvelope(targetClientId, 17, entry.label),
      );
    }

    const [controlReceived, webReceived] = await Promise.all([
      Promise.all(connectorResponses),
      Promise.all(frontendResponses),
    ]);
    assert.deepStrictEqual(
      controlReceived.map(
        (event) =>
          parseCustomizedEnvelope(event.message).cdp.result.params.marker,
      ),
      selectedConnectors.map((entry) => entry.label),
    );
    assert.deepStrictEqual(
      webReceived.map(
        (message) =>
          parseCustomizedEnvelope(message.text).cdp.result.params.marker,
      ),
      selectedFrontends.map((entry) => entry.label),
    );
    for (const entry of selectedFrontends) {
      const unexpectedMarkers = selectedFrontends
        .filter((other) => other !== entry)
        .map((other) => other.label);
      assert.strictEqual(
        entry.frontend.messages.some((message) =>
          unexpectedMarkers.some((marker) =>
            JSON.stringify(message).includes(marker),
          ),
        ),
        false,
        `${entry.label} should not receive another WebSocket response`,
      );
    }
  });

  it("drops unknown response ids but broadcasts notifications to control clients", async function () {
    context = createIntegrationContext("routing-unknown", {
      heartbeatInterval: 25,
      staleTimeout: 500,
      enableWebSocket: false,
    });

    const client = context.createClient({ rpcTimeout: 1500 });
    const controlEvents = [];
    client.subscribe((event) => controlEvents.push(event));
    await client.connect();

    context.appendCommand({
      type: "emit-usb-message",
      id: 1,
      message: createCustomizedResponseEnvelope(1, 999, "unknown-response"),
    });
    await waitFor(() =>
      context.readLog().some((entry) => entry.event === "emit-usb-message"),
    );
    await delay(100);
    assert.strictEqual(
      controlEvents.some(
        (event) =>
          event.event === "usb-client-message" &&
          event.data.message.includes("unknown-response"),
      ),
      false,
    );

    const notification = JSON.stringify({
      event: "Customized",
      data: {
        type: "CDP",
        data: {
          message: JSON.stringify({
            method: "Runtime.consoleAPICalled",
            params: { marker: "notification" },
          }),
        },
        sender: 0,
      },
    });
    context.appendCommand({
      type: "emit-usb-message",
      id: 1,
      message: notification,
    });

    await waitFor(() =>
      controlEvents.some(
        (event) =>
          event.event === "usb-client-message" &&
          event.data.message.includes("notification"),
      ),
    );
  });
});

function parseMaybeCustomized(text) {
  try {
    const value = JSON.parse(text);
    if (value?.event !== "Customized") {
      return null;
    }
    return parseCustomizedEnvelope(text);
  } catch (_error) {
    return null;
  }
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

function last(values) {
  return values[values.length - 1];
}

async function waitForClientIds(frontends, expectedIds) {
  const expected = [...expectedIds].sort((first, second) => first - second);
  await waitFor(
    () =>
      frontends.every((frontend) =>
        arraysEqual(latestClientIds(frontend.messages), expected),
      ),
    2500,
  );
}

async function waitForFrontendAndConnectorState(
  frontendEntries,
  connectorEntries,
  activeDevices,
  activeClients,
) {
  const expectedClientIds = [...activeClients.keys()].sort(
    (first, second) => first - second,
  );
  const expectedDeviceIds = [...activeDevices].sort();
  await Promise.all([
    waitForClientIds(
      openFrontends(frontendEntries).map((entry) => entry.frontend),
      expectedClientIds,
    ),
    waitFor(
      () =>
        openConnectors(connectorEntries).every((entry) => {
          const deviceIds = [...entry.connector.devices.keys()].sort();
          const clientIds = [...entry.connector.usbClients.keys()].sort(
            (first, second) => first - second,
          );
          return (
            arraysEqual(deviceIds, expectedDeviceIds) &&
            arraysEqual(clientIds, expectedClientIds)
          );
        }),
      3000,
    ),
  ]);
}

function openConnectors(entries) {
  return entries.filter((entry) => !entry.closed);
}

function openFrontends(entries) {
  return entries.filter(
    (entry) =>
      !entry.closed && entry.frontend.socket.readyState === 1,
  );
}

function createStressDevice(index) {
  return {
    serial: `device-${index}`,
    os: "Android",
    title: `Pixel Stress ${index}`,
    ports: [9400 + index],
    host: "127.0.0.1",
  };
}

function createStressClient(id, deviceId) {
  return {
    id,
    deviceId,
    app: `Runtime ${id}`,
    processName: `com.runtime.${id}`,
    port: 9500 + id,
  };
}

function createSeededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function shuffleWithRandom(values, random) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

function pickRandom(values, random) {
  assert(values.length > 0);
  return values[Math.floor(random() * values.length)];
}

function takeRandom(values, count, random) {
  return shuffleWithRandom(values, random).slice(0, count);
}

function arraysEqual(first, second) {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}
