const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");

const {
  DebugRouterConnector,
} = require("@lynx-js/debug-router-connector");

const fakeDaemonEntry = path.resolve(
  __dirname,
  "../../../integration/multiplexer/fixtures/fake_daemon_entry.js",
);

const DATA_DIR_NAME = "multiplexer";
const STATE_FILE_NAME = "fake_physical_state.json";
const COMMAND_FILE_NAME = "fake_physical_commands.jsonl";
const LOG_FILE_NAME = "fake_daemon_log.jsonl";

function logStep(message) {
  console.log(`[multiplexer-websocket-e2e] ${message}`);
}

function createPaths(rootDir) {
  const dataDir = path.join(rootDir, DATA_DIR_NAME);
  return {
    rootDir,
    dataDir,
    discoveryPath: path.join(dataDir, "daemon.json"),
    daemonLockPath: path.join(dataDir, "daemon.lock"),
  };
}

function defaultState() {
  return {
    devices: [
      {
        serial: "device-1",
        os: "Android",
        title: "Pixel 8",
        ports: [9101],
        host: "127.0.0.1",
      },
    ],
    clients: [
      {
        id: 1,
        deviceId: "device-1",
        app: "Demo",
        os: "Android",
        device: "Pixel 8",
        deviceModel: "Pixel 8",
        processName: "com.demo",
        appName: "Demo",
        port: 9201,
      },
    ],
  };
}

function createContext(name, state = defaultState()) {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `debug-router-e2e-${name}-`),
  );
  const homeDir = path.join(rootDir, "home");
  const hadOriginalHome = Object.prototype.hasOwnProperty.call(
    process.env,
    "HOME",
  );
  const originalHome = process.env.HOME;
  fs.mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;

  const paths = createPaths(rootDir);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(paths.dataDir, STATE_FILE_NAME),
    JSON.stringify(state, null, 2),
  );

  const sockets = [];
  const connectors = [];
  return {
    rootDir,
    homeDir,
    paths,
    createConnector() {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: true,
        websocketOption: {
          port: 0,
          roomId: "no-device-e2e",
        },
        enableAndroid: false,
        enableIOS: false,
        enableHarmony: false,
        enableDesktop: false,
        enableNetworkDevice: false,
        multiplexerRootDir: rootDir,
        multiplexerLegacyDriverDir: path.join(homeDir, ".DebugRouterConnector"),
        multiplexerDaemonEntry: fakeDaemonEntry,
        multiplexerStartupTimeout: 3000,
        multiplexerStaleTimeout: 500,
        multiplexerRpcTimeout: 1200,
        multiplexerDaemonIdleTimeout: 150,
        reportService: null,
      });
      connectors.push(connector);
      return connector;
    },
    trackSocket(socket) {
      sockets.push(socket);
      return socket;
    },
    appendCommand(command) {
      fs.appendFileSync(
        path.join(paths.dataDir, COMMAND_FILE_NAME),
        `${JSON.stringify(command)}\n`,
      );
    },
    readLog() {
      return readJsonLines(path.join(paths.dataDir, LOG_FILE_NAME));
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
        await stopDaemon(paths.discoveryPath);
        fs.rmSync(rootDir, { recursive: true, force: true });
      } finally {
        if (hadOriginalHome) {
          process.env.HOME = originalHome;
        } else {
          delete process.env.HOME;
        }
      }
    },
  };
}

async function connectDriverWebSocket(url, info) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on("message", (data) => {
    const text = data.toString();
    const value = parseJson(text);
    messages.push(value ?? text);
    if (value?.event === "Initialize") {
      socket.send(
        JSON.stringify({
          event: "Register",
          data: {
            id: value.data,
            info: {
              app: info.app,
              debugRouterVersion: "e2e",
              deviceModel: "Driver",
              osVersion: process.platform,
              sdkVersion: "e2e",
            },
            type: "Driver",
          },
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitFor(
    () => messages.find((message) => message?.event === "RoomJoined"),
    2000,
    `${info.app} room joined`,
  );
  return { socket, messages };
}

async function runWebSocketRoutingFlow() {
  logStep("checking package-entry WebSocket routing without real devices");
  const context = createContext("websocket");
  let daemonPid;

  try {
    const connector = context.createConnector();
    await connector.connectDevices(-1, null, true);
    await connector.connectUsbClients("device-1", -1, true, null);
    await connector.startWSServer();
    assert(connector.wssPort > 0, "websocket port should be assigned");

    const discovery = await waitFor(
      () => readJsonFile(context.paths.discoveryPath, null),
      3000,
      "websocket daemon discovery",
    );
    daemonPid = discovery?.pid;
    assert(daemonPid, "expected daemon pid in discovery");

    const url = `ws://127.0.0.1:${connector.wssPort}/mdevices/page/android`;
    const first = await connectDriverWebSocket(url, { app: "driver-a" });
    const second = await connectDriverWebSocket(url, { app: "driver-b" });
    context.trackSocket(first.socket);
    context.trackSocket(second.socket);

    await waitFor(
      () =>
        first.messages.find(
          (message) =>
            message?.event === "ClientList" &&
            message.data?.some((client) => client.id === 1),
        ),
      2000,
      "driver receives usb client list",
    );

    const firstResponse = waitForSocketMessage(first.socket, (value) => {
      return (
        value?.event === "Customized" &&
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
          ?.marker === "driver-a"
      );
    });
    const secondResponse = waitForSocketMessage(second.socket, (value) => {
      return (
        value?.event === "Customized" &&
        parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
          ?.marker === "driver-b"
      );
    });

    first.socket.send(createCustomizedEnvelope(1, 7, "driver-a"));
    second.socket.send(createCustomizedEnvelope(1, 7, "driver-b"));

    const [messageA, messageB] = await Promise.all([
      firstResponse,
      secondResponse,
    ]);
    const parsedA = parseCustomizedEnvelope(messageA.text);
    const parsedB = parseCustomizedEnvelope(messageB.text);
    assert.strictEqual(parsedA.cdp.id, 7);
    assert.strictEqual(parsedB.cdp.id, 7);
    assert.deepStrictEqual(parsedA.cdp.result.params, { marker: "driver-a" });
    assert.deepStrictEqual(parsedB.cdp.result.params, { marker: "driver-b" });

    assert.strictEqual(
      first.messages.some((message) =>
        JSON.stringify(message).includes("driver-b"),
      ),
      false,
      "first driver should not receive second driver's response",
    );
    assert.strictEqual(
      second.messages.some((message) =>
        JSON.stringify(message).includes("driver-a"),
      ),
      false,
      "second driver should not receive first driver's response",
    );

    first.socket.close();
    second.socket.close();
    await connector.close();
    await waitFor(
      () =>
        !fs.existsSync(context.paths.discoveryPath) &&
        !fs.existsSync(context.paths.daemonLockPath) &&
        !processExists(daemonPid),
      2500,
      "websocket daemon idle cleanup",
    );

    const sentMessages = context
      .readLog()
      .filter((entry) => entry.event === "client-send-message");
    assert.strictEqual(sentMessages.length >= 2, true);
  } finally {
    await context.cleanup();
  }
}

async function runFrontendTimingFlow() {
  logStep("checking frontend timing and client churn without real devices");
  const context = createContext("websocket-timing", {
    devices: [
      {
        serial: "device-1",
        os: "Android",
        title: "Pixel 8",
        ports: [9101],
        host: "127.0.0.1",
      },
    ],
    clients: [],
  });

  try {
    const connector = context.createConnector();
    await connector.connectDevices(-1, null, true);
    await connector.startWSServer();

    const url = `ws://127.0.0.1:${connector.wssPort}/mdevices/page/android`;
    const agentA = await connectDriverWebSocket(url, { app: "agent-a" });
    const agentB = await connectDriverWebSocket(url, { app: "agent-b" });
    const devtoolC = await connectDriverWebSocket(url, { app: "devtool-c" });
    context.trackSocket(agentA.socket);
    context.trackSocket(agentB.socket);
    context.trackSocket(devtoolC.socket);
    assert.deepStrictEqual(latestClientIds(agentA.messages), []);
    assert.deepStrictEqual(latestClientIds(agentB.messages), []);
    assert.deepStrictEqual(latestClientIds(devtoolC.messages), []);

    context.appendCommand({
      type: "add-client",
      client: {
        id: 11,
        deviceId: "device-1",
        app: "RuntimeA",
        processName: "com.runtime.a",
        port: 9211,
      },
    });
    await waitForClientIds([agentA, agentB, devtoolC], [11]);

    const lateDevtool = await connectDriverWebSocket(url, {
      app: "devtool-late",
    });
    context.trackSocket(lateDevtool.socket);
    assert.deepStrictEqual(latestClientIds(lateDevtool.messages), [11]);

    agentB.socket.close();
    await delay(100);
    context.appendCommand({ type: "remove-client", id: 11 });
    await waitForClientIds([agentA, devtoolC, lateDevtool], []);

    context.appendCommand({
      type: "add-client",
      client: {
        id: 12,
        deviceId: "device-1",
        app: "RuntimeB",
        processName: "com.runtime.b",
        port: 9212,
      },
    });
    await waitForClientIds([agentA, devtoolC, lateDevtool], [12]);

    const agentBReconnect = await connectDriverWebSocket(url, {
      app: "agent-b-reconnect",
    });
    const agentD = await connectDriverWebSocket(url, { app: "agent-d" });
    context.trackSocket(agentBReconnect.socket);
    context.trackSocket(agentD.socket);
    assert.deepStrictEqual(latestClientIds(agentBReconnect.messages), [12]);
    assert.deepStrictEqual(latestClientIds(agentD.messages), [12]);

    context.appendCommand({ type: "remove-client", id: 12 });
    context.appendCommand({ type: "remove-device", serial: "device-1" });
    await waitForClientIds(
      [agentA, devtoolC, lateDevtool, agentBReconnect, agentD],
      [],
    );

    context.appendCommand({
      type: "add-device",
      device: {
        serial: "device-1",
        os: "Android",
        title: "Pixel 8 Replugged",
        ports: [9301],
        host: "127.0.0.1",
      },
    });
    context.appendCommand({
      type: "add-client",
      client: {
        id: 13,
        deviceId: "device-1",
        app: "RuntimeC",
        processName: "com.runtime.c",
        port: 9213,
      },
    });
    const frontends = [
      ["agent-a", agentA],
      ["devtool-c", devtoolC],
      ["devtool-late", lateDevtool],
      ["agent-b-reconnect", agentBReconnect],
      ["agent-d", agentD],
    ];
    await waitForClientIds(
      frontends.map(([, frontend]) => frontend),
      [13],
    );

    const responses = frontends.map(([marker, frontend]) =>
      waitForSocketMessage(frontend.socket, (value) => {
        return (
          value?.event === "Customized" &&
          parseCustomizedEnvelope(JSON.stringify(value)).cdp.result?.params
            ?.marker === marker
        );
      }),
    );
    for (const [marker, frontend] of frontends) {
      frontend.socket.send(createCustomizedEnvelope(13, 7, marker));
    }
    const received = await Promise.all(responses);
    assert.deepStrictEqual(
      received.map((message) =>
        parseCustomizedEnvelope(message.text).cdp.result.params.marker,
      ),
      frontends.map(([marker]) => marker),
    );

    await connector.close();
  } finally {
    await context.cleanup();
  }
}

async function runLargeRandomFrontendChurnFlow() {
  logStep("checking large seeded frontend and SDK churn without real devices");
  const context = createContext("websocket-large-churn", {
    devices: [],
    clients: [],
  });
  const random = createSeededRandom(0x5eed1234);
  const connectors = [];
  const connectorEvents = new Map();
  const frontends = [];
  const activeDevices = new Set();
  const activeClients = new Map();

  const openConnector = async (label) => {
    const connector = context.createConnector();
    const events = [];
    connector.on("usb-client-message", (event) => events.push(event));
    await connector.connectDevices(-1, null, true);
    for (const deviceId of activeDevices) {
      await connector.connectUsbClients(deviceId, -1, true, null);
    }
    await connector.startWSServer();
    connectors.push({ label, connector, closed: false });
    connectorEvents.set(connector, events);
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

  try {
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
      return waitFor(
        () =>
          events.find(
            (event) =>
              parseCustomizedEnvelope(event.message).cdp.result?.params
                ?.marker === entry.label,
          ),
        2500,
        `${entry.label} response`,
      );
    });
    const frontendResponses = selectedFrontends.map((entry) =>
      waitForSocketMessage(entry.frontend.socket, (value) => {
        return (
          value?.event === "Customized" &&
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
  } finally {
    await context.cleanup();
  }
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
          params: {
            marker,
          },
        }),
      },
      sender: 0,
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

async function stopDaemon(discoveryPath) {
  const discovery = readJsonFile(discoveryPath, null);
  if (!discovery?.pid) {
    return;
  }
  try {
    process.kill(discovery.pid, "SIGTERM");
  } catch (_error) {}
  await waitFor(
    () => !processExists(discovery.pid) || !fs.existsSync(discoveryPath),
    1000,
    "daemon termination",
  ).catch(() => {
    try {
      process.kill(discovery.pid, "SIGKILL");
    } catch (_error) {}
  });
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function readJsonLines(filePath) {
  try {
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_error) {
    return [];
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function processExists(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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
  throw new Error(`Timeout after ${timeout}ms: ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runWebSocketRoutingFlow()
  .then(() => runFrontendTimingFlow())
  .then(() => runLargeRandomFrontendChurnFlow())
  .then(() => {
    logStep("TEST SUCCESS");
  })
  .catch((error) => {
    console.error("[multiplexer-websocket-e2e] TEST FAILED");
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });

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
    2500,
    `frontends latest ClientList to equal ${expected.join(",")}`,
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
      8000,
      `connectors snapshot devices=${expectedDeviceIds.join(",")} clients=${expectedClientIds.join(",")}`,
    ),
  ]);
}

function openConnectors(entries) {
  return entries.filter((entry) => !entry.closed);
}

function openFrontends(entries) {
  return entries.filter(
    (entry) =>
      !entry.closed && entry.frontend.socket.readyState === WebSocket.OPEN,
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
