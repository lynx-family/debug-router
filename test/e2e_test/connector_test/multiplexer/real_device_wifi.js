// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");

const { DebugRouterConnector } = require("@lynx-js/debug-router-connector");
const {
  createMultiplexerPaths,
} = require("@lynx-js/debug-router-connector/dist/cjs/src/multiplexer/utils/paths");
const { stopDaemonProcesses } = require("./daemon_process");

const DEFAULT_ANDROID_ACTIVITY =
  "com.lynx.debugrouter.testapp/com.lynx.debugrouter.testapp.MainActivity";
const DEFAULT_TIMEOUT = 10000;
const DEFAULT_IDLE_TIMEOUT = 30000;
const DEFAULT_MESSAGE_METHOD = "ConnectorRealDeviceE2E.Ping";
const DEFAULT_CDP_MESSAGE_METHOD = "ConnectorRealDeviceE2E.CDP.Ping";
const adbCommand = process.env.DEBUG_ROUTER_E2E_ADB ?? "adb";
const fakeDaemonEntry = path.resolve(
  __dirname,
  "../../../integration/multiplexer/fixtures/fake_daemon_entry.js"
);

const cases = [
  ["registration", "real Android WiFi registration", runRegistrationCase],
  ["lifecycle", "public WiFi lifecycle and mirrors", runPublicLifecycleCase],
  ["roundtrip", "Driver to real Android WiFi roundtrip", runRoundTripCase],
  [
    "cdp-roundtrip",
    "Driver to real Android WiFi session CDP roundtrip",
    runCdpRoundTripCase,
  ],
  [
    "proxy",
    "Connector proxy to real Android WiFi roundtrip",
    runProxyRoundTripCase,
  ],
  ["disconnect", "real Android WiFi disconnect cleanup", runDisconnectCase],
];

main().catch((error) => {
  console.error("[multiplexer-real-device-wifi-e2e] TEST RUNNER FAILED");
  console.error(error?.stack ?? error);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serial = await selectAndroidDevice(args.androidSerial);
  const failures = [];
  const selectedCases =
    args.caseName === "all"
      ? cases
      : cases.filter(([id]) => id === args.caseName);

  logStep(`using Android device ${serial}`);
  for (const [, name, run] of selectedCases) {
    try {
      await run(args, serial);
      logStep(`PASS: ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`[multiplexer-real-device-wifi-e2e] FAIL: ${name}`);
      console.error(error?.stack ?? error);
    }
  }

  await forceStopAndroidApp(serial, args.androidActivity).catch(() => {});
  if (failures.length > 0) {
    throw new Error(
      `${failures.length}/${selectedCases.length} real-device WiFi cases failed`
    );
  }
  logStep("TEST SUCCESS");
}

function parseArgs(argv) {
  const args = {
    androidSerial: "",
    androidActivity: DEFAULT_ANDROID_ACTIVITY,
    timeout: DEFAULT_TIMEOUT,
    multiplexerDaemonIdleTimeout: DEFAULT_IDLE_TIMEOUT,
    messageMethod: DEFAULT_MESSAGE_METHOD,
    caseName: "all",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index++;
      return value;
    };

    if (arg === "--android-serial") {
      args.androidSerial = readValue();
    } else if (arg === "--android-activity") {
      args.androidActivity = readValue();
    } else if (arg === "--timeout") {
      args.timeout = Number(readValue());
    } else if (arg === "--daemon-idle-timeout") {
      args.multiplexerDaemonIdleTimeout = Number(readValue());
    } else if (arg === "--message-method") {
      args.messageMethod = readValue();
    } else if (arg === "--case") {
      args.caseName = readValue();
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const key of ["timeout", "multiplexerDaemonIdleTimeout"]) {
    if (!Number.isFinite(args[key]) || args[key] <= 0) {
      throw new Error(`${key} must be a positive number`);
    }
  }
  const caseNames = cases.map(([id]) => id);
  if (args.caseName !== "all" && !caseNames.includes(args.caseName)) {
    throw new Error(
      `Unknown --case ${args.caseName}. Expected one of: all, ${caseNames.join(
        ", "
      )}`
    );
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node multiplexer/real_device_wifi.js
  node multiplexer/real_device_wifi.js --android-serial <serial>

The Android DebugRouter test app must already be installed. ADB is used only
to launch/stop the app; the DebugRouter transport uses the host LAN WebSocket.

Options:
  --android-serial <serial>
  --android-activity <package/activity>
  --timeout <ms>
  --daemon-idle-timeout <ms>
  --message-method <method>
  --case <name>                     run one named case; default all
`);
}

async function runRegistrationCase(args, serial) {
  await withConnectedRuntime("registration", args, serial, async (state) => {
    assertRealWiFiRuntime(state.runtime, state.mobileWebSocketUrl, args);
  });
}

async function runPublicLifecycleCase(args, serial) {
  await withConnectedRuntime(
    "public-lifecycle",
    args,
    serial,
    async (state) => {
      const runtimeId = state.runtime.id;
      const client = await waitFor(
        () =>
          state.connected.find(
            (candidate) => clientIdOf(candidate) === runtimeId
          ),
        args.timeout,
        "Connector websocket-app-client-connected event"
      );

      assert.strictEqual(
        typeof client.clientId,
        "function",
        "the public event should expose a WebSocket client proxy"
      );
      assert.strictEqual(client.type(), "runtime");
      assert.strictEqual(client.info.network, "WiFi");
      assert.strictEqual(typeof client.sendCustomizedMessage, "function");
      assert.strictEqual(typeof client.close, "function");
      assert(
        state.connector
          .getAllWebsocketAppClients()
          .some((candidate) => clientIdOf(candidate) === runtimeId),
        "Connector should mirror the real WiFi runtime"
      );
      assert(
        state.connector
          .getAllAppClients()
          .some((candidate) => clientIdOf(candidate) === runtimeId),
        "Connector app-client mirror should include the real WiFi runtime"
      );
    }
  );
}

async function runRoundTripCase(args, serial) {
  await withConnectedRuntime("roundtrip", args, serial, async (state) => {
    const requestId = 91001;
    const marker = `android-wifi-${Date.now()}`;
    const responseWait = waitForSocketMessage(
      state.driver.socket,
      (message) => {
        if (message?.event !== "Customized") {
          return false;
        }
        const payload = parseCustomizedPayload(message);
        return payload?.id === requestId;
      },
      args.timeout,
      "real Android WiFi message response"
    );

    state.driver.socket.send(
      createCustomizedEnvelope(
        state.runtime.id,
        requestId,
        args.messageMethod,
        marker
      )
    );
    const response = await responseWait;
    const payload = parseCustomizedPayload(response);
    logStep(`roundtrip response=${JSON.stringify(payload)}`);
    const result = parseAppResult(payload);
    assert.strictEqual(payload.id, requestId);
    assert.strictEqual(result?.ok, true);
    assert.strictEqual(result?.method, args.messageMethod);
    assert.strictEqual(result?.params?.marker, marker);
  });
}

async function runCdpRoundTripCase(args, serial) {
  await withConnectedRuntime("cdp-roundtrip", args, serial, async (state) => {
    const requestId = 92001;
    const marker = `android-wifi-cdp-${Date.now()}`;
    const responseWait = waitForSocketMessage(
      state.driver.socket,
      (message) => {
        if (message?.event !== "Customized" || message?.data?.type !== "CDP") {
          return false;
        }
        const payload = parseCustomizedPayload(message);
        return payload?.id === requestId;
      },
      args.timeout,
      "real Android WiFi session CDP response"
    );

    state.driver.socket.send(
      createCdpEnvelope(
        state.runtime.id,
        requestId,
        DEFAULT_CDP_MESSAGE_METHOD,
        marker
      )
    );
    const response = await responseWait;
    const payload = parseCustomizedPayload(response);
    logStep(`cdp-roundtrip response=${JSON.stringify(payload)}`);
    assert.strictEqual(payload.id, requestId);
    assert.strictEqual(payload.result?.ok, true);
    assert.strictEqual(payload.result?.method, DEFAULT_CDP_MESSAGE_METHOD);
    assert.strictEqual(payload.result?.params?.marker, marker);
  });
}

async function runProxyRoundTripCase(args, serial) {
  await withConnectedRuntime("proxy-roundtrip", args, serial, async (state) => {
    const proxy = await waitFor(
      () =>
        state.connector
          .getAllWebsocketAppClients()
          .find((client) => clientIdOf(client) === state.runtime.id),
      args.timeout,
      "Connector real WiFi client proxy"
    );
    const marker = `android-wifi-proxy-${Date.now()}`;
    const response = JSON.parse(
      await proxy.sendCustomizedMessage(
        args.messageMethod,
        { marker },
        -1,
        "App"
      )
    );
    logStep(`proxy-roundtrip response=${JSON.stringify(response)}`);
    const result = parseAppResult(response);

    assert.strictEqual(result?.ok, true);
    assert.strictEqual(result?.method, args.messageMethod);
    assert.strictEqual(result?.params?.marker, marker);

    const cdpMarker = `android-wifi-proxy-cdp-${Date.now()}`;
    const cdpResponse = JSON.parse(
      await proxy.sendCustomizedMessage(
        DEFAULT_CDP_MESSAGE_METHOD,
        { marker: cdpMarker },
        1,
        "CDP"
      )
    );
    logStep(`proxy-cdp-roundtrip response=${JSON.stringify(cdpResponse)}`);
    assert.strictEqual(cdpResponse.result?.ok, true);
    assert.strictEqual(cdpResponse.result?.method, DEFAULT_CDP_MESSAGE_METHOD);
    assert.strictEqual(cdpResponse.result?.params?.marker, cdpMarker);
  });
}

async function runDisconnectCase(args, serial) {
  await withConnectedRuntime("disconnect", args, serial, async (state) => {
    const runtimeId = state.runtime.id;
    await forceStopAndroidApp(serial, args.androidActivity);

    await waitFor(
      () => state.disconnected.includes(runtimeId),
      args.timeout,
      "Connector websocket-app-client-disconnected event"
    );
    await waitFor(
      () =>
        !state.connector
          .getAllWebsocketAppClients()
          .some((candidate) => clientIdOf(candidate) === runtimeId),
      args.timeout,
      "Connector real WiFi mirror cleanup"
    );
    await waitForRuntimeAbsent(
      state.driver,
      runtimeId,
      args.timeout,
      "Driver ClientList real WiFi cleanup"
    );
  });
}

async function withConnectedRuntime(name, args, serial, run) {
  const context = createContext(name, args);
  try {
    const connector = context.createConnector();
    const connected = collect(connector, "websocket-app-client-connected");
    const disconnected = collect(
      connector,
      "websocket-app-client-disconnected"
    );
    await connector.connectDevices(-1, null, true);
    await connector.startWSServer();

    const mobileWebSocketUrl = getMobileWebSocketUrl(connector);
    const driver = await connectDriverWebSocket(
      `ws://127.0.0.1:${connector.wssPort}/mdevices/page/android`,
      `android-wifi-driver-${name}`,
      args.timeout
    );
    context.trackSocket(driver.socket);

    await launchAndroidWiFiApp(
      serial,
      args.androidActivity,
      mobileWebSocketUrl,
      connector.roomId
    );
    const runtime = await waitForRuntime(
      driver,
      args.timeout,
      `real Android WiFi runtime for ${name}`
    );
    assertRealWiFiRuntime(runtime, mobileWebSocketUrl, args);
    logStep(
      `${name}: device=${serial} runtime=${runtime.id} url=${mobileWebSocketUrl}`
    );

    await run({
      connector,
      connected,
      disconnected,
      driver,
      mobileWebSocketUrl,
      runtime,
    });
  } finally {
    await forceStopAndroidApp(serial, args.androidActivity).catch(() => {});
    await context.cleanup();
  }
}

function createContext(name, args) {
  const rootDir = fs.mkdtempSync(
    path.join(getIpcTestTempDir(), `debug-router-real-wifi-android-${name}-`)
  );
  const homeDir = path.join(rootDir, "home");
  const legacyDriverDir = path.join(homeDir, ".DebugRouterConnector");
  const paths = createMultiplexerPaths({ rootDir });
  const dataDir = paths.dataDir;
  const originalHome = process.env.HOME;
  const hadHome = Object.prototype.hasOwnProperty.call(process.env, "HOME");
  const connectors = [];
  const sockets = [];
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "fake_physical_state.json"),
    JSON.stringify({ devices: [], clients: [] })
  );
  process.env.HOME = homeDir;

  return {
    createConnector() {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableAndroid: false,
        enableIOS: false,
        enableHarmony: false,
        enableDesktop: false,
        enableNetworkDevice: false,
        enableWebSocket: true,
        websocketOption: {
          port: 0,
          roomId: `real-wifi-android-${name}`,
        },
        multiplexerRootDir: rootDir,
        multiplexerLegacyDriverDir: legacyDriverDir,
        multiplexerDaemonEntry: fakeDaemonEntry,
        multiplexerStartupTimeout: 8000,
        multiplexerRpcTimeout: args.timeout,
        multiplexerDaemonIdleTimeout: args.multiplexerDaemonIdleTimeout,
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
        if (process.env.DEBUG_ROUTER_KEEP_E2E_TMP === "1") {
          logStep(`preserving temporary files at ${rootDir}`);
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

function getMobileWebSocketUrl(connector) {
  assert(connector.wssPort > 0, "WebSocket server should expose a port");
  assert(connector.wss?.wssPath, "Connector should expose its WebSocket path");
  const url = new URL(connector.wss.wssPath);
  const host = url.hostname;
  assert(
    net.isIP(host),
    `Expected an IP address reachable by the phone, got ${host}`
  );
  assert(
    !isLoopbackOrLinkLocal(host),
    `Refusing non-WiFi E2E address ${host}; connect the computer and phone to the same LAN`
  );
  return url.toString();
}

function isLoopbackOrLinkLocal(host) {
  return (
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("169.254.") ||
    host.toLowerCase().startsWith("fe80:")
  );
}

async function selectAndroidDevice(requestedSerial) {
  const output = await execFile(adbCommand, ["devices"], 10000);
  const devices = output
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => /\tdevice$/.test(line))
    .map((line) => line.split(/\s+/)[0]);

  if (requestedSerial) {
    assert(
      devices.includes(requestedSerial),
      `Android device ${requestedSerial} is not online. adb devices: ${devices.join(
        ", "
      )}`
    );
    return requestedSerial;
  }
  assert(
    devices.length > 0,
    "No online Android device found. Connect and authorize one with adb first."
  );
  assert(
    devices.length === 1,
    `Multiple Android devices found (${devices.join(
      ", "
    )}); pass --android-serial`
  );
  return devices[0];
}

async function launchAndroidWiFiApp(serial, activity, websocketUrl, roomId) {
  const packageName = androidPackage(activity);
  const schema =
    `lynx://remote_debug_lynx/enable?url=${encodeURIComponent(websocketUrl)}` +
    `&room=${encodeURIComponent(roomId ?? "")}`;
  await execFile(
    adbCommand,
    ["-s", serial, "shell", "am", "force-stop", packageName],
    10000
  );
  const output = await execFile(
    adbCommand,
    [
      "-s",
      serial,
      "shell",
      "am",
      "start",
      "-n",
      activity,
      "--es",
      "connection_type",
      "websocket",
      "--es",
      "websocket_schema",
      schema,
    ],
    15000
  );
  assert(!output.includes("Error:"), `Failed to launch Android app: ${output}`);
}

function forceStopAndroidApp(serial, activity) {
  return execFile(
    adbCommand,
    ["-s", serial, "shell", "am", "force-stop", androidPackage(activity)],
    10000
  );
}

function androidPackage(activity) {
  const packageName = activity.split("/")[0];
  assert(packageName, `Invalid Android activity ${activity}`);
  return packageName;
}

async function connectDriverWebSocket(url, app, timeout) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on("message", (data) => {
    const value = parseJson(data.toString()) ?? data.toString();
    messages.push(value);
    if (value?.event === "Initialize") {
      socket.send(
        JSON.stringify({
          event: "Register",
          data: {
            id: value.data,
            type: "Driver",
            info: {
              app,
              debugRouterVersion: "real-device-wifi-e2e",
              deviceModel: "Driver",
              osVersion: process.platform,
              sdkVersion: "real-device-wifi-e2e",
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
  await waitFor(
    () => messages.find((message) => message?.event === "RoomJoined"),
    timeout,
    `${app} RoomJoined`
  );
  return { socket, messages };
}

async function waitForRuntime(driver, timeout, label) {
  return waitFor(
    () => {
      if (driver.socket.readyState !== WebSocket.OPEN) {
        throw new Error(
          "Driver WebSocket closed while waiting for WiFi runtime"
        );
      }
      driver.socket.send(JSON.stringify({ event: "ListClients" }));
      return latestClientList(driver.messages).find(
        (client) => client.type === "runtime" && client.info?.network === "WiFi"
      );
    },
    timeout,
    label,
    250
  );
}

async function waitForRuntimeAbsent(driver, runtimeId, timeout, label) {
  let observedList = false;
  return waitFor(
    () => {
      if (driver.socket.readyState !== WebSocket.OPEN) {
        throw new Error(
          "Driver WebSocket closed while waiting for WiFi cleanup"
        );
      }
      driver.socket.send(JSON.stringify({ event: "ListClients" }));
      const list = latestClientList(driver.messages);
      observedList ||= driver.messages.some(
        (message) => message?.event === "ClientList"
      );
      return observedList && !list.some((client) => client.id === runtimeId);
    },
    timeout,
    label,
    250
  );
}

function assertRealWiFiRuntime(runtime, websocketUrl, args) {
  const expectedPackage = androidPackage(args.androidActivity);
  assert.strictEqual(runtime.type, "runtime");
  assert.strictEqual(runtime.info?.network, "WiFi");
  assert.strictEqual(
    runtime.info?.App,
    expectedPackage,
    `Expected the real Android app ${expectedPackage}, got ${JSON.stringify(
      runtime.info
    )}`
  );
  const host = new URL(websocketUrl).hostname;
  assert(!isLoopbackOrLinkLocal(host));
}

function createCustomizedEnvelope(clientId, id, method, marker) {
  return JSON.stringify({
    event: "Customized",
    data: {
      type: "App",
      data: {
        client_id: clientId,
        session_id: -1,
        message: {
          id,
          method,
          params: { marker },
        },
      },
      sender: 0,
    },
  });
}

function createCdpEnvelope(clientId, id, method, marker) {
  return JSON.stringify({
    event: "Customized",
    data: {
      type: "CDP",
      data: {
        client_id: clientId,
        session_id: 1,
        message: JSON.stringify({
          id,
          method,
          params: { marker },
        }),
      },
      sender: 0,
    },
  });
}

function parseCustomizedPayload(message) {
  const payload = message?.data?.data?.message;
  return typeof payload === "string" ? parseJson(payload) : payload;
}

function parseAppResult(payload) {
  return typeof payload?.result === "string"
    ? parseJson(payload.result)
    : payload?.result;
}

function waitForSocketMessage(socket, predicate, timeout, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout after ${timeout}ms: ${label}`));
    }, timeout);
    const onMessage = (data) => {
      const value = parseJson(data.toString()) ?? data.toString();
      if (predicate(value)) {
        cleanup();
        resolve(value);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`WebSocket closed while waiting for ${label}`));
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

function collect(connector, event) {
  const payloads = [];
  connector.on(event, (payload) => payloads.push(payload));
  return payloads;
}

function latestClientList(messages) {
  return (
    [...messages].reverse().find((message) => message?.event === "ClientList")
      ?.data ?? []
  );
}

function clientIdOf(client) {
  return typeof client?.clientId === "function"
    ? client.clientId()
    : client?.id;
}

async function waitFor(predicate, timeout, label, interval = 100) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
      if (error?.message?.includes("WebSocket closed")) {
        throw error;
      }
    }
    await delay(interval);
  }
  throw new Error(
    `Timeout after ${timeout}ms: ${label}${
      lastError ? `; last error: ${lastError.message}` : ""
    }`
  );
}

function execFile(command, args, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = childProcess.execFile(
      command,
      args,
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      }
    );
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`timeout:${timeout} exec:${command} ${args.join(" ")}`));
    }, timeout);
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function delay(timeout) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

function logStep(message) {
  console.log(`[multiplexer-real-device-wifi-e2e] ${message}`);
}
