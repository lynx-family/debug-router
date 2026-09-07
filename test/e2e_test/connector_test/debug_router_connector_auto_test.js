const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const {
  DebugRouterConnector,
} = require("@lynx-js/debug-router-connector");

const DEFAULT_ANDROID_ACTIVITY =
  "com.lynx.debugrouter.testapp/com.lynx.debugrouter.testapp.MainActivity";
const DEFAULT_DEVICE_TIMEOUT = 6000;
const DEFAULT_CLIENT_TIMEOUT = 6000;

function parseArgs(argv) {
  const args = {
    mode: "no-device",
    platform: "android",
    serial: "",
    deviceTimeout: DEFAULT_DEVICE_TIMEOUT,
    clientTimeout: DEFAULT_CLIENT_TIMEOUT,
    androidActivity: DEFAULT_ANDROID_ACTIVITY,
    launchAndroidApp: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      i++;
      return value;
    };

    if (arg === "--mode") {
      args.mode = readValue();
    } else if (arg === "--platform") {
      args.platform = readValue();
    } else if (arg === "--serial") {
      args.serial = readValue();
    } else if (arg === "--device-timeout") {
      args.deviceTimeout = Number(readValue());
    } else if (arg === "--client-timeout") {
      args.clientTimeout = Number(readValue());
    } else if (arg === "--android-activity") {
      args.androidActivity = readValue();
    } else if (arg === "--no-launch-app") {
      args.launchAndroidApp = false;
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["no-device", "real-device"].includes(args.mode)) {
    throw new Error(`Unsupported --mode: ${args.mode}`);
  }
  if (!["android", "ios", "harmony", "all"].includes(args.platform)) {
    throw new Error(`Unsupported --platform: ${args.platform}`);
  }
  if (!Number.isFinite(args.deviceTimeout) || args.deviceTimeout <= 0) {
    throw new Error("--device-timeout must be a positive number");
  }
  if (!Number.isFinite(args.clientTimeout) || args.clientTimeout <= 0) {
    throw new Error("--client-timeout must be a positive number");
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  node debug_router_connector_auto_test.js --mode no-device
  node debug_router_connector_auto_test.js --mode real-device --platform android

Modes:
  no-device    Runs without phones. Verifies empty discovery and a local
               NetworkDevice handshake through the public connector API.
  real-device  Requires a phone with the DebugRouter test app. Verifies physical
               device discovery, USB client registration, public events, and
               connection trace integration.

Options:
  --platform android|ios|harmony|all
  --serial <device serial or UDID>
  --device-timeout <ms>
  --client-timeout <ms>
  --android-activity <package/activity>
  --no-launch-app
`);
}

function logStep(message) {
  console.log(`[connector-auto-test] ${message}`);
}

function withTimeout(promise, timeout, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeout}ms: ${label}`));
    }, timeout);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitFor(check, timeout, label, interval = 50) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (check()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() - startedAt >= timeout) {
        reject(new Error(`Timeout after ${timeout}ms: ${label}`));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

function exec(command, timeout) {
  return new Promise((resolve, reject) => {
    const child = childProcess.exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout:${timeout} exec:${command}`));
    }, timeout);
    child.on("exit", () => clearTimeout(timer));
  });
}

function makeTempTracePath(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return {
    dir,
    tracePath: path.join(dir, "connection-trace.jsonl"),
  };
}

function packMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(20);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(101, 4);
  header.writeUInt32BE(0, 8);
  header.writeUInt32BE(payload.length + 4, 12);
  header.writeUInt32BE(payload.length, 16);
  return Buffer.concat([header, payload]);
}

function createFrameParser(onMessage) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 20) {
      const payloadSize = buffered.readUInt32BE(16);
      const frameSize = 20 + payloadSize;
      if (buffered.length < frameSize) {
        return;
      }
      const payload = buffered.slice(20, frameSize).toString("utf8");
      buffered = buffered.slice(frameSize);
      onMessage(JSON.parse(payload));
    }
  };
}

async function startFakeDebugRouterAppServer() {
  const sockets = new Set();
  const receivedMessages = [];
  const appName = "connector-auto-test-app";

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on(
      "data",
      createFrameParser((message) => {
        receivedMessages.push(message);
        if (message.event === "Initialize") {
          socket.write(
            packMessage({
              event: "Register",
              data: {
                id: message.data,
                info: {
                  App: appName,
                  sdkVersion: "auto-test",
                  deviceModel: "FakeNetworkDevice",
                  osVersion: process.platform,
                },
              },
            }),
          );
          return;
        }

        if (message.event === "Customized") {
          const requestMessage = message.data?.data?.message ?? {};
          socket.write(
            packMessage({
              event: "Customized",
              data: {
                type: message.data?.type ?? "App",
                data: {
                  client_id: message.data?.data?.client_id ?? -1,
                  session_id: message.data?.data?.session_id ?? -1,
                  message: JSON.stringify({
                    id: requestMessage.id,
                    result: {
                      ok: true,
                      method: requestMessage.method,
                      params: requestMessage.params,
                    },
                  }),
                },
                sender: -1,
              },
            }),
          );
        }
      }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    appName,
    port: server.address().port,
    receivedMessages,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

function getTraceEvents(driver) {
  return driver.getConnectionTrace().map((node) => node.event);
}

function assertTraceIncludes(driver, expectedEvents) {
  const events = getTraceEvents(driver);
  for (const event of expectedEvents) {
    assert(
      events.includes(event),
      `Expected trace event "${event}", got: ${events.join(", ")}`,
    );
  }
}

function assertFlatTraceShape(driver) {
  const trace = driver.getConnectionTrace();
  let previousSequence = 0;
  for (const node of trace) {
    assert.strictEqual(node.traceSchemaVersion, "0.1");
    assert.strictEqual(typeof node.sequence, "number");
    assert(
      node.sequence > previousSequence,
      `Expected trace sequence to increase, got ${previousSequence} then ${node.sequence}`,
    );
    assert(
      !Object.prototype.hasOwnProperty.call(node, "id"),
      "Trace node should not include record-time tree id",
    );
    assert(
      !Object.prototype.hasOwnProperty.call(node, "parentId"),
      "Trace node should not include record-time parentId",
    );
    previousSequence = node.sequence;
  }
}

function assertConnectionAttemptIds(driver, expectedEvents) {
  const trace = driver.getConnectionTrace();
  for (const event of expectedEvents) {
    const nodes = trace.filter((node) => node.event === event);
    assert(nodes.length > 0, `Expected trace event "${event}"`);
    for (const node of nodes) {
      assert(
        typeof node.connectionAttemptId === "string" &&
          node.connectionAttemptId.length > 0,
        `Expected ${event} to include connectionAttemptId`,
      );
    }
  }
}

function assertFakeFlowUsesOneConnectionAttempt(driver) {
  const trace = driver.getConnectionTrace();
  const registerNode = trace.find(
    (node) => node.event === "sdk_register_received",
  );
  assert(registerNode, "Expected sdk_register_received in trace");
  const connectionAttemptId = registerNode.connectionAttemptId;
  for (const event of ["usb_client_connected", "app_client_connected"]) {
    const node = trace.find((item) => item.event === event);
    assert(node, `Expected ${event} in trace`);
    assert.strictEqual(node.connectionAttemptId, connectionAttemptId);
  }
}

async function runEmptyDiscoveryCheck() {
  logStep("checking connector behavior with no device managers enabled");
  const driver = new DebugRouterConnector({
    manualConnect: true,
    enableWebSocket: false,
    enableAndroid: false,
    enableIOS: false,
    enableHarmony: false,
    enableDesktop: false,
    enableNetworkDevice: false,
  });

  try {
    const devices = await driver.connectDevices(100);
    assert.deepStrictEqual(devices, []);

    const clients = await driver.connectUsbClients("missing-device", 100, false);
    assert.deepStrictEqual(clients, []);
    assert.deepStrictEqual(driver.getConnectionTrace(), []);
  } finally {
    await driver.close();
  }
}

async function runFakeNetworkCheck() {
  logStep("checking no-device end-to-end flow with a local NetworkDevice");
  const fakeApp = await startFakeDebugRouterAppServer();
  const { dir, tracePath } = makeTempTracePath("debug-router-no-device");
  const liveTraceEvents = [];
  let driver;
  let unsubscribe = () => {};

  try {
    driver = new DebugRouterConnector({
      manualConnect: true,
      enableWebSocket: false,
      enableAndroid: false,
      enableIOS: false,
      enableHarmony: false,
      enableDesktop: false,
      enableNetworkDevice: true,
      networkDeviceOpt: {
        ip: "127.0.0.1",
        port: [fakeApp.port],
      },
      connectionTrace: {
        enabled: true,
        output: tracePath,
        bufferSize: 100,
      },
    });

    unsubscribe = driver.onConnectionTrace((node) => {
      liveTraceEvents.push(node.event);
    });

    const devices = await driver.connectDevices(1000);
    assert.strictEqual(devices.length, 1);
    assert.strictEqual(devices[0].serial, "127.0.0.1");

    const clients = await driver.connectUsbClients(
      devices[0].serial,
      4000,
      false,
    );
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].info.query.app, fakeApp.appName);
    assert.strictEqual(driver.getAllUsbClients().length, 1);

    const nonce = `nonce-${Date.now()}`;
    const response = await withTimeout(
      clients[0].sendClientMessage("ConnectorAutoTest.Ping", { nonce }),
      3000,
      "fake app ping response",
    );
    const payload = JSON.parse(response);
    assert.deepStrictEqual(payload.result, {
      ok: true,
      method: "ConnectorAutoTest.Ping",
      params: { nonce },
    });

    await waitFor(
      () => fakeApp.receivedMessages.some((msg) => msg.event === "Customized"),
      1000,
      "fake app receiving customized message",
    );

    assertTraceIncludes(driver, [
      "device_plugged",
      "device_registered",
      "client_watch_started",
      "socket_connected",
      "sdk_register_received",
      "usb_client_connected",
      "app_client_connected",
    ]);
    assertFlatTraceShape(driver);
    assertConnectionAttemptIds(driver, [
      "socket_connected",
      "sdk_register_received",
      "usb_client_connected",
      "app_client_connected",
    ]);
    assertFakeFlowUsesOneConnectionAttempt(driver);
    assert(
      liveTraceEvents.includes("usb_client_connected"),
      `Expected live trace to include usb_client_connected, got: ${liveTraceEvents.join(
        ", ",
      )}`,
    );

    await waitFor(
      () =>
        fs.existsSync(tracePath) &&
        fs.readFileSync(tracePath, "utf8").includes("usb_client_connected"),
      2000,
      "trace file flush",
    );

    unsubscribe();
  } finally {
    unsubscribe();
    await driver?.close();
    await fakeApp.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function platformOptions(platform) {
  return {
    enableAndroid: platform === "android" || platform === "all",
    enableIOS: platform === "ios" || platform === "all",
    enableHarmony: platform === "harmony" || platform === "all",
  };
}

function isDeviceForPlatform(device, platform) {
  if (platform === "all") {
    return true;
  }
  if (platform === "android") {
    return device.info.os === "Android";
  }
  if (platform === "ios") {
    return device.info.os === "iOS";
  }
  if (platform === "harmony") {
    return device.info.os === "Harmony";
  }
  return false;
}

async function launchAndroidAppIfNeeded(args, device) {
  if (
    !args.launchAndroidApp ||
    args.platform !== "android" ||
    device.info.os !== "Android"
  ) {
    return;
  }
  const serialArg = args.serial || device.serial;
  const serialPrefix = serialArg ? `-s ${serialArg} ` : "";
  const command = `adb ${serialPrefix}shell am start -n ${args.androidActivity} --es connection_type usb`;
  logStep(`launching Android test app: ${command}`);
  await exec(command, 10000);
}

async function runRealDeviceScenario(args) {
  logStep(`checking real-device flow for platform=${args.platform}`);
  const { dir, tracePath } = makeTempTracePath("debug-router-real-device");
  const flags = platformOptions(args.platform);
  const liveTraceEvents = [];
  let driver;

  try {
    driver = new DebugRouterConnector({
      manualConnect: true,
      enableWebSocket: false,
      enableAndroid: flags.enableAndroid,
      enableIOS: flags.enableIOS,
      enableHarmony: flags.enableHarmony,
      enableDesktop: false,
      enableNetworkDevice: false,
      connectionTrace: {
        enabled: true,
        output: tracePath,
        bufferSize: 500,
      },
    });

    driver.onConnectionTrace((node) => {
      liveTraceEvents.push(node.event);
    });

    const devices = await driver.connectDevices(
      args.deviceTimeout,
      args.serial || null,
    );
    const candidates = devices.filter((device) =>
      isDeviceForPlatform(device, args.platform),
    );
    assert(
      candidates.length > 0,
      `Expected at least one ${args.platform} device, got: ${devices
        .map((device) => `${device.serial}(${device.info.os})`)
        .join(", ")}`,
    );

    const device = candidates[0];
    await launchAndroidAppIfNeeded(args, device);

    const clients = await driver.connectUsbClients(
      device.serial,
      args.clientTimeout,
      false,
    );
    assert(
      clients.length > 0,
      `Expected at least one USB client for ${device.serial}. Make sure the DebugRouter test app is installed and running.`,
    );

    const client = clients[0];
    assert(client.clientId() > 0, "client id should be assigned by connector");
    assert.strictEqual(client.deviceId(), device.serial);
    assert(client.info.query.app, "client app name should be present");
    assert.strictEqual(driver.getAllUsbClients().length, clients.length);

    assertTraceIncludes(driver, [
      "device_registered",
      "client_watch_started",
      "socket_connected",
      "sdk_register_received",
      "usb_client_connected",
      "app_client_connected",
    ]);
    assertFlatTraceShape(driver);
    assertConnectionAttemptIds(driver, [
      "socket_connected",
      "sdk_register_received",
      "usb_client_connected",
      "app_client_connected",
    ]);
    assert(
      liveTraceEvents.includes("usb_client_connected"),
      `Expected live trace to include usb_client_connected, got: ${liveTraceEvents.join(
        ", ",
      )}`,
    );

    await waitFor(
      () =>
        fs.existsSync(tracePath) &&
        fs.readFileSync(tracePath, "utf8").includes("sdk_register_received"),
      2000,
      "real-device trace file flush",
    );

    logStep(
      `connected ${device.serial} (${device.info.os}) client=${client.clientId()} app=${client.info.query.app}`,
    );
  } finally {
    await driver?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "no-device") {
    await runEmptyDiscoveryCheck();
    await runFakeNetworkCheck();
  } else {
    await runRealDeviceScenario(args);
  }
  logStep("TEST SUCCESS");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[connector-auto-test] TEST FAILED");
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
