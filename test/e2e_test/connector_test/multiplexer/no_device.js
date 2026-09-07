const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  DebugRouterConnector,
  MultiOpenStatus,
} = require("@lynx-js/debug-router-connector");
const {
  MultiplexerDaemonClient,
} = require("@lynx-js/debug-router-connector/dist/cjs/src/multiplexer/client/MultiplexerDaemonClient");
const {
  MultiplexerDaemonManager,
} = require("@lynx-js/debug-router-connector/dist/cjs/src/multiplexer/client/MultiplexerDaemonManager");
const {
  MultiplexerDiscovery,
} = require("@lynx-js/debug-router-connector/dist/cjs/src/multiplexer/client/MultiplexerDiscovery");
const {
  createMultiplexerPaths,
} = require("@lynx-js/debug-router-connector/dist/cjs/src/multiplexer/utils/paths");
const { findDaemonProcess, stopDaemonProcesses } = require("./daemon_process");

const fakeDaemonEntry = path.resolve(
  __dirname,
  "../../../integration/multiplexer/fixtures/fake_daemon_entry.js"
);

const STATE_FILE_NAME = "fake_physical_state.json";
const COMMAND_FILE_NAME = "fake_physical_commands.jsonl";
const LOG_FILE_NAME = "fake_daemon_log.jsonl";

function logStep(message) {
  console.log(`[multiplexer-no-device-e2e] ${message}`);
}

function createPaths(rootDir) {
  return createMultiplexerPaths({ rootDir });
}

function createContext(name, state, option = {}) {
  const rootDir = fs.mkdtempSync(
    path.join(getIpcTestTempDir(), `debug-router-e2e-${name}-`)
  );
  const homeDir = path.join(rootDir, "home");
  const legacyDriverDir = path.join(homeDir, ".DebugRouterConnector");
  const legacyOwnerPath = path.join(legacyDriverDir, "LatestDriverProcess");
  const hadOriginalHome = Object.prototype.hasOwnProperty.call(
    process.env,
    "HOME"
  );
  const originalHome = process.env.HOME;
  fs.mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;

  const paths = createPaths(rootDir);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(paths.dataDir, STATE_FILE_NAME),
    JSON.stringify(state, null, 2)
  );

  const connectors = [];
  return {
    rootDir,
    homeDir,
    legacyDriverDir,
    legacyOwnerPath,
    paths,
    createConnector(extra = {}) {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket: extra.enableWebSocket ?? false,
        enableAndroid: true,
        enableIOS: false,
        enableHarmony: false,
        enableDesktop: false,
        enableNetworkDevice: false,
        websocketOption: extra.websocketOption,
        multiplexerRootDir: rootDir,
        multiplexerLegacyDriverDir: legacyDriverDir,
        multiplexerDaemonEntry: fakeDaemonEntry,
        multiplexerStartupTimeout: extra.startupTimeout ?? 3000,
        multiplexerRpcTimeout: extra.rpcTimeout ?? 1200,
        multiplexerDaemonIdleTimeout:
          extra.multiplexerDaemonIdleTimeout ??
          option.multiplexerDaemonIdleTimeout ??
          150,
      });
      connectors.push(connector);
      return connector;
    },
    appendCommand(command) {
      fs.appendFileSync(
        path.join(paths.dataDir, COMMAND_FILE_NAME),
        `${JSON.stringify(command)}\n`
      );
    },
    readLog() {
      return readJsonLines(path.join(paths.dataDir, LOG_FILE_NAME));
    },
    async cleanup() {
      try {
        for (const connector of connectors.splice(0)) {
          await connector.close().catch(() => {});
        }
        await stopDaemonProcesses(paths.daemonProcessName);
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

function getIpcTestTempDir() {
  return process.platform === "win32" ? os.tmpdir() : "/tmp";
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

function collectEvents(connector, event) {
  const payloads = [];
  connector.on(event, (payload) => payloads.push(payload));
  return payloads;
}

async function runEmptyDaemonFlow() {
  logStep("checking empty fake daemon facade flow");
  const context = createContext(
    "empty",
    {
      devices: [],
      clients: [],
    },
    {
      multiplexerDaemonIdleTimeout: 120,
    }
  );
  let daemonPid;

  try {
    const connector = context.createConnector();
    const devices = await connector.connectDevices(100, null, true);
    assert.deepStrictEqual(devices, []);
    assert.deepStrictEqual(
      await connector.connectUsbClients("missing-device", 100, false),
      []
    );
    assert.deepStrictEqual(connector.getAllUsbClients(), []);

    const daemon = await waitFor(
      () => findDaemonProcess(context.paths.daemonProcessName),
      2000,
      "daemon process"
    );
    daemonPid = daemon.pid;
    assert(processExists(daemonPid), "daemon should be alive while connected");
    assert.strictEqual(
      fs.existsSync(path.join(context.paths.dataDir, "daemon.json")),
      false
    );

    await connector.close();
    await waitFor(() => !processExists(daemonPid), 2500, "idle daemon cleanup");

    const events = context.readLog().map((entry) => entry.event);
    assert(events.includes("connect-devices"));
    assert(events.includes("fake-physical-closed"));
  } finally {
    await context.cleanup();
  }
}

async function runSharedDaemonMirrorFlow() {
  logStep("checking shared daemon, mirrors, RPC, and event fanout");
  const context = createContext("shared", defaultState(), {
    multiplexerDaemonIdleTimeout: 150,
  });
  let daemonPid;

  try {
    const first = context.createConnector();
    const second = context.createConnector();
    const firstMessages = collectEvents(first, "usb-client-message");
    const secondMessages = collectEvents(second, "usb-client-message");
    const firstConnected = collectEvents(first, "client-connected");
    const secondConnected = collectEvents(second, "client-connected");
    const firstDisconnected = collectEvents(first, "client-disconnected");
    const secondDisconnected = collectEvents(second, "client-disconnected");

    const [firstDevices, secondDevices] = await Promise.all([
      first.connectDevices(-1, null, true),
      second.connectDevices(-1, null, true),
    ]);
    assert.deepStrictEqual(
      firstDevices.map((device) => device.serial),
      ["device-1"]
    );
    assert.deepStrictEqual(
      secondDevices.map((device) => device.serial),
      ["device-1"]
    );

    const daemon = await waitFor(
      () => findDaemonProcess(context.paths.daemonProcessName),
      3000,
      "shared daemon process"
    );
    daemonPid = daemon?.pid;
    assert(daemonPid, "expected daemon pid from process lookup");

    const [firstClients, secondClients] = await Promise.all([
      first.connectUsbClients("device-1", -1, true, null),
      second.connectUsbClients("device-1", -1, true, null),
    ]);
    assert.deepStrictEqual(
      firstClients.map((client) => client.clientId()),
      [1]
    );
    assert.deepStrictEqual(
      secondClients.map((client) => client.clientId()),
      [1]
    );
    assert.notStrictEqual(firstClients[0], secondClients[0]);

    const [firstResponse, secondResponse] = await Promise.all([
      firstClients[0].sendClientMessage("Runtime.evaluate", {
        marker: "first",
      }),
      secondClients[0].sendClientMessage("Runtime.evaluate", {
        marker: "second",
      }),
    ]);
    assert.deepStrictEqual(JSON.parse(firstResponse).result.params, {
      marker: "first",
    });
    assert.deepStrictEqual(JSON.parse(secondResponse).result.params, {
      marker: "second",
    });

    context.appendCommand({
      type: "add-client",
      client: {
        id: 2,
        deviceId: "device-1",
        app: "Dynamic",
        processName: "com.dynamic",
        port: 9202,
      },
    });
    await waitFor(
      () => first.usbClients.has(2) && second.usbClients.has(2),
      2000,
      "dynamic client mirror"
    );
    assert.deepStrictEqual(
      firstConnected.map((client) => client.clientId()),
      [1, 2]
    );
    assert.deepStrictEqual(
      secondConnected.map((client) => client.clientId()),
      [1, 2]
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
      "usb message fanout"
    );
    assert.strictEqual(firstMessages[0].id, 2);
    assert.strictEqual(secondMessages[0].id, 2);
    assert.strictEqual(
      parseCustomizedEnvelope(firstMessages[0].message).cdp.params.marker,
      "broadcast"
    );
    assert.strictEqual(
      parseCustomizedEnvelope(secondMessages[0].message).cdp.params.marker,
      "broadcast"
    );

    context.appendCommand({
      type: "remove-client",
      id: 2,
    });
    await waitFor(
      () => !first.usbClients.has(2) && !second.usbClients.has(2),
      2000,
      "dynamic client removal"
    );
    assert.deepStrictEqual(firstDisconnected, [2]);
    assert.deepStrictEqual(secondDisconnected, [2]);

    await Promise.all([first.close(), second.close()]);
    await waitFor(
      () => !processExists(daemonPid),
      2500,
      "shared daemon idle cleanup"
    );

    const startedPids = new Set(
      context
        .readLog()
        .filter((entry) => entry.event === "daemon-started")
        .map((entry) => entry.pid)
    );
    assert.deepStrictEqual([...startedPids], [daemonPid]);
  } finally {
    await context.cleanup();
  }
}

async function runLegacyPreemptionFlow() {
  logStep("checking legacy owner preemption and reacquire flow");
  const context = createContext("legacy-preemption", defaultState(), {
    multiplexerDaemonIdleTimeout: 7000,
  });

  try {
    const connector = context.createConnector({
      rpcTimeout: 3000,
      startupTimeout: 5000,
    });
    const multiOpenStatuses = [];
    const disconnectedDevices = [];
    const disconnectedClients = [];
    connector.setMultiOpenCallback({
      statusChanged(status) {
        multiOpenStatuses.push(status);
      },
    });
    connector.on("device-disconnected", (device) =>
      disconnectedDevices.push(device.serial)
    );
    connector.on("client-disconnected", (id) => disconnectedClients.push(id));

    await connector.connectDevices(-1, null, true);
    const initialWatchCount = countLogEvents(
      context,
      "device-start-watch"
    );
    connector.startWatchAllClients(false);
    await waitFor(
      () =>
        countLogEvents(context, "device-start-watch") > initialWatchCount,
      2000,
      "initial legacy watch all clients"
    );
    await connector.connectUsbClients("device-1", -1, true, null);

    const daemon = await waitFor(
      () => findDaemonProcess(context.paths.daemonProcessName),
      3000,
      "legacy preemption daemon process"
    );
    assert(processExists(daemon.pid), "daemon should be alive");
    await waitFor(
      () => readOwnerPid(context.legacyOwnerPath) === daemon.pid,
      3000,
      "daemon owns legacy owner file"
    );

    fs.mkdirSync(context.legacyDriverDir, { recursive: true });
    fs.writeFileSync(context.legacyOwnerPath, `${process.pid}`, "utf8");
    await waitFor(
      () => multiOpenStatuses.includes(MultiOpenStatus.unattached),
      3000,
      "connector receives legacy unattached status"
    );
    await waitFor(
      () =>
        connector.devices.size === 0 &&
        connector.usbClients.size === 0 &&
        countLogEvents(context, "disable-all-clients") > 0,
      3000,
      "connector device and runtime mirrors cleared after legacy preemption"
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
        ports: [9301],
        host: "127.0.0.1",
      },
    });
    context.appendCommand({
      type: "add-client",
      client: {
        id: 2,
        deviceId: "device-2",
        app: "Recovered",
        processName: "com.recovered",
        port: 9302,
      },
    });
    await waitFor(
      () => {
        const log = context.readLog();
        return (
          log.some(
            (entry) =>
              entry.event === "device-added" && entry.serial === "device-2"
          ) &&
          log.some((entry) => entry.event === "client-added" && entry.id === 2)
        );
      },
      2000,
      "fake physical updates while preempted"
    );
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
      3000,
      "daemon reacquires legacy owner"
    );
    assert.strictEqual(readOwnerPid(context.legacyOwnerPath), daemon.pid);

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
  } finally {
    await context.cleanup();
  }
}

async function runWebSocketMirrorRecoveryFlow() {
  logStep("checking package-entry websocket mirror and daemon recovery");
  const context = createContext("wss-recovery", defaultState(), {
    multiplexerDaemonIdleTimeout: 7000,
  });
  let initialPid;

  try {
    const connector = context.createConnector({
      enableWebSocket: true,
      websocketOption: {
        port: 0,
        roomId: "e2e-wss-recovery",
      },
      rpcTimeout: 3000,
      startupTimeout: 5000,
    });
    const disconnectedDevices = [];
    const disconnectedClients = [];
    connector.on("device-disconnected", (device) =>
      disconnectedDevices.push(device.serial)
    );
    connector.on("client-disconnected", (id) => disconnectedClients.push(id));

    await connector.connectDevices(-1, null, true);
    const initialWatchCount = countLogEvents(
      context,
      "device-start-watch"
    );
    connector.startWatchAllClients(false);
    await waitFor(
      () =>
        countLogEvents(context, "device-start-watch") > initialWatchCount,
      2000,
      "initial WatchAllClients"
    );
    await connector.connectUsbClients("device-1", -1, true, null);
    await connector.startWSServer();

    const daemon = await waitFor(
      () => findDaemonProcess(context.paths.daemonProcessName),
      2000,
      "websocket recovery daemon process"
    );
    initialPid = daemon.pid;
    assert(connector.wssPort > 0, "websocket port should be assigned");
    assert.deepStrictEqual(connector.wss, {
      wssPath: `ws://${connector.wssHost}/mdevices/page/android`,
    });

    process.kill(initialPid, "SIGKILL");
    await waitFor(
      () =>
        connector.wss === null &&
        connector.devices.size === 0 &&
        connector.usbClients.size === 0,
      3000,
      "websocket mirror cleared after daemon kill"
    );
    assert.strictEqual(connector.desiredWSServerStarted, true);
    assert.strictEqual(connector.desiredWatchAllClientsStarted, true);
    assert.deepStrictEqual(disconnectedClients, [1]);
    assert.deepStrictEqual(disconnectedDevices, ["device-1"]);
    await waitFor(
      () => !processExists(initialPid),
      3000,
      "old websocket daemon exits"
    );

    const replacement = await waitFor(
      async () => {
        const next = await findDaemonProcess(context.paths.daemonProcessName);
        if (
          next?.pid &&
          next.pid !== initialPid &&
          processExists(next.pid) &&
          connector.devices.has("device-1") &&
          connector.usbClients.has(1) &&
          context
            .readLog()
            .some(
              (entry) =>
                entry.event === "device-start-watch" &&
                entry.pid === next.pid
            ) &&
          connector.wss?.wssPath ===
            `ws://${connector.wssHost}/mdevices/page/android`
        ) {
          return next;
        }
        return null;
      },
      10000,
      "websocket mirror restored after daemon respawn"
    );
    assert.notStrictEqual(replacement.pid, initialPid);
    assert.deepStrictEqual(connector.wss, {
      wssPath: `ws://${connector.wssHost}/mdevices/page/android`,
    });
    assert.strictEqual(connector.devices.has("device-1"), true);
    assert.strictEqual(connector.usbClients.has(1), true);
  } finally {
    await context.cleanup();
  }
}

async function runCompatibilityUpgradeFlow() {
  logStep("checking daemon compatibility upgrade and connector reconnect");
  const context = createContext("compat-upgrade", defaultState(), {
    multiplexerDaemonIdleTimeout: 150,
  });

  try {
    const v1 = createVersionedControl(context, "connector-v1", 1);
    await connectRuntime(v1.client);
    const daemonV1 = await waitForDiscoveryProtocol(context, 1);
    assert.strictEqual(daemonV1.debugInfo.daemonVersion, "connector-v1");

    const v2 = createVersionedControl(context, "connector-v2", 2);
    await assert.rejects(
      () => connectRuntime(v2.client),
      /daemon is still in use by a connector or WebSocket frontend/
    );
    assert.strictEqual(
      (await waitForDiscoveryProtocol(context, 1)).pid,
      daemonV1.pid
    );

    await v1.client.close();
    await connectRuntime(v2.client);
    const daemonV2 = await waitForDiscoveryProtocol(context, 2);
    assert.notStrictEqual(daemonV2.pid, daemonV1.pid);
    assert.strictEqual(daemonV2.debugInfo.daemonVersion, "connector-v2");
    await waitFor(
      () => !processExists(daemonV1.pid),
      3000,
      "v1 daemon replaced"
    );

    await reconnectDaemonClient(v1.client);
    await connectRuntime(v1.client);
    await connectRuntime(v2.client);

    const v3 = createVersionedControl(context, "connector-v3", 3);
    await assert.rejects(
      () => connectRuntime(v3.client),
      /daemon is still in use by a connector or WebSocket frontend/
    );
    assert.strictEqual(
      (await waitForDiscoveryProtocol(context, 2)).pid,
      daemonV2.pid
    );

    await v1.client.close();
    await v2.client.close();
    await connectRuntime(v3.client);
    const daemonV3 = await waitForDiscoveryProtocol(context, 3);
    assert.notStrictEqual(daemonV3.pid, daemonV2.pid);
    assert.strictEqual(daemonV3.debugInfo.daemonVersion, "connector-v3");
    await waitFor(
      () => !processExists(daemonV2.pid),
      3000,
      "v2 daemon replaced"
    );

    await reconnectDaemonClient(v1.client);
    await reconnectDaemonClient(v2.client);
    await reconnectDaemonClient(v3.client);
    await connectRuntime(v2.client);
    await connectRuntime(v3.client);

    await Promise.all([
      v1.client.close(),
      v2.client.close(),
      v3.client.close(),
    ]);
    await waitFor(
      () => !processExists(daemonV3.pid),
      2500,
      "upgrade daemon idle cleanup"
    );

    const startedPids = context
      .readLog()
      .filter((entry) => entry.event === "daemon-started")
      .map((entry) => entry.pid);
    assert.deepStrictEqual(startedPids, [
      daemonV1.pid,
      daemonV2.pid,
      daemonV3.pid,
    ]);
  } finally {
    await context.cleanup();
  }
}

function createVersionedControl(context, name, protocolVersion) {
  const discovery = new MultiplexerDiscovery({
    controlEndpoint: context.paths.controlEndpoint,
    localProtocolVersion: protocolVersion,
  });
  const manager = new MultiplexerDaemonManager({
    discovery,
    daemonProcessName: context.paths.daemonProcessName,
    controlEndpoint: context.paths.controlEndpoint,
    spawnLockPath: context.paths.spawnLockPath,
    daemonEntry: fakeDaemonEntry,
    startupTimeout: 3000,
    readyPollInterval: 10,
    replacementTimeout: 50,
    localProtocolVersion: protocolVersion,
    debugInfo: {
      daemonVersion: name,
    },
    multiplexerDaemonIdleTimeout: 150,
    enableWebSocket: false,
  });
  const client = new MultiplexerDaemonClient({
    daemonManager: manager,
    controlEndpoint: context.paths.controlEndpoint,
    rpcTimeout: 2000,
    debugInfo: {
      protocolVersion,
      clientVersion: name,
    },
  });
  return { manager, client };
}

async function connectRuntime(client) {
  const devices = await client.call("connectDevices", {
    timeout: -1,
    serial: null,
    isAutoListenClients: true,
  });
  assert.deepStrictEqual(
    devices.map((device) => device.serial),
    ["device-1"]
  );

  const clients = await client.call("connectUsbClients", {
    deviceId: "device-1",
    timeout: -1,
    waitTimeout: true,
    clientName: null,
  });
  assert.deepStrictEqual(
    clients.map((client) => client.id),
    [1]
  );
}

async function waitForDiscoveryProtocol(context, protocolVersion) {
  return waitFor(
    async () => {
      const owner = await findDaemonProcess(context.paths.daemonProcessName);
      if (!owner) {
        return null;
      }
      const result = await new MultiplexerDiscovery({
        controlEndpoint: context.paths.controlEndpoint,
        localProtocolVersion: protocolVersion,
      }).probeHealth();
      if (
        !("daemonProtocolVersion" in result) ||
        result.daemonProtocolVersion !== protocolVersion
      ) {
        return null;
      }
      const started = context
        .readLog()
        .filter(
          (entry) =>
            entry.event === "daemon-started" &&
            entry.pid === owner.pid &&
            entry.protocolVersion === protocolVersion
        )
        .at(-1);
      return started ? { pid: owner.pid, ...started } : null;
    },
    3000,
    `daemon protocol ${protocolVersion}`
  );
}

function parseCustomizedEnvelope(message) {
  const envelope = JSON.parse(message);
  const payload = envelope.data?.data?.message;
  return {
    envelope,
    cdp: typeof payload === "string" ? JSON.parse(payload) : payload,
  };
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

async function reconnectDaemonClient(client) {
  await client.controlTransport?.end();
  await client.connect();
}

async function main() {
  await runEmptyDaemonFlow();
  await runSharedDaemonMirrorFlow();
  await runLegacyPreemptionFlow();
  await runWebSocketMirrorRecoveryFlow();
  await runCompatibilityUpgradeFlow();
  logStep("TEST SUCCESS");
}

main().catch((error) => {
  console.error("[multiplexer-no-device-e2e] TEST FAILED");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
