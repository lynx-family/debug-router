const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");

const {
  DebugRouterConnector,
  MultiOpenStatus,
} = require("@lynx-js/debug-router-connector");
const {
  createMultiplexerPaths,
  MULTIPLEXER_DAEMON_PROCESS_NAME_SUFFIX,
} = require("@lynx-js/debug-router-connector/dist/cjs/src/multiplexer/utils/paths");
const { findDaemonProcess, stopDaemonProcesses } = require("./daemon_process");

const DEFAULT_ANDROID_ACTIVITY =
  "com.lynx.debugrouter.testapp/com.lynx.debugrouter.testapp.MainActivity";
const DEFAULT_IOS_BUNDLE_ID = "com.lynx.debugrouter-DebugRouterExample";
const DEFAULT_DEVICE_TIMEOUT = 10000;
const DEFAULT_CLIENT_TIMEOUT = 10000;
const DEFAULT_IDLE_TIMEOUT = 500;
const LEGACY_PREEMPTION_TIMEOUT = 12000;
const E2E_CDP_PING_METHOD = "ConnectorRealDeviceE2E.CDP.Ping";
const E2E_CDP_NOTIFICATION_METHOD = "ConnectorRealDeviceE2E.CDP.Notification";

function parseArgs(argv) {
  const args = {
    platform: "all",
    androidSerial: "",
    iosSerial: "",
    androidClientName: null,
    iosClientName: null,
    deviceTimeout: DEFAULT_DEVICE_TIMEOUT,
    clientTimeout: DEFAULT_CLIENT_TIMEOUT,
    multiplexerDaemonIdleTimeout: DEFAULT_IDLE_TIMEOUT,
    androidActivity: DEFAULT_ANDROID_ACTIVITY,
    iosBundleId: DEFAULT_IOS_BUNDLE_ID,
    launchAndroidApp: true,
    launchIOSApp: true,
    websocket: true,
    recovery: true,
    legacyPreemption: true,
    requireMessageRoundtrip: false,
    messageMethod: "ConnectorRealDeviceE2E.Ping",
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

    if (arg === "--platform") {
      args.platform = readValue();
    } else if (arg === "--android-serial") {
      args.androidSerial = readValue();
    } else if (arg === "--ios-serial") {
      args.iosSerial = readValue();
    } else if (arg === "--android-client-name") {
      args.androidClientName = readValue();
    } else if (arg === "--ios-client-name") {
      args.iosClientName = readValue();
    } else if (arg === "--device-timeout") {
      args.deviceTimeout = Number(readValue());
    } else if (arg === "--client-timeout") {
      args.clientTimeout = Number(readValue());
    } else if (arg === "--daemon-idle-timeout") {
      args.multiplexerDaemonIdleTimeout = Number(readValue());
    } else if (arg === "--android-activity") {
      args.androidActivity = readValue();
    } else if (arg === "--ios-bundle-id") {
      args.iosBundleId = readValue();
    } else if (arg === "--message-method") {
      args.messageMethod = readValue();
    } else if (arg === "--no-launch-android") {
      args.launchAndroidApp = false;
    } else if (arg === "--no-launch-ios") {
      args.launchIOSApp = false;
    } else if (arg === "--no-websocket") {
      args.websocket = false;
    } else if (arg === "--no-recovery") {
      args.recovery = false;
    } else if (arg === "--no-legacy-preemption") {
      args.legacyPreemption = false;
    } else if (arg === "--require-message-roundtrip") {
      args.requireMessageRoundtrip = true;
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["android", "ios", "all"].includes(args.platform)) {
    throw new Error(`Unsupported --platform: ${args.platform}`);
  }
  for (const key of [
    "deviceTimeout",
    "clientTimeout",
    "multiplexerDaemonIdleTimeout",
  ]) {
    if (!Number.isFinite(args[key]) || args[key] <= 0) {
      throw new Error(`--${toKebabCase(key)} must be a positive number`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node multiplexer/real_device.js --platform all
  node multiplexer/real_device.js --platform android --android-serial <serial>
  node multiplexer/real_device.js --platform ios --ios-serial <udid>

This test requires DebugRouter test apps running on the target devices.
Android launch can be automated with adb unless --no-launch-android is set.

Options:
  --platform android|ios|all
  --android-serial <adb serial>
  --ios-serial <iOS UDID>
  --android-client-name <process name>
  --ios-client-name <app name>
  --device-timeout <ms>
  --client-timeout <ms>
  --daemon-idle-timeout <ms>
  --android-activity <package/activity>
  --ios-bundle-id <bundle id>
  --no-launch-android
  --no-launch-ios
  --no-websocket
  --no-recovery
  --no-legacy-preemption
  --require-message-roundtrip
  --message-method <method>
`);
}

function logStep(message) {
  console.log(`[multiplexer-real-device-e2e] ${message}`);
}

function createPaths(rootDir) {
  return createMultiplexerPaths({ rootDir });
}

function createContext(platform, args, option = {}) {
  const rootDir = fs.mkdtempSync(
    path.join(getIpcTestTempDir(), `debug-router-real-${platform}-`)
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
  const connectors = [];
  const sockets = [];

  return {
    rootDir,
    homeDir,
    legacyDriverDir,
    legacyOwnerPath,
    paths,
    createConnector(extra = {}) {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableWebSocket:
          extra.enableWebSocket ?? option.enableWebSocket ?? false,
        websocketOption: extra.websocketOption ??
          option.websocketOption ?? {
            port: 0,
            roomId: `real-device-${platform}`,
          },
        enableAndroid: platform === "android",
        enableIOS: platform === "ios",
        enableHarmony: false,
        enableDesktop: false,
        enableNetworkDevice: false,
        multiplexerRootDir: rootDir,
        multiplexerLegacyDriverDir: legacyDriverDir,
        multiplexerStartupTimeout: 8000,
        multiplexerRpcTimeout:
          Math.max(args.deviceTimeout, args.clientTimeout, 5000) + 5000,
        multiplexerDaemonIdleTimeout: args.multiplexerDaemonIdleTimeout,
      });
      connectors.push(connector);
      return connector;
    },
    trackSocket(socket) {
      sockets.push(socket);
      return socket;
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
        await delay(500);
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

async function runPlatformScenario(platform, args, scenarioOption = {}) {
  if (platform === "ios" && process.platform !== "darwin") {
    throw new Error("iOS real-device e2e requires macOS");
  }
  await assertPlatformDeviceOnline(platform, args);
  const androidForwardBaseline =
    platform === "android"
      ? await captureAndroidForwardBaseline(
          args.androidSerial || (await listAndroidDevices())[0]
        )
      : null;

  logStep(`checking ${platform} real-device flow`);
  const context = createContext(platform, args, {
    enableWebSocket: args.websocket,
  });

  try {
    const first = context.createConnector({ enableWebSocket: args.websocket });
    const second = context.createConnector({ enableWebSocket: args.websocket });
    const targetSerial =
      platform === "android" ? args.androidSerial : args.iosSerial;
    const clientName =
      platform === "android" ? args.androidClientName : args.iosClientName;

    const firstDevice = await connectTargetDevice(
      first,
      platform,
      targetSerial,
      args.deviceTimeout
    );
    await launchAppIfNeeded(platform, args, firstDevice);
    logStep(`${platform} connecting matching device through second connector`);
    const secondDevice = await connectTargetDevice(
      second,
      platform,
      firstDevice.serial,
      args.deviceTimeout
    );
    assert.strictEqual(secondDevice.serial, firstDevice.serial);

    await activateClientWatching(first, platform, args.clientTimeout);
    logStep(`${platform} connecting runtime client through first connector`);
    let firstClient = await connectTargetClient(
      first,
      platform,
      firstDevice.serial,
      clientName,
      args.clientTimeout,
      args
    );
    logStep(
      `${platform} connecting matching runtime client through second connector`
    );
    const secondClient = await connectMatchingClient(
      second,
      platform,
      firstDevice.serial,
      firstClient,
      args.clientTimeout,
      args
    );
    if (firstClient.clientId() !== secondClient.clientId()) {
      logStep(
        `${platform} refreshing first connector after runtime client changed`
      );
      firstClient = await connectMatchingClient(
        first,
        platform,
        firstDevice.serial,
        secondClient,
        args.clientTimeout,
        args
      );
    }
    assert.strictEqual(firstClient.clientId(), secondClient.clientId());
    assert.strictEqual(firstClient.deviceId(), firstDevice.serial);
    assert.strictEqual(secondClient.deviceId(), firstDevice.serial);
    assert.notStrictEqual(firstClient, secondClient);
    await waitFor(
      () =>
        first
          .getAllUsbClients()
          .some((client) => client.clientId() === firstClient.clientId()),
      3000,
      `${platform} first connector local client mirror`
    );
    await waitFor(
      () =>
        second
          .getAllUsbClients()
          .some((client) => client.clientId() === secondClient.clientId()),
      3000,
      `${platform} second connector local client mirror`
    );

    const daemonInfo = await waitFor(
      () => findDaemonProcess(context.paths.daemonProcessName),
      3000,
      `${platform} daemon process`
    );
    logStep(
      `${platform} daemon pid=${daemonInfo.pid} endpoint=${
        context.paths.controlEndpoint
      } device=${firstDevice.serial} client=${firstClient.clientId()}`
    );

    if (args.requireMessageRoundtrip) {
      await assertMessageRoundtrip(platform, args, firstClient, secondClient);
      if (platform === "android") {
        await assertUsbNotificationOnce(args, firstClient, secondClient);
      }
    }

    if (scenarioOption.legacyPreemption) {
      firstClient = await assertLegacyPreemption(
        context,
        first,
        platform,
        firstDevice.serial,
        clientName,
        daemonInfo.pid,
        args
      );
    } else if (args.legacyPreemption) {
      logStep(
        `${platform} skipping legacy preemption in --platform all; run --platform ${platform} to cover this platform explicitly`
      );
    }

    if (args.websocket) {
      await assertWebSocketFrontends(context, first, firstClient, platform);
    }

    if (args.recovery) {
      await assertDaemonRecovery(
        context,
        first,
        platform,
        firstDevice.serial,
        clientName,
        daemonInfo.pid,
        args
      );
    }

    const closingDaemon = await findDaemonProcess(
      context.paths.daemonProcessName
    );
    await Promise.all([first.close(), second.close()]);
    await waitFor(
      () => !closingDaemon || !processExists(closingDaemon.pid),
      5000,
      `${platform} daemon idle cleanup`
    );
  } finally {
    try {
      await context.cleanup();
    } finally {
      if (androidForwardBaseline) {
        await removeAddedAndroidForwards(androidForwardBaseline);
      }
    }
  }
}

async function assertPlatformDeviceOnline(platform, args) {
  if (platform === "android") {
    const onlineDevices = await listAndroidDevices();
    const serial = args.androidSerial;
    if (serial) {
      assert(
        onlineDevices.includes(serial),
        `Android device ${serial} is not online. adb devices: ${onlineDevices.join(
          ", "
        )}`
      );
      return;
    }
    assert(
      onlineDevices.length > 0,
      "No online Android device found. Connect a device and authorize adb first."
    );
    return;
  }

  const onlineDevices = await listIosDevices();
  const serial = args.iosSerial;
  if (serial) {
    assert(
      onlineDevices.some((device) => device.udid === serial),
      `iOS device ${serial} is not online. xcrun devices: ${onlineDevices
        .map((device) => `${device.name}(${device.udid})`)
        .join(", ")}`
    );
    return;
  }
  assert(
    onlineDevices.length > 0,
    "No online iOS device found. Connect and trust an iPhone before running this test."
  );
}

async function listAndroidDevices() {
  const output = await exec("adb devices", 10000);
  return output
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => /\tdevice$/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

async function captureAndroidForwardBaseline(serial) {
  const forwards = await listAndroidForwards(serial);
  return {
    serial,
    entries: new Set(
      forwards.map(({ local, remote }) => `${local}\u0000${remote}`)
    ),
  };
}

async function listAndroidForwards(serial) {
  const output = await execFile(
    "adb",
    ["-s", serial, "forward", "--list"],
    10000
  );
  return output
    .split(/\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && parts[0] === serial)
    .map((parts) => ({
      local: parts[1],
      remote: parts[2],
    }));
}

async function removeAddedAndroidForwards(baseline) {
  const current = await listAndroidForwards(baseline.serial);
  const added = current.filter(
    ({ local, remote }) => !baseline.entries.has(`${local}\u0000${remote}`)
  );
  for (const { local } of added) {
    await execFile(
      "adb",
      ["-s", baseline.serial, "forward", "--remove", local],
      10000
    );
  }
  if (added.length > 0) {
    logStep(
      `removed ${added.length} Android ADB forward(s) created by this run`
    );
  }
}

async function listIosDevices() {
  const output = await execRetryingTransientIOSCancel(
    "xcrun xctrace list devices",
    15000
  );
  const devices = [];
  let inOnlineDevicesSection = false;
  for (const line of output.split(/\n/)) {
    const trimmed = line.trim();
    if (trimmed === "== Devices ==") {
      inOnlineDevicesSection = true;
      continue;
    }
    if (trimmed.startsWith("== ") && trimmed !== "== Devices ==") {
      inOnlineDevicesSection = false;
      continue;
    }
    if (!inOnlineDevicesSection) {
      continue;
    }
    const match = trimmed.match(
      /^(.+?) \((\d+(?:\.\d+)*)\) \(([0-9A-Fa-f-]+)\)$/
    );
    if (match) {
      devices.push({
        name: match[1],
        osVersion: match[2],
        udid: match[3],
      });
    }
  }
  return devices;
}

async function connectTargetDevice(connector, platform, serial, timeout) {
  const devices = await connector.connectDevices(timeout, serial || null, true);
  const candidates = devices.filter((device) => {
    if (serial && device.serial !== serial) {
      return false;
    }
    return isDeviceForPlatform(device, platform);
  });

  assert(
    candidates.length > 0,
    `Expected ${platform} device${
      serial ? ` ${serial}` : ""
    }, got: ${devices
      .map((device) => `${device.serial}(${device.info.os})`)
      .join(", ")}`
  );
  return candidates[0];
}

function activateClientWatching(connector, _platform, _timeout) {
  connector.startWatchAllClients(false);
}

async function connectTargetClient(
  connector,
  platform,
  serial,
  clientName,
  timeout,
  args
) {
  let clients = [];
  const maxAttempts = platform === "ios" ? 3 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    clients = await connector.connectUsbClients(
      serial,
      timeout,
      true,
      clientName
    );
    if (clients.length > 0) {
      return clients[0];
    }
    if (attempt < maxAttempts) {
      logStep(`${platform} relaunching app after missing runtime client`);
      await launchAppIfNeeded(platform, args, { serial });
    }
  }
  assert(
    clients.length > 0,
    `Expected at least one runtime client for ${serial}${
      clientName ? ` matching ${clientName}` : ""
    }`
  );
}

async function connectMatchingClient(
  connector,
  platform,
  serial,
  targetClient,
  timeout,
  args
) {
  let clients = [];
  let matched;
  const maxAttempts = platform === "ios" ? 3 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    clients = await connector.connectUsbClients(serial, timeout, true, null);
    matched = clients.find((client) => {
      return (
        client.clientId() === targetClient.clientId() ||
        hasSameClientIdentity(client, targetClient)
      );
    });
    if (!matched) {
      matched = clients.find((client) =>
        hasSameRuntimeIdentity(client, targetClient)
      );
    }
    if (matched) {
      return matched;
    }
    if (attempt < maxAttempts) {
      logStep(`${platform} retrying matching runtime client discovery`);
      await delay(500);
    }
  }
  assert(
    matched,
    `Expected matching runtime client ${describeClient(
      targetClient
    )} for ${serial}, got: ${clients.map(describeClient).join(", ")}`
  );
}

function isDeviceForPlatform(device, platform) {
  if (platform === "android") {
    return device.info.os === "Android";
  }
  if (platform === "ios") {
    return device.info.os === "iOS";
  }
  return false;
}

function hasSameClientIdentity(candidate, target) {
  return (
    candidate.deviceId() === target.deviceId() &&
    candidate.info?.port === target.info?.port &&
    candidate.info?.query?.raw_info?.AppProcessName ===
      target.info?.query?.raw_info?.AppProcessName &&
    candidate.info?.query?.raw_info?.App === target.info?.query?.raw_info?.App
  );
}

function hasSameRuntimeIdentity(candidate, target) {
  const candidateRawInfo = candidate.info?.query?.raw_info ?? {};
  const targetRawInfo = target.info?.query?.raw_info ?? {};
  const candidateProcess = candidateRawInfo.AppProcessName;
  const targetProcess = targetRawInfo.AppProcessName;
  const candidateApp = candidateRawInfo.App;
  const targetApp = targetRawInfo.App;
  if (!candidateProcess && !candidateApp) {
    return false;
  }
  return (
    candidate.deviceId() === target.deviceId() &&
    candidateProcess === targetProcess &&
    candidateApp === targetApp
  );
}

function describeClient(client) {
  const rawInfo = client?.info?.query?.raw_info ?? {};
  return [
    `id=${client?.clientId?.()}`,
    `device=${client?.deviceId?.()}`,
    `port=${client?.info?.port}`,
    `process=${rawInfo.AppProcessName ?? ""}`,
    `app=${rawInfo.App ?? ""}`,
  ].join(" ");
}

async function launchAppIfNeeded(platform, args, device) {
  if (platform === "android" && args.launchAndroidApp) {
    const serialPrefix = device.serial
      ? `-s ${shellQuote(device.serial)} `
      : "";
    const command = `adb ${serialPrefix}shell am start -n ${shellQuote(
      args.androidActivity
    )} --es connection_type usb`;
    logStep(`launching Android test app: ${command}`);
    await exec(command, 10000);
    await delay(1000);
    return;
  }

  if (platform === "ios" && args.launchIOSApp) {
    const command = `xcrun devicectl device process launch --device ${shellQuote(
      device.serial
    )} --terminate-existing ${shellQuote(args.iosBundleId)}`;
    logStep(`launching iOS test app: ${command}`);
    await execRetryingTransientIOSCancel(command, 15000);
    await delay(2500);
  }
}

async function assertMessageRoundtrip(
  platform,
  args,
  firstClient,
  secondClient
) {
  const firstNonce = `${platform}-first-${Date.now()}`;
  const secondNonce = `${platform}-second-${Date.now()}`;
  const [firstResponse, secondResponse] = await Promise.all([
    withTimeout(
      firstClient.sendClientMessage(args.messageMethod, { nonce: firstNonce }),
      args.clientTimeout,
      `${platform} first connector message roundtrip`
    ),
    withTimeout(
      secondClient.sendClientMessage(args.messageMethod, {
        nonce: secondNonce,
      }),
      args.clientTimeout,
      `${platform} second connector message roundtrip`
    ),
  ]);
  assert.strictEqual(typeof firstResponse, "string");
  assert.strictEqual(typeof secondResponse, "string");
}

async function assertUsbNotificationOnce(args, firstClient, secondClient) {
  const marker = `android-usb-notification-${Date.now()}`;
  const firstNotifications = [];
  const secondNotifications = [];
  const firstHandler = (params) => {
    if (params?.marker === marker) {
      firstNotifications.push(params);
    }
  };
  const secondHandler = (params) => {
    if (params?.marker === marker) {
      secondNotifications.push(params);
    }
  };

  firstClient.on(E2E_CDP_NOTIFICATION_METHOD, firstHandler);
  secondClient.on(E2E_CDP_NOTIFICATION_METHOD, secondHandler);
  try {
    const response = JSON.parse(
      await withTimeout(
        firstClient.sendCustomizedMessage(
          E2E_CDP_PING_METHOD,
          { marker },
          1,
          "CDP"
        ),
        args.clientTimeout,
        "Android real USB CDP notification trigger"
      )
    );
    assert.strictEqual(response.result?.ok, true);
    await waitFor(
      () => firstNotifications.length >= 1 && secondNotifications.length >= 1,
      args.clientTimeout,
      "Android real USB notification reaches both connector mirrors"
    );
    await delay(300);
    assert.strictEqual(
      firstNotifications.length,
      1,
      "first Connector must observe the real USB notification exactly once"
    );
    assert.strictEqual(
      secondNotifications.length,
      1,
      "second Connector must observe the real USB notification exactly once"
    );
    logStep("PASS: real Android USB notification observed exactly once");
  } finally {
    firstClient.off(E2E_CDP_NOTIFICATION_METHOD, firstHandler);
    secondClient.off(E2E_CDP_NOTIFICATION_METHOD, secondHandler);
  }
}

async function assertWebSocketFrontends(
  context,
  connector,
  usbClient,
  platform
) {
  await connector.startWSServer();
  assert(connector.wssPort > 0, "websocket server should expose a port");
  const url = `ws://127.0.0.1:${connector.wssPort}/mdevices/page/android`;
  const first = await connectDriverWebSocket(url, {
    app: `${platform}-driver-a`,
  });
  const second = await connectDriverWebSocket(url, {
    app: `${platform}-driver-b`,
  });
  context.trackSocket(first.socket);
  context.trackSocket(second.socket);

  await Promise.all([
    waitFor(
      () =>
        first.messages.find(
          (message) =>
            message?.event === "ClientList" &&
            message.data?.some((client) => client.id === usbClient.clientId())
        ),
      3000,
      `${platform} first frontend client list`
    ),
    waitFor(
      () =>
        second.messages.find(
          (message) =>
            message?.event === "ClientList" &&
            message.data?.some((client) => client.id === usbClient.clientId())
        ),
      3000,
      `${platform} second frontend client list`
    ),
  ]);
}

async function assertLegacyPreemption(
  context,
  connector,
  platform,
  serial,
  clientName,
  daemonPid,
  args
) {
  logStep(`${platform} simulating legacy owner preemption`);
  const multiOpenStatuses = [];
  connector.setMultiOpenCallback({
    statusChanged(status) {
      multiOpenStatuses.push(status);
    },
  });

  await waitFor(
    () => readOwnerPid(context.legacyOwnerPath) === daemonPid,
    LEGACY_PREEMPTION_TIMEOUT,
    `${platform} daemon owns legacy owner file`
  );

  const legacyOwner = spawnLegacyOwnerProcess();
  try {
    fs.mkdirSync(context.legacyDriverDir, { recursive: true });
    fs.writeFileSync(context.legacyOwnerPath, `${legacyOwner.pid}`, "utf8");
    await waitFor(
      () => multiOpenStatuses.includes(MultiOpenStatus.unattached),
      LEGACY_PREEMPTION_TIMEOUT,
      `${platform} connector receives legacy unattached status`
    );
    await waitFor(
      () => connector.devices.size === 0 && connector.usbClients.size === 0,
      LEGACY_PREEMPTION_TIMEOUT,
      `${platform} device and runtime mirrors cleared after legacy preemption`
    );
    assert.strictEqual(readOwnerPid(context.legacyOwnerPath), legacyOwner.pid);
  } finally {
    stopLegacyOwnerProcess(legacyOwner);
  }

  connector.startWatchAllClients(false);
  await waitFor(
    () =>
      multiOpenStatuses.includes(MultiOpenStatus.attached) &&
      readOwnerPid(context.legacyOwnerPath) === daemonPid,
    // Math.max(args.deviceTimeout, 5000),
    500000,
    `${platform} daemon reacquires legacy owner`
  );
  assert.strictEqual(readOwnerPid(context.legacyOwnerPath), daemonPid);
  await launchAppIfNeeded(platform, args, { serial });

  const device = await waitFor(
    async () => {
      const devices = await connector.connectDevices(
        args.deviceTimeout,
        serial,
        true
      );
      return devices.find((candidate) => candidate.serial === serial);
    },
    Math.max(args.deviceTimeout, 5000),
    `${platform} device rediscovered after preemption`,
    250
  );
  const client = await waitFor(
    async () => {
      const clients = await connector.connectUsbClients(
        serial,
        args.clientTimeout,
        true,
        clientName
      );
      return clients[0] ?? null;
    },
    Math.max(args.clientTimeout, 5000),
    `${platform} client rediscovered after preemption`,
    250
  );
  logStep(
    `${platform} legacy preemption recovered device=${
      device.serial
    } client=${client.clientId()}`
  );
  return client;
}

function spawnLegacyOwnerProcess() {
  const child = childProcess.spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000);"],
    {
      stdio: "ignore",
    }
  );
  assert(child.pid, "legacy owner helper process should have a pid");
  return child;
}

function stopLegacyOwnerProcess(child) {
  if (!child?.pid) {
    return;
  }
  try {
    process.kill(child.pid, "SIGTERM");
  } catch (_error) {}
}

async function assertDaemonRecovery(
  context,
  connector,
  platform,
  serial,
  clientName,
  oldPid,
  args
) {
  logStep(`${platform} killing daemon pid=${oldPid} for recovery check`);
  try {
    process.kill(oldPid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  await waitFor(
    () => !processExists(oldPid),
    3000,
    `${platform} old daemon process exit`
  );
  await delay(args.multiplexerDaemonIdleTimeout + 300);

  const [device] = await connector.connectDevices(
    args.deviceTimeout,
    serial,
    true
  );
  assert(device, `${platform} device should be rediscovered after recovery`);
  const [client] = await connector.connectUsbClients(
    serial,
    args.clientTimeout,
    true,
    clientName
  );
  assert(client, `${platform} client should be rediscovered after recovery`);

  const newInfo = await waitFor(
    async () => {
      const info = await findDaemonProcess(context.paths.daemonProcessName);
      return info && info.pid !== oldPid ? info : null;
    },
    5000,
    `${platform} replacement daemon lock owner`
  );
  assert.notStrictEqual(newInfo.pid, oldPid);
  logStep(`${platform} recovered daemon pid=${newInfo.pid}`);
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
              debugRouterVersion: "real-device-e2e",
              deviceModel: "Driver",
              osVersion: process.platform,
              sdkVersion: "real-device-e2e",
            },
            type: "Driver",
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
    3000,
    `${info.app} room joined`
  );
  return { socket, messages };
}

function exec(command, timeout) {
  return new Promise((resolve, reject) => {
    const child = childProcess.exec(
      command,
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      }
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout:${timeout} exec:${command}`));
    }, timeout);
    child.on("exit", () => clearTimeout(timer));
  });
}

function execFile(command, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile(
      command,
      args,
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      }
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(`timeout:${timeout} execFile:${command} ${args.join(" ")}`)
      );
    }, timeout);
    child.on("exit", () => clearTimeout(timer));
  });
}

async function execRetryingTransientIOSCancel(command, timeout) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await exec(command, timeout);
    } catch (error) {
      lastError = error;
      if (!isTransientIOSCancelError(error) || attempt === 3) {
        throw error;
      }
      await delay(500 * attempt);
    }
  }
  throw lastError;
}

function isTransientIOSCancelError(error) {
  const message = error?.message ?? String(error);
  return (
    message.includes("Network.NWError") ||
    message.includes("Operation canceled")
  );
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
      }
    );
  });
}

function readOwnerPid(filePath) {
  try {
    return Number(fs.readFileSync(filePath, "utf8").trim());
  } catch (_error) {
    return undefined;
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

async function waitFor(predicate, timeout, label, interval = 100) {
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

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

async function stopInterferingMultiplexerDaemons() {
  const targets = await listInterferingMultiplexerDaemons();
  if (targets.length === 0) {
    return;
  }

  logStep(
    `stopping ${targets.length} existing multiplexer daemon(s) before real-device e2e`
  );
  for (const target of targets) {
    try {
      process.kill(target.pid, "SIGTERM");
    } catch (_error) {}
  }

  await waitFor(
    async () => {
      const alive = targets.filter((target) => processExists(target.pid));
      return alive.length === 0;
    },
    2000,
    "existing multiplexer daemon graceful stop"
  ).catch(() => {});

  const stillAlive = targets.filter((target) => processExists(target.pid));
  for (const target of stillAlive) {
    try {
      process.kill(target.pid, "SIGKILL");
    } catch (_error) {}
  }

  if (stillAlive.length > 0) {
    await delay(500);
  }
}

function listInterferingMultiplexerDaemons() {
  if (process.platform === "win32") {
    return Promise.resolve([]);
  }

  return new Promise((resolve) => {
    childProcess.execFile("ps", ["-Ao", "pid=,command="], (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }

      const targets = stdout
        .split(/\n/)
        .map((line) => {
          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          if (!match) {
            return null;
          }
          return {
            pid: Number(match[1]),
            command: match[2],
          };
        })
        .filter(Boolean)
        .filter((entry) => {
          if (entry.pid === process.pid) {
            return false;
          }
          return entry.command.includes(MULTIPLEXER_DAEMON_PROCESS_NAME_SUFFIX);
        });
      resolve(targets);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await stopInterferingMultiplexerDaemons();
  const platforms =
    args.platform === "all" ? ["android", "ios"] : [args.platform];
  for (const [index, platform] of platforms.entries()) {
    await runPlatformScenario(platform, args, {
      legacyPreemption:
        args.legacyPreemption && (args.platform !== "all" || index === 0),
    });
  }
  logStep("TEST SUCCESS");
}

main().catch((error) => {
  console.error("[multiplexer-real-device-e2e] TEST FAILED");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
