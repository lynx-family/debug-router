// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");

const {
  DebugRouterConnector,
  MultiOpenStatus,
  WebSocketClient,
} = require("@lynx-js/debug-router-connector");
const {
  createMultiplexerPaths,
} = require("@lynx-js/debug-router-connector/dist/cjs/src/multiplexer/utils/paths");
const { findDaemonProcess, stopDaemonProcesses } = require("./daemon_process");

const fakeDaemonEntry = path.resolve(
  __dirname,
  "../../../integration/multiplexer/fixtures/fake_daemon_entry.js"
);

const cases = [
  ["WiFi registration and Driver discovery", runRegistrationDiscoveryCase],
  ["public lifecycle and mirrors", runPublicLifecycleCase],
  ["websocket requester visibility", runRequesterVisibilityCase],
  ["public handleUsbMessage stays local", runPublicUsbForwardingCase],
  ["Driver to WiFi runtime routing", runDriverRoundTripCase],
  ["Connector to WiFi runtime routing", runConnectorRoundTripCase],
  ["WiFi runtime public client proxy", runPublicProxyCase],
  ["invalid WiFi target error isolation", runErrorIsolationCase],
  ["raw WiFi and Driver events", runRawEventsCase],
  ["disconnect events and mirror cleanup", runDisconnectCase],
  [
    "ownership loss removes runtimes and preserves Driver state",
    runOwnershipPreemptionCase,
  ],
  ["late Connector snapshot", runLateSnapshotCase],
  ["WiFi runtime daemon liveness", runDaemonLivenessCase],
];

runCases().catch((error) => {
  console.error("[multiplexer-wifi-runtime-e2e] TEST RUNNER FAILED");
  console.error(error?.stack ?? error);
  process.exit(1);
});

async function runCases() {
  const failures = [];
  for (const [name, run] of cases) {
    try {
      await run();
      console.log(`[multiplexer-wifi-runtime-e2e] PASS: ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`[multiplexer-wifi-runtime-e2e] FAIL: ${name}`);
      console.error(error?.stack ?? error);
    }
  }

  if (failures.length > 0) {
    console.error(
      `[multiplexer-wifi-runtime-e2e] ${failures.length}/${cases.length} ideal WiFi cases failed`
    );
    process.exit(1);
  }
  console.log("[multiplexer-wifi-runtime-e2e] TEST SUCCESS");
}

async function runRegistrationDiscoveryCase() {
  const context = createContext("registration-discovery");
  try {
    const connector = context.createConnector();
    await connector.startWSServer();
    const url = websocketUrl(connector);
    const runtime = await connectWebSocketClient(url, "runtime", {
      app: "wifi-phone-discovery",
      deviceModel: "Phone",
    });
    const driver = await connectWebSocketClient(url, "Driver", {
      app: "driver-discovery",
      deviceModel: "Browser",
    });
    context.trackSocket(runtime.socket);
    context.trackSocket(driver.socket);

    const listed = latestClientList(driver.messages).find(
      (client) => client.id === runtime.id
    );
    assert(listed, "Driver ClientList should contain the WiFi runtime");
    assert.strictEqual(listed.type, "runtime");
    assert.strictEqual(listed.info.network, "WiFi");
    assert.strictEqual(listed.info.app, "wifi-phone-discovery");
  } finally {
    await context.cleanup();
  }
}

async function runOwnershipPreemptionCase() {
  const context = createContext("ownership-preemption");
  try {
    const connector = context.createConnector();
    const statuses = [];
    const runtimeDisconnected = collect(
      connector,
      "websocket-app-client-disconnected"
    );
    const driverDisconnected = collect(
      connector,
      "websocket-web-client-disconnected"
    );
    connector.setMultiOpenCallback({
      statusChanged(status) {
        statuses.push(status);
      },
    });

    await connector.connectDevices(-1, null, true);
    await connector.startWSServer();
    const url = websocketUrl(connector);
    const runtime = await connectWebSocketClient(url, "runtime", {
      app: "wifi-phone-ownership",
    });
    const driver = await connectWebSocketClient(url, "Driver", {
      app: "driver-ownership",
    });
    context.trackSocket(runtime.socket);
    context.trackSocket(driver.socket);

    await waitFor(
      () =>
        connector
          .getAllWebsocketAppClients()
          .some((client) => clientIdOf(client) === runtime.id) &&
        connector.websocketWebClients.has(driver.id),
      2000,
      "ownership facade mirrors before preemption"
    );
    const daemon = await waitFor(
      () => findDaemonProcess(context.paths.daemonProcessName),
      3000,
      "ownership daemon process"
    );
    await waitFor(
      () => readOwnerPid(context.legacyOwnerPath) === daemon.pid,
      3000,
      "ownership daemon claims legacy owner"
    );

    fs.writeFileSync(context.legacyOwnerPath, `${process.pid}`, "utf8");
    await waitFor(
      () => statuses.includes(MultiOpenStatus.unattached),
      3000,
      "ownership facade receives unattached"
    );
    await waitFor(
      () =>
        runtime.socket.readyState === WebSocket.CLOSED &&
        connector.getAllWebsocketAppClients().length === 0 &&
        connector.websocketWebClients.has(driver.id),
      3000,
      "ownership runtime removed and Driver mirror retained"
    );
    assert.strictEqual(driver.socket.readyState, WebSocket.OPEN);
    assert.deepStrictEqual(runtimeDisconnected, [runtime.id]);
    assert.deepStrictEqual(driverDisconnected, []);

    const clientListCount = driver.messages.filter(
      (message) => message?.event === "ClientList"
    ).length;
    driver.socket.send(JSON.stringify({ event: "ListClients" }));
    await waitFor(
      () =>
        driver.messages.filter((message) => message?.event === "ClientList")
          .length > clientListCount &&
        latestClientList(driver.messages).length === 0,
      2000,
      "ownership Driver ClientList converges with facade runtime mirrors"
    );
  } finally {
    await context.cleanup();
  }
}

async function runPublicLifecycleCase() {
  const context = createContext("lifecycle");
  try {
    const connector = context.createConnector();
    const connected = collect(connector, "websocket-app-client-connected");
    const appConnected = collect(connector, "app-client-connected");
    await connector.startWSServer();
    const url = websocketUrl(connector);
    const runtime = await connectWebSocketClient(url, "runtime", {
      app: "wifi-phone-lifecycle",
      deviceModel: "Phone",
    });
    const driver = await connectWebSocketClient(url, "Driver", {
      app: "driver-lifecycle",
      deviceModel: "Browser",
    });
    context.trackSocket(runtime.socket);
    context.trackSocket(driver.socket);

    const listed = latestClientList(driver.messages).find(
      (client) => client.id === runtime.id
    );
    assert(listed, "Driver ClientList should contain the WiFi runtime");
    assert.strictEqual(listed.info.network, "WiFi");

    await waitFor(
      () =>
        connected.some((client) => clientIdOf(client) === runtime.id) &&
        appConnected.some((client) => clientIdOf(client) === runtime.id),
      2000,
      "public WiFi connected events"
    );
    const externalClient = connected.find(
      (client) => clientIdOf(client) === runtime.id
    );
    assert.strictEqual(externalClient instanceof WebSocketClient, true);
    assert.strictEqual(typeof externalClient.clientId, "function");
    assert.strictEqual(externalClient.clientId(), runtime.id);
    assert.strictEqual(externalClient.type(), "runtime");
    assert.strictEqual(externalClient.info.network, "WiFi");
    assert.strictEqual(externalClient.info, externalClient.info);
    assert.strictEqual(typeof externalClient.sendCustomizedMessage, "function");
    assert.strictEqual(typeof externalClient.close, "function");
    assert.strictEqual(
      connector
        .getAllAppClients()
        .some((client) => clientIdOf(client) === runtime.id),
      true
    );
  } finally {
    await context.cleanup();
  }
}

async function runRequesterVisibilityCase() {
  const context = createContext("requester-visibility");
  try {
    const owner = context.createConnector();
    await owner.startWSServer();
    const passive = context.createConnector();
    const passiveConnected = collect(passive, "websocket-app-client-connected");
    const passiveMessages = collect(passive, "ws-client-message");
    await passive.connectDevices(0);

    const runtime = await connectWebSocketClient(
      websocketUrl(owner),
      "runtime",
      { app: "wifi-phone-requester-visibility" }
    );
    context.trackSocket(runtime.socket);
    await waitFor(
      () =>
        owner
          .getAllWebsocketAppClients()
          .some((client) => clientIdOf(client) === runtime.id),
      2000,
      "owner WiFi runtime mirror"
    );
    await delay(100);

    assert.deepStrictEqual(passiveConnected, []);
    assert.deepStrictEqual(passiveMessages, []);
    assert.deepStrictEqual(passive.getAllWebsocketAppClients(), []);

    await passive.startWSServer();
    await waitFor(
      () =>
        passive
          .getAllWebsocketAppClients()
          .some((client) => clientIdOf(client) === runtime.id),
      2000,
      "requesting Connector receives existing WiFi snapshot"
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
            parseJson(event.message)?.data?.marker === "visible-after-start"
        ),
      2000,
      "requesting Connector receives subsequent WiFi messages"
    );
  } finally {
    await context.cleanup();
  }
}

async function runPublicUsbForwardingCase() {
  const context = createContext("public-usb-forwarding");
  try {
    const connector = context.createConnector();
    const handledMessages = [];
    await connector.startWSServer();
    const driver = await connectWebSocketClient(
      websocketUrl(connector),
      "Driver",
      { app: "driver-public-usb-forwarding" }
    );
    context.trackSocket(driver.socket);
    const localMessages = collect(connector, "usb-client-message");
    connector.regiserUsbClient({
      info: { id: 7 },
      clientId() {
        return 7;
      },
      handleMessage(message) {
        handledMessages.push(message);
      },
    });
    assert.strictEqual(connector.usbClients.has(7), true);

    const message = JSON.stringify({
      event: "Customized",
      data: {
        type: "CDP",
        data: {
          client_id: -1,
          message: JSON.stringify({
            method: "Runtime.consoleAPICalled",
          }),
        },
        sender: 1,
      },
    });
    connector.handleUsbMessage(7, message);

    await waitFor(
      () =>
        localMessages.some(
          (event) => event.id === 7 && event.message === message
        ),
      2000,
      "local public handleUsbMessage event"
    );
    assert.deepStrictEqual(handledMessages, [message]);
    await delay(100);
    assert.strictEqual(
      driver.messages.some(
        (value) =>
          value?.event === "Customized" &&
          value?.data?.sender === 7 &&
          value?.data?.data?.client_id === 7
      ),
      false,
      "public handleUsbMessage should not inject messages into daemon WebSocket frontends"
    );
  } finally {
    await context.cleanup();
  }
}

async function runDriverRoundTripCase() {
  const context = createContext("driver-routing");
  try {
    const connector = context.createConnector();
    await connector.startWSServer();
    const url = websocketUrl(connector);
    const runtime = await connectWebSocketClient(url, "runtime", {
      app: "wifi-phone-routing",
    });
    const first = await connectWebSocketClient(url, "Driver", {
      app: "driver-first",
    });
    const second = await connectWebSocketClient(url, "Driver", {
      app: "driver-second",
    });
    context.trackSocket(runtime.socket);
    context.trackSocket(first.socket);
    context.trackSocket(second.socket);

    const request = waitForSocketMessage(runtime.socket, (value) => {
      return (
        value?.event === "Customized" &&
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.params?.marker ===
          "driver-to-wifi"
      );
    });
    first.socket.send(
      createCustomizedEnvelope(runtime.id, 71, "driver-to-wifi")
    );
    const routed = parseCustomizedEnvelope((await request).text);
    assert.strictEqual(
      routed.envelope.data.data.client_id,
      runtime.id,
      "WiFi CDP requests must keep the runtime id assigned during Initialize"
    );

    const response = waitForSocketMessage(first.socket, (value) => {
      return (
        value?.event === "Customized" &&
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
    const restored = parseCustomizedEnvelope((await response).text);
    assert.strictEqual(restored.cdp.id, 71);
    await delay(100);
    assert.strictEqual(
      second.messages.some((message) =>
        JSON.stringify(message).includes("wifi-to-driver")
      ),
      false,
      "another Driver must not receive the routed response"
    );
  } finally {
    await context.cleanup();
  }
}

async function runConnectorRoundTripCase() {
  const context = createContext("connector-routing");
  try {
    const connector = context.createConnector();
    const messages = collect(connector, "ws-client-message");
    await connector.startWSServer();
    const runtime = await connectWebSocketClient(
      websocketUrl(connector),
      "runtime",
      { app: "wifi-phone-control" }
    );
    context.trackSocket(runtime.socket);

    const request = waitForSocketMessage(runtime.socket, (value) => {
      return (
        value?.event === "Customized" &&
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.params?.marker ===
          "connector-to-wifi"
      );
    });
    connector.sendMessageToApp(
      runtime.id,
      createCustomizedEnvelope(runtime.id, 81, "connector-to-wifi")
    );
    const routed = parseCustomizedEnvelope((await request).text);
    assert.strictEqual(
      routed.envelope.data.data.client_id,
      runtime.id,
      "Connector CDP requests must keep the WiFi runtime id"
    );
    runtime.socket.send(
      createCustomizedResponseEnvelope(
        runtime.id,
        routed.cdp.id,
        "wifi-to-connector"
      )
    );

    const response = await waitFor(
      () =>
        messages.find(
          (event) =>
            parseCustomizedEnvelope(event.message).cdp.result?.marker ===
            "wifi-to-connector"
        ),
      2000,
      "WiFi response delivered to Connector"
    );
    assert.strictEqual(parseCustomizedEnvelope(response.message).cdp.id, 81);
  } finally {
    await context.cleanup();
  }
}

async function runPublicProxyCase() {
  const context = createContext("public-proxy");
  try {
    const connector = context.createConnector();
    await connector.startWSServer();
    const runtime = await connectWebSocketClient(
      websocketUrl(connector),
      "runtime",
      { app: "wifi-phone-proxy" }
    );
    context.trackSocket(runtime.socket);
    const proxy = await waitFor(
      () =>
        connector
          .getAllWebsocketAppClients()
          .find((client) => clientIdOf(client) === runtime.id),
      2000,
      "WiFi client proxy"
    );

    const runtimeRequest = waitForSocketMessage(runtime.socket, (value) => {
      return (
        value?.event === "Customized" &&
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
    assert.strictEqual(
      request.envelope.data.data.client_id,
      runtime.id,
      "WiFi proxy CDP requests must keep the runtime id"
    );
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
  } finally {
    await context.cleanup();
  }
}

async function runErrorIsolationCase() {
  const context = createContext("error-isolation");
  try {
    const connector = context.createConnector();
    await connector.startWSServer();
    const driver = await connectWebSocketClient(
      websocketUrl(connector),
      "Driver",
      { app: "driver-error-isolation" }
    );
    context.trackSocket(driver.socket);

    driver.socket.send(
      createCustomizedEnvelope(999999, 91, "missing-wifi-target")
    );
    await delay(50);
    const pong = waitForSocketMessage(
      driver.socket,
      (value) => value?.event === "Pong"
    );
    driver.socket.send(JSON.stringify({ event: "Ping" }));
    await pong;
    assert.strictEqual(driver.socket.readyState, WebSocket.OPEN);
  } finally {
    await context.cleanup();
  }
}

async function runRawEventsCase() {
  const context = createContext("raw-events");
  try {
    const connector = context.createConnector();
    const runtimeMessages = collect(connector, "ws-client-message");
    const driverMessages = collect(connector, "ws-web-message");
    await connector.startWSServer();
    const url = websocketUrl(connector);
    const runtime = await connectWebSocketClient(url, "runtime", {
      app: "wifi-phone-events",
    });
    const driver = await connectWebSocketClient(url, "Driver", {
      app: "driver-events",
    });
    context.trackSocket(runtime.socket);
    context.trackSocket(driver.socket);

    const notification = JSON.stringify({
      event: "Customized",
      data: {
        type: "CDP",
        data: {
          client_id: runtime.id,
          session_id: 1,
          message: JSON.stringify({
            method: "Runtime.consoleAPICalled",
            params: { marker: "wifi-notification" },
          }),
        },
        sender: runtime.id,
      },
    });
    const driverNotification = waitForSocketMessage(driver.socket, (value) =>
      JSON.stringify(value).includes("wifi-notification")
    );
    runtime.socket.send(notification);
    await driverNotification;

    const ping = JSON.stringify({ event: "Ping" });
    driver.socket.send(ping);
    await waitFor(
      () =>
        runtimeMessages.some(
          (event) => event.id === runtime.id && event.message === notification
        ) &&
        driverMessages.some(
          (event) => event.id === driver.id && event.message === ping
        ),
      2000,
      "raw WiFi and Driver events"
    );
  } finally {
    await context.cleanup();
  }
}

async function runDisconnectCase() {
  const context = createContext("disconnect");
  try {
    const connector = context.createConnector();
    const disconnected = collect(
      connector,
      "websocket-app-client-disconnected"
    );
    const appDisconnected = collect(connector, "app-client-disconnected");
    await connector.startWSServer();
    const runtime = await connectWebSocketClient(
      websocketUrl(connector),
      "runtime",
      { app: "wifi-phone-disconnect" }
    );
    context.trackSocket(runtime.socket);
    await delay(50);

    runtime.socket.close();
    await waitFor(
      () =>
        disconnected.includes(runtime.id) &&
        appDisconnected.includes(runtime.id) &&
        !connector
          .getAllAppClients()
          .some((client) => clientIdOf(client) === runtime.id),
      2000,
      "WiFi disconnect events and mirror cleanup"
    );
  } finally {
    await context.cleanup();
  }
}

async function runLateSnapshotCase() {
  const context = createContext("late-snapshot");
  try {
    const first = context.createConnector();
    await first.startWSServer();
    const runtime = await connectWebSocketClient(
      websocketUrl(first),
      "runtime",
      { app: "wifi-phone-before-late-connector" }
    );
    context.trackSocket(runtime.socket);

    const late = context.createConnector();
    await late.startWSServer();
    await waitFor(
      () =>
        late
          .getAllAppClients()
          .some((client) => clientIdOf(client) === runtime.id),
      2000,
      "late Connector WiFi snapshot"
    );
  } finally {
    await context.cleanup();
  }
}

async function runDaemonLivenessCase() {
  const context = createContext("liveness", 150);
  try {
    const first = context.createConnector();
    const second = context.createConnector();
    await first.startWSServer();
    await second.startWSServer();
    const runtime = await connectWebSocketClient(
      websocketUrl(first),
      "runtime",
      { app: "wifi-phone-liveness" }
    );
    context.trackSocket(runtime.socket);
    const daemon = await waitFor(
      () => findDaemonProcess(context.paths.daemonProcessName),
      2000,
      "daemon process"
    );

    await first.close();
    await delay(350);
    assert.strictEqual(
      processExists(daemon.pid),
      true,
      "the remaining websocket Connector should keep the daemon alive"
    );
    assert.strictEqual(runtime.socket.readyState, WebSocket.OPEN);

    await second.close();
    await waitFor(
      () => runtime.socket.readyState === WebSocket.CLOSED,
      2000,
      "last websocket Connector closes the WiFi runtime"
    );
    await waitFor(
      () => !processExists(daemon.pid),
      2000,
      "daemon exits after the last websocket Connector closes"
    );
  } finally {
    await context.cleanup();
  }
}

function createContext(name, idleTimeout = 30000) {
  const rootDir = fs.mkdtempSync(
    path.join(getIpcTestTempDir(), `debug-router-e2e-wifi-${name}-`)
  );
  const homeDir = path.join(rootDir, "home");
  const legacyDriverDir = path.join(homeDir, ".DebugRouterConnector");
  const legacyOwnerPath = path.join(legacyDriverDir, "LatestDriverProcess");
  const originalHome = process.env.HOME;
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, "HOME");
  fs.mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;

  const paths = createMultiplexerPaths({ rootDir });
  paths.statePath = path.join(paths.dataDir, "fake_physical_state.json");
  fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
  fs.writeFileSync(
    paths.statePath,
    JSON.stringify({ devices: [], clients: [] }, null, 2)
  );

  const connectors = [];
  const sockets = [];
  return {
    paths,
    legacyOwnerPath,
    createConnector() {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableAndroid: false,
        enableIOS: false,
        enableHarmony: false,
        enableDesktop: false,
        enableNetworkDevice: false,
        enableWebSocket: true,
        websocketOption: { port: 0, roomId: "wifi-runtime-e2e" },
        multiplexerRootDir: rootDir,
        multiplexerLegacyDriverDir: legacyDriverDir,
        multiplexerDaemonEntry: fakeDaemonEntry,
        multiplexerStartupTimeout: 3000,
        multiplexerRpcTimeout: 1200,
        multiplexerDaemonIdleTimeout: idleTimeout,
      });
      connectors.push(connector);
      return connector;
    },
    trackSocket(socket) {
      sockets.push(socket);
    },
    async cleanup() {
      try {
        for (const socket of sockets.splice(0)) {
          if (
            socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING
          ) {
            socket.close();
          }
        }
        for (const connector of connectors.splice(0)) {
          await connector.close().catch(() => {});
        }
        await stopDaemonProcesses(paths.daemonProcessName);
        if (process.env.DEBUG_ROUTER_E2E_KEEP_TEMP === "1") {
          console.error(
            `[multiplexer-wifi-runtime-e2e] kept diagnostics at ${rootDir}`
          );
        } else {
          fs.rmSync(rootDir, { recursive: true, force: true });
        }
      } finally {
        if (hadHome) {
          process.env.HOME = originalHome;
        } else {
          delete process.env.HOME;
        }
      }
    },
  };
}

function getIpcTestTempDir() {
  return process.platform === "win32" ? os.tmpdir() : "/tmp";
}

async function connectWebSocketClient(url, type, info) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on("message", (data) => {
    const text = data.toString();
    const value = parseJson(text) ?? text;
    messages.push(value);
    if (value?.event === "Initialize") {
      socket.send(
        JSON.stringify({
          event: "Register",
          data: {
            id: value.data,
            type,
            info: {
              app: info.app,
              debugRouterVersion: "e2e",
              deviceModel: info.deviceModel ?? "Phone",
              network: "WiFi",
              osVersion: process.platform,
              sdkVersion: "e2e",
            },
          },
        })
      );
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const room = await waitFor(
    () => messages.find((message) => message?.event === "RoomJoined"),
    2000,
    `${info.app} room joined`
  );
  if (type === "Driver") {
    socket.send(JSON.stringify({ event: "ListClients" }));
    await waitFor(
      () => messages.find((message) => message?.event === "ClientList"),
      2000,
      `${info.app} ClientList`
    );
  }
  return { socket, id: room.data.id, messages };
}

function collect(connector, event) {
  const payloads = [];
  connector.on(event, (payload) => payloads.push(payload));
  return payloads;
}

function latestClientList(messages) {
  const message = [...messages]
    .reverse()
    .find((value) => value?.event === "ClientList");
  return message?.data ?? [];
}

function websocketUrl(connector) {
  return `ws://127.0.0.1:${connector.wssPort}/mdevices/page/android`;
}

function clientIdOf(client) {
  return typeof client?.clientId === "function"
    ? client.clientId()
    : client?.id;
}

function createCustomizedEnvelope(clientId, cdpId, marker) {
  return JSON.stringify({
    event: "Customized",
    data: {
      type: "CDP",
      data: {
        client_id: clientId,
        session_id: 1,
        message: JSON.stringify({
          id: cdpId,
          method: "Runtime.evaluate",
          params: { marker },
        }),
      },
      sender: 0,
    },
  });
}

function createCustomizedResponseEnvelope(clientId, cdpId, marker) {
  return JSON.stringify({
    event: "Customized",
    data: {
      type: "CDP",
      data: {
        client_id: clientId,
        session_id: 1,
        message: JSON.stringify({ id: cdpId, result: { marker } }),
      },
      sender: clientId,
    },
  });
}

function parseCustomizedEnvelope(message) {
  const envelope = JSON.parse(message);
  const payload = envelope.data?.data?.message;
  return {
    envelope,
    cdp: typeof payload === "string" ? JSON.parse(payload) : payload,
  };
}

function waitForSocketMessage(socket, predicate, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeout);
    const onMessage = (data) => {
      const text = data.toString();
      const value = parseJson(text) ?? text;
      if (predicate(value, text)) {
        cleanup();
        resolve({ value, text });
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed while waiting for message"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

async function waitFor(predicate, timeout, label, interval = 25) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt <= timeout) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readOwnerPid(filePath) {
  try {
    return Number(fs.readFileSync(filePath, "utf8").trim());
  } catch (_error) {
    return undefined;
  }
}
