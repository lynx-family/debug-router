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
const DEFAULT_DURATION_MS = 300000;
const DEFAULT_CONNECTORS = 5;
const DEFAULT_FRONTENDS = 5;
const DEFAULT_CONCURRENCY = 20;
const DEFAULT_MESSAGE_COUNT = 1000;
const DEFAULT_ROUNDS = 5;
const DEFAULT_DEVICE_TIMEOUT = 10000;
const DEFAULT_CLIENT_TIMEOUT = 10000;
const DEFAULT_IDLE_TIMEOUT = 10000;
const DEFAULT_MESSAGE_METHOD = "ConnectorRealDeviceE2E.Ping";
const DEFAULT_CDP_MESSAGE_METHOD = "ConnectorRealDeviceE2E.CDP.Ping";
const DEFAULT_WEBSOCKET_MESSAGE_TYPE = "App";
const DEFAULT_RECOVERY_PROBE_MESSAGES = 20;
const LEGACY_PREEMPTION_TIMEOUT = 12000;
const FAILURE_CATEGORIES = [
  "empty_devices",
  "empty_clients",
  "client_list_missing",
  "send_timeout",
  "socket_timeout",
  "connector_closed",
  "daemon_exited",
  "daemon_recovery_failed",
  "marker_mismatch",
  "cdp_id_mismatch",
  "legacy_preemption_failed",
  "cleanup_leftover_daemon",
  "unknown_exception",
];

class StressError extends Error {
  constructor(category, message) {
    super(message);
    this.category = category;
  }
}

function parseArgs(argv) {
  const args = {
    platform: "all",
    transport: "usb",
    androidSerial: "",
    iosSerial: "",
    androidClientName: null,
    iosClientName: null,
    durationMs: DEFAULT_DURATION_MS,
    connectors: DEFAULT_CONNECTORS,
    frontends: DEFAULT_FRONTENDS,
    concurrency: DEFAULT_CONCURRENCY,
    messageCount: DEFAULT_MESSAGE_COUNT,
    rounds: DEFAULT_ROUNDS,
    deviceTimeout: DEFAULT_DEVICE_TIMEOUT,
    clientTimeout: DEFAULT_CLIENT_TIMEOUT,
    multiplexerDaemonIdleTimeout: DEFAULT_IDLE_TIMEOUT,
    messageMethod: DEFAULT_MESSAGE_METHOD,
    websocketMessageType: DEFAULT_WEBSOCKET_MESSAGE_TYPE,
    androidActivity: DEFAULT_ANDROID_ACTIVITY,
    iosBundleId: DEFAULT_IOS_BUNDLE_ID,
    launchAndroidApp: true,
    launchIOSApp: true,
    websocket: true,
    recovery: false,
    churn: true,
    legacyPreemption: false,
    report: "",
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
    } else if (arg === "--transport") {
      args.transport = readValue();
    } else if (arg === "--android-serial") {
      args.androidSerial = readValue();
    } else if (arg === "--ios-serial") {
      args.iosSerial = readValue();
    } else if (arg === "--android-client-name") {
      args.androidClientName = readValue();
    } else if (arg === "--ios-client-name") {
      args.iosClientName = readValue();
    } else if (arg === "--duration-ms") {
      args.durationMs = Number(readValue());
    } else if (arg === "--connectors") {
      args.connectors = Number(readValue());
    } else if (arg === "--frontends") {
      args.frontends = Number(readValue());
    } else if (arg === "--concurrency") {
      args.concurrency = Number(readValue());
    } else if (arg === "--message-count") {
      args.messageCount = Number(readValue());
    } else if (arg === "--rounds") {
      args.rounds = Number(readValue());
    } else if (arg === "--device-timeout") {
      args.deviceTimeout = Number(readValue());
    } else if (arg === "--client-timeout") {
      args.clientTimeout = Number(readValue());
    } else if (arg === "--daemon-idle-timeout") {
      args.multiplexerDaemonIdleTimeout = Number(readValue());
    } else if (arg === "--message-method") {
      args.messageMethod = readValue();
    } else if (arg === "--websocket-message-type") {
      args.websocketMessageType = readValue();
    } else if (arg === "--android-activity") {
      args.androidActivity = readValue();
    } else if (arg === "--ios-bundle-id") {
      args.iosBundleId = readValue();
    } else if (arg === "--no-launch-android") {
      args.launchAndroidApp = false;
    } else if (arg === "--no-launch-ios") {
      args.launchIOSApp = false;
    } else if (arg === "--no-websocket") {
      args.websocket = false;
    } else if (arg === "--recovery") {
      args.recovery = true;
    } else if (arg === "--no-recovery") {
      args.recovery = false;
    } else if (arg === "--no-churn") {
      args.churn = false;
    } else if (arg === "--legacy-preemption") {
      args.legacyPreemption = true;
    } else if (arg === "--no-legacy-preemption") {
      args.legacyPreemption = false;
    } else if (arg === "--report") {
      args.report = readValue();
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
  if (!["usb", "wifi"].includes(args.transport)) {
    throw new Error(`Unsupported --transport: ${args.transport}`);
  }
  if (args.transport === "wifi" && args.platform !== "android") {
    throw new Error("--transport wifi currently requires --platform android");
  }
  if (args.transport === "wifi" && !args.websocket) {
    throw new Error("--transport wifi requires WebSocket to be enabled");
  }
  for (const key of [
    "durationMs",
    "connectors",
    "frontends",
    "concurrency",
    "messageCount",
    "rounds",
    "deviceTimeout",
    "clientTimeout",
    "multiplexerDaemonIdleTimeout",
  ]) {
    if (!Number.isFinite(args[key]) || args[key] <= 0) {
      throw new Error(`--${toKebabCase(key)} must be a positive number`);
    }
  }
  if (args.connectors < 1) {
    throw new Error("--connectors must be >= 1");
  }
  if (args.websocket && args.frontends < 1) {
    throw new Error("--frontends must be >= 1 when WebSocket is enabled");
  }
  if (!["App", "CDP"].includes(args.websocketMessageType)) {
    throw new Error("--websocket-message-type must be App or CDP");
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node multiplexer/real_device_stress.js --platform android --transport usb
  node multiplexer/real_device_stress.js --platform android --transport wifi
  node multiplexer/real_device_stress.js --platform ios
  node multiplexer/real_device_stress.js --platform all

This stress test requires DebugRouter test apps running on real devices.
It intentionally uses @lynx-js/debug-router-connector package entry.

Options:
  --platform android|ios|all
  --transport usb|wifi              default usb; wifi currently supports Android
  --android-serial <adb serial>
  --ios-serial <iOS UDID>
  --android-client-name <process name>
  --ios-client-name <app name>
  --duration-ms <ms>                 default ${DEFAULT_DURATION_MS}
  --connectors <n>                   default ${DEFAULT_CONNECTORS}
  --frontends <n>                    default ${DEFAULT_FRONTENDS}
  --concurrency <n>                  default ${DEFAULT_CONCURRENCY}
  --message-count <n>                default ${DEFAULT_MESSAGE_COUNT}
  --rounds <n>                       default ${DEFAULT_ROUNDS}
  --device-timeout <ms>              default ${DEFAULT_DEVICE_TIMEOUT}
  --client-timeout <ms>              default ${DEFAULT_CLIENT_TIMEOUT}
  --daemon-idle-timeout <ms>         default ${DEFAULT_IDLE_TIMEOUT}
  --message-method <method>          default ${DEFAULT_MESSAGE_METHOD}
  --websocket-message-type App|CDP    default ${DEFAULT_WEBSOCKET_MESSAGE_TYPE}
  --android-activity <package/activity>
  --ios-bundle-id <bundle id>
  --no-launch-android
  --no-launch-ios
  --no-websocket
  --recovery                         Enable daemon kill/restart probe (default: off)
  --no-recovery
  --no-churn
  --legacy-preemption                Enable legacy owner preemption probe (default: off)
  --no-legacy-preemption
  --report <path>
`);
}

function createReport(platform, args) {
  const failures = {};
  for (const category of FAILURE_CATEGORIES) {
    failures[category] = 0;
  }
  return {
    platform,
    transport: args.transport,
    startedAt: new Date().toISOString(),
    durationTargetMs: args.durationMs,
    durationMs: 0,
    connectors: args.connectors,
    frontends: args.websocket ? args.frontends : 0,
    concurrency: args.concurrency,
    messageCount: args.messageCount,
    rounds: args.rounds,
    websocketMessageType: args.websocketMessageType,
    success: 0,
    messagePaths: {
      connector: { success: 0, failures: 0 },
      websocket: { success: 0, failures: 0 },
    },
    churn: {
      connectorReplacements: 0,
      frontendReplacements: 0,
    },
    failures,
    failureSamples: [],
    latencySamples: [],
    latencyMs: {
      avg: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    },
    daemon: {
      initialPid: null,
      finalPid: null,
      pidChanges: 0,
      recoveryCount: 0,
      leftoverPids: [],
    },
    roundSummaries: [],
  };
}

async function runPlatformStressScenario(platform, args) {
  const report = createReport(platform, args);
  const startedAt = Date.now();
  let context;
  let state;
  let androidForwardBaseline = null;
  let selectedAndroidSerial = args.androidSerial;

  try {
    await stopInterferingMultiplexerDaemons();
    await assertPlatformDeviceOnline(platform, args);
    if (platform === "android") {
      selectedAndroidSerial ||= (await listAndroidDevices())[0];
    }
    if (platform === "android" && args.transport === "usb") {
      androidForwardBaseline = await captureAndroidForwardBaseline(
        selectedAndroidSerial
      );
    }

    logStep(platform, "creating isolated multiplexer stress context");
    context = createContext(platform, args, {
      enableWebSocket: args.websocket,
    });
    state = createScenarioState(platform, args);
    if (platform === "android") {
      state.serial = selectedAndroidSerial;
    }

    const primary = context.createConnector({
      enableWebSocket: args.websocket,
    });
    state.connectors.push({
      id: "primary",
      connector: primary,
      closed: false,
      primary: true,
    });

    if (args.transport === "wifi") {
      await primary.startWSServer();
      state.websocketUrl = getWebSocketUrl(primary);
      state.mobileWebSocketUrl = getMobileWebSocketUrl(primary);
      await createAdditionalConnectors(context, state, args);
      await prepareAdditionalConnectors(state, args);
      await createFrontends(context, state, args.frontends, platform);
      await launchAndroidWiFiApp(
        state.serial,
        args,
        state.mobileWebSocketUrl,
        primary.roomId
      );
      state.targetClient = await waitForWiFiRuntime(
        primary,
        args.clientTimeout,
        "warmup real WiFi runtime"
      );
    } else {
      const firstDevice = await connectTargetDevice(
        primary,
        platform,
        state.serial,
        args.deviceTimeout
      );
      state.serial = firstDevice.serial;
      await launchAppIfNeeded(platform, args, firstDevice);
      await createAdditionalConnectors(context, state, args);
      await activateClientWatching(primary, platform, args.clientTimeout);
      state.targetClient = await connectTargetClient(
        primary,
        platform,
        state.serial,
        state.clientName,
        args.clientTimeout,
        args
      );

      if (args.websocket) {
        await primary.startWSServer();
        state.websocketUrl = getWebSocketUrl(primary);
      }

      await prepareAdditionalConnectors(state, args);
      if (args.websocket) {
        await createFrontends(context, state, args.frontends, platform);
      }
    }
    await refreshAndAssertState(context, state, args, report, "warmup");

    const daemonInfo = await waitFor(
      () => findDaemonProcess(context.paths.daemonProcessName),
      5000,
      `${platform} daemon process`
    );
    report.daemon.initialPid = daemonInfo.pid;
    report.daemon.finalPid = daemonInfo.pid;
    state.lastDaemonPid = daemonInfo.pid;
    logStep(
      platform,
      `stress warmup ready transport=${args.transport} daemon=${
        daemonInfo.pid
      } device=${state.serial} client=${state.targetClient.clientId()}`
    );

    await runStressRounds(context, state, args, report);

    if (args.recovery) {
      await runRecoveryProbe(context, state, args, report);
    }
    if (args.legacyPreemption) {
      await runLegacyPreemptionProbe(context, state, args, report);
    }

    await refreshAndAssertState(context, state, args, report, "final");
  } catch (error) {
    recordFailure(report, classifyError(error), error);
  } finally {
    try {
      if (args.transport === "wifi" && state?.serial && args.launchAndroidApp) {
        await forceStopAndroidApp(
          state.serial,
          args.androidActivity
        ).catch(() => {});
      }
      await cleanupContext(context, state, args, report);
    } finally {
      if (androidForwardBaseline) {
        await removeAddedAndroidForwards(androidForwardBaseline);
      }
    }
    finalizeReport(report, startedAt);
    printReport(report);
  }

  return report;
}

function createScenarioState(platform, args) {
  return {
    platform,
    serial: platform === "android" ? args.androidSerial : args.iosSerial,
    clientName:
      platform === "android" ? args.androidClientName : args.iosClientName,
    targetClient: null,
    connectors: [],
    frontends: [],
    websocketUrl: "",
    mobileWebSocketUrl: "",
    lastDaemonPid: null,
  };
}

function createContext(platform, args, option = {}) {
  const rootDir = fs.mkdtempSync(
    path.join(getIpcTestTempDir(), `debug-router-real-stress-${platform}-`)
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
            roomId: `real-device-stress-${platform}`,
          },
        enableAndroid: args.transport === "usb" && platform === "android",
        enableIOS: args.transport === "usb" && platform === "ios",
        enableHarmony: false,
        enableDesktop: false,
        enableNetworkDevice: false,
        multiplexerRootDir: rootDir,
        multiplexerLegacyDriverDir: legacyDriverDir,
        multiplexerStartupTimeout: 10000,
        multiplexerRpcTimeout:
          Math.max(args.deviceTimeout, args.clientTimeout, 5000) + 10000,
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
      if (hadOriginalHome) {
        process.env.HOME = originalHome;
      } else {
        delete process.env.HOME;
      }
    },
  };
}

function getIpcTestTempDir() {
  return process.platform === "win32" ? os.tmpdir() : "/tmp";
}

function createPaths(rootDir) {
  return createMultiplexerPaths({ rootDir });
}

async function createAdditionalConnectors(context, state, args) {
  for (let index = 1; index < args.connectors; index++) {
    const connector = context.createConnector({
      enableWebSocket: args.websocket,
    });
    state.connectors.push({
      id: `connector-${index}`,
      connector,
      closed: false,
      primary: false,
    });
    if (args.transport === "wifi") {
      await connector.startWSServer();
      continue;
    }
    const device = await connectTargetDevice(
      connector,
      state.platform,
      state.serial,
      args.deviceTimeout
    );
    state.serial = device.serial;
  }
}

async function prepareAdditionalConnectors(state, args) {
  for (const entry of activeConnectors(state).filter(
    (entry) => !entry.primary
  )) {
    await prepareConnector(entry.connector, state, args);
  }
}

async function createFrontends(context, state, count, platform) {
  for (let index = 0; index < count; index++) {
    const frontend = await connectDriverWebSocket(state.websocketUrl, {
      app: `${platform}-stress-driver-${index}`,
    });
    context.trackSocket(frontend.socket);
    state.frontends.push({
      id: `frontend-${index}`,
      closed: false,
      ...frontend,
    });
  }
}

async function prepareConnector(connector, state, args) {
  if (args.transport === "wifi") {
    await connector.startWSServer();
    if (!state.targetClient) {
      return null;
    }
    return waitForWiFiRuntime(
      connector,
      args.clientTimeout,
      `matching WiFi runtime ${state.targetClient.clientId()}`,
      state.targetClient.clientId()
    );
  }

  const device = await connectTargetDevice(
    connector,
    state.platform,
    state.serial,
    args.deviceTimeout
  );
  state.serial = device.serial;
  const matched = state.targetClient
    ? await connectMatchingClient(
        connector,
        state.platform,
        state.serial,
        state.targetClient,
        args.clientTimeout,
        args
      )
    : await connectTargetClient(
        connector,
        state.platform,
        state.serial,
        state.clientName,
        args.clientTimeout,
        args
      );
  state.targetClient = matched;
  return matched;
}

async function refreshAndAssertState(context, state, args, report, label) {
  for (const entry of activeConnectors(state)) {
    const matched = await prepareConnector(entry.connector, state, args);
    if (args.transport === "wifi") {
      if (!matched) {
        throw new StressError(
          "empty_clients",
          `${label}: connector ${entry.id} missing WiFi runtime`
        );
      }
      continue;
    }
    if (!entry.connector.devices.has(state.serial)) {
      throw new StressError(
        "empty_devices",
        `${label}: connector ${entry.id} missing device ${state.serial}`
      );
    }
    if (!entry.connector.usbClients.has(state.targetClient.clientId())) {
      throw new StressError(
        "empty_clients",
        `${label}: connector ${
          entry.id
        } missing client ${state.targetClient.clientId()}`
      );
    }
  }

  if (args.websocket) {
    await assertFrontendClientLists(state, args, label);
  }

  const daemon = await findDaemonProcess(context.paths.daemonProcessName);
  if (!daemon?.pid || !processExists(daemon.pid)) {
    throw new StressError("daemon_exited", `${label}: daemon is not alive`);
  }
  if (state.lastDaemonPid && daemon.pid !== state.lastDaemonPid) {
    report.daemon.pidChanges++;
    recordFailure(
      report,
      "daemon_exited",
      new Error(
        `${label}: daemon pid changed unexpectedly ${state.lastDaemonPid} -> ${daemon.pid}`
      )
    );
  }
  state.lastDaemonPid = daemon.pid;
  report.daemon.finalPid = daemon.pid;
}

async function runStressRounds(context, state, args, report) {
  const deadline = Date.now() + args.durationMs;
  const perRound = Math.max(1, Math.ceil(args.messageCount / args.rounds));
  let scheduled = 0;

  for (let round = 0; round < args.rounds; round++) {
    if (scheduled >= args.messageCount || Date.now() >= deadline) {
      break;
    }

    const roundStart = Date.now();
    const count = Math.min(perRound, args.messageCount - scheduled);
    const tasks = createMessageTasks(state, args, round, scheduled, count);
    logStep(
      state.platform,
      `round ${round + 1}/${args.rounds}: ${
        tasks.length
      } messages concurrency=${args.concurrency}`
    );

    await runWithConcurrency(tasks, args.concurrency, async (task) => {
      await runMessageTask(task, args, report);
    });
    scheduled += tasks.length;

    if (args.churn && round < args.rounds - 1) {
      await churnConnectorsAndFrontends(context, state, args, round, report);
    }
    await refreshAndAssertState(
      context,
      state,
      args,
      report,
      `round-${round + 1}`
    );

    report.roundSummaries.push({
      round: round + 1,
      messages: tasks.length,
      durationMs: Date.now() - roundStart,
      success: report.success,
      failures: totalFailures(report),
      daemonPid: state.lastDaemonPid,
    });
  }
}

function createMessageTasks(state, args, round, offset, count) {
  const tasks = [];
  const connectors = activeConnectors(state);
  const frontends = activeFrontends(state);
  const useWebSocket = args.websocket && frontends.length > 0;
  const clientId = state.targetClient.clientId();

  for (let index = 0; index < count; index++) {
    const absoluteIndex = offset + index;
    if (!useWebSocket || index % 2 === 0) {
      const connectorEntry = connectors[absoluteIndex % connectors.length];
      tasks.push({
        path: "connector",
        marker: `${state.platform}-${args.transport}-round-${
          round + 1
        }-connector-${connectorEntry.id}-message-${absoluteIndex}`,
        connectorEntry,
        clientId,
      });
    } else {
      const frontendEntry = frontends[absoluteIndex % frontends.length];
      tasks.push({
        path: "websocket",
        marker: `${state.platform}-${args.transport}-round-${round + 1}-ws-${
          frontendEntry.id
        }-message-${absoluteIndex}`,
        frontendEntry,
        clientId,
        cdpId: 1000 + absoluteIndex,
      });
    }
  }
  return tasks;
}

async function runMessageTask(task, args, report) {
  const startedAt = Date.now();
  try {
    if (task.path === "connector") {
      await sendConnectorMessage(task, args);
    } else {
      await sendWebSocketMessage(task, args);
    }
    report.messagePaths[task.path].success++;
    recordSuccess(report, Date.now() - startedAt);
  } catch (error) {
    report.messagePaths[task.path].failures++;
    recordFailure(report, classifyError(error), error);
  }
}

async function sendConnectorMessage(task, args) {
  if (task.connectorEntry.closed) {
    throw new StressError(
      "connector_closed",
      `${task.connectorEntry.id} is closed`
    );
  }
  const client =
    args.transport === "wifi"
      ? task.connectorEntry.connector
          .getAllWebsocketAppClients()
          .find((candidate) => candidate.clientId() === task.clientId)
      : task.connectorEntry.connector.usbClients.get(task.clientId);
  if (!client) {
    throw new StressError(
      "empty_clients",
      `${task.connectorEntry.id} missing client ${task.clientId}`
    );
  }
  const response =
    args.transport === "wifi"
      ? await withTimeout(
          client.sendCustomizedMessage(
            stressMessageMethod(args),
            { marker: task.marker },
            args.websocketMessageType === "CDP" ? 1 : -1,
            args.websocketMessageType
          ),
          args.clientTimeout,
          `WiFi connector message ${task.marker}`
        )
      : await withTimeout(
          client.sendClientMessage(args.messageMethod, {
            marker: task.marker,
          }),
          args.clientTimeout,
          `connector message ${task.marker}`
        );
  if (!containsMarker(response, task.marker)) {
    throw new StressError(
      "marker_mismatch",
      `connector response missing marker ${task.marker}: ${stringifyForLog(
        response
      )}`
    );
  }
}

async function sendWebSocketMessage(task, args) {
  if (task.frontendEntry.closed) {
    throw new StressError(
      "connector_closed",
      `${task.frontendEntry.id} socket is closed`
    );
  }
  const wait = waitForSocketMessage(
    task.frontendEntry.socket,
    (value) => {
      if (value?.event !== "Customized") {
        return false;
      }
      const parsed = parseCustomizedEnvelope(JSON.stringify(value));
      return containsMarker(parsed.cdp, task.marker);
    },
    args.clientTimeout,
    `websocket ${args.websocketMessageType} message ${task.marker}`
  );
  task.frontendEntry.socket.send(
    createCustomizedEnvelope(
      task.clientId,
      task.cdpId,
      stressMessageMethod(args),
      task.marker,
      args.websocketMessageType
    )
  );
  const message = await wait;
  const parsed = parseCustomizedEnvelope(message.text);
  if (parsed.cdp.id !== task.cdpId) {
    throw new StressError(
      "cdp_id_mismatch",
      `expected cdp id ${task.cdpId}, got ${parsed.cdp.id}`
    );
  }
  if (!containsMarker(parsed.cdp, task.marker)) {
    throw new StressError(
      "marker_mismatch",
      `websocket response missing marker ${task.marker}`
    );
  }
}

async function churnConnectorsAndFrontends(
  context,
  state,
  args,
  round,
  report
) {
  const connectorCandidate = activeConnectors(state).find(
    (entry) => !entry.primary
  );
  if (connectorCandidate) {
    connectorCandidate.closed = true;
    await connectorCandidate.connector.close().catch((error) => {
      recordFailure(report, classifyError(error), error);
    });
    const replacement = context.createConnector({
      enableWebSocket: args.websocket,
    });
    const replacementEntry = {
      id: `${connectorCandidate.id}-r${round + 1}`,
      connector: replacement,
      closed: false,
      primary: false,
    };
    await prepareConnector(replacement, state, args);
    state.connectors.push(replacementEntry);
    report.churn.connectorReplacements++;
  }

  if (args.websocket) {
    const frontendCandidate = activeFrontends(state)[0];
    if (frontendCandidate) {
      frontendCandidate.closed = true;
      frontendCandidate.socket.close();
      const replacement = await connectDriverWebSocket(state.websocketUrl, {
        app: `${state.platform}-stress-driver-r${round + 1}`,
      });
      context.trackSocket(replacement.socket);
      state.frontends.push({
        id: `${frontendCandidate.id}-r${round + 1}`,
        closed: false,
        ...replacement,
      });
      report.churn.frontendReplacements++;
    }
  }
}

async function runRecoveryProbe(context, state, args, report) {
  const oldPid = state.lastDaemonPid;
  if (!oldPid) {
    recordFailure(
      report,
      "daemon_recovery_failed",
      new Error("missing daemon pid before recovery")
    );
    return;
  }

  logStep(state.platform, `killing daemon pid=${oldPid} for recovery probe`);
  try {
    process.kill(oldPid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  await waitFor(
    () => !processExists(oldPid),
    5000,
    `${state.platform} old daemon process exit`
  );

  const primary = activeConnectors(state).find((entry) => entry.primary);
  if (!primary) {
    throw new StressError(
      "daemon_recovery_failed",
      "primary connector missing"
    );
  }
  if (args.transport === "wifi") {
    await retryTransientDaemonReconnect(
      () => primary.connector.startWSServer(),
      `${state.platform} recovery startWSServer`
    );
    state.websocketUrl = getWebSocketUrl(primary.connector);
    state.mobileWebSocketUrl = getMobileWebSocketUrl(primary.connector);
    await launchAndroidWiFiApp(
      state.serial,
      args,
      state.mobileWebSocketUrl,
      primary.connector.roomId
    );
    state.targetClient = await waitForWiFiRuntime(
      primary.connector,
      args.clientTimeout,
      "recovery real WiFi runtime"
    );
  } else {
    await retryTransientDaemonReconnect(
      () =>
        primary.connector.connectDevices(
          args.deviceTimeout,
          state.serial,
          true
        ),
      `${state.platform} recovery connectDevices`
    );
    state.targetClient = await retryTransientDaemonReconnect(
      () =>
        connectTargetClient(
          primary.connector,
          state.platform,
          state.serial,
          state.clientName,
          args.clientTimeout,
          args
        ),
      `${state.platform} recovery connectTargetClient`
    );
  }
  if (args.websocket) {
    await primary.connector.startWSServer();
    state.websocketUrl = getWebSocketUrl(primary.connector);
    for (const frontend of activeFrontends(state)) {
      frontend.closed = true;
      frontend.socket.close();
    }
    state.frontends = [];
    await createFrontends(context, state, args.frontends, state.platform);
  }

  const newInfo = await waitFor(
    async () => {
      const info = await findDaemonProcess(context.paths.daemonProcessName);
      return info?.pid && info.pid !== oldPid && processExists(info.pid)
        ? info
        : null;
    },
    10000,
    `${state.platform} replacement daemon process`
  );
  report.daemon.recoveryCount++;
  state.lastDaemonPid = newInfo.pid;
  report.daemon.finalPid = newInfo.pid;
  await refreshAndAssertState(context, state, args, report, "recovery");

  const probeCount = Math.min(
    DEFAULT_RECOVERY_PROBE_MESSAGES,
    args.messageCount
  );
  const tasks = createMessageTasks(state, args, 999, 0, probeCount);
  await runWithConcurrency(
    tasks,
    Math.min(args.concurrency, probeCount),
    (task) => runMessageTask(task, args, report)
  );
}

async function runLegacyPreemptionProbe(context, state, args, report) {
  const primary = activeConnectors(state).find((entry) => entry.primary);
  if (!primary) {
    return;
  }
  const daemonPid = state.lastDaemonPid;
  if (!daemonPid) {
    recordFailure(
      report,
      "legacy_preemption_failed",
      new Error("missing daemon pid before legacy preemption")
    );
    return;
  }

  try {
    logStep(state.platform, "simulating legacy owner preemption");
    const statuses = [];
    primary.connector.setMultiOpenCallback({
      statusChanged(status) {
        statuses.push(status);
      },
    });

    await waitFor(
      () => readOwnerPid(context.legacyOwnerPath) === daemonPid,
      LEGACY_PREEMPTION_TIMEOUT,
      `${state.platform} daemon owns legacy owner file`
    );

    const legacyOwner = spawnLegacyOwnerProcess();
    try {
      fs.mkdirSync(context.legacyDriverDir, { recursive: true });
      fs.writeFileSync(context.legacyOwnerPath, `${legacyOwner.pid}`, "utf8");
      await waitFor(
        () => statuses.includes(MultiOpenStatus.unattached),
        LEGACY_PREEMPTION_TIMEOUT,
        `${state.platform} connector receives legacy unattached status`
      );
      await waitFor(
        () => {
          if (args.transport === "wifi") {
            return primary.connector.getAllWebsocketAppClients().length === 0;
          }
          return (
            primary.connector.devices.size === 0 &&
            primary.connector.usbClients.size === 0
          );
        },
        LEGACY_PREEMPTION_TIMEOUT,
        `${state.platform} device and runtime mirrors cleared after legacy preemption`
      );
    } finally {
      stopLegacyOwnerProcess(legacyOwner);
    }

    primary.connector.startWatchAllClients(false);
    await waitFor(
      () =>
        statuses.includes(MultiOpenStatus.attached) &&
        readOwnerPid(context.legacyOwnerPath) === daemonPid,
      Math.max(args.deviceTimeout, 5000),
      `${state.platform} daemon reacquires legacy owner`
    );
    if (args.transport === "wifi") {
      await primary.connector.startWSServer();
      state.websocketUrl = getWebSocketUrl(primary.connector);
      state.mobileWebSocketUrl = getMobileWebSocketUrl(primary.connector);
      await launchAndroidWiFiApp(
        state.serial,
        args,
        state.mobileWebSocketUrl,
        primary.connector.roomId
      );
      state.targetClient = await waitForWiFiRuntime(
        primary.connector,
        args.clientTimeout,
        "legacy recovery real WiFi runtime"
      );
    } else {
      await launchAppIfNeeded(state.platform, args, {
        serial: state.serial,
      });
    }
    await refreshAndAssertState(context, state, args, report, "legacy");
  } catch (error) {
    recordFailure(report, "legacy_preemption_failed", error);
  }
}

async function cleanupContext(context, state, args, report) {
  if (!context) {
    return;
  }
  const observedPids = new Set();
  if (state?.lastDaemonPid) {
    observedPids.add(state.lastDaemonPid);
  }
  try {
    await context.cleanup();
    const daemonAfterClose = await findDaemonProcess(
      context.paths.daemonProcessName
    );
    if (daemonAfterClose?.pid) {
      observedPids.add(daemonAfterClose.pid);
    }

    let cleanupError = null;
    if (observedPids.size > 0 || daemonAfterClose?.pid) {
      await waitFor(
        async () => {
          const daemon = await findDaemonProcess(
            context.paths.daemonProcessName
          );
          if (daemon?.pid) {
            observedPids.add(daemon.pid);
          }
          return Array.from(observedPids).every((pid) => !processExists(pid));
        },
        args.multiplexerDaemonIdleTimeout + 5000,
        "daemon idle cleanup",
        250
      ).catch((error) => {
        cleanupError = error;
      });
    }

    const daemon = await findDaemonProcess(context.paths.daemonProcessName);
    if (daemon?.pid) {
      observedPids.add(daemon.pid);
      await stopDaemonProcesses(context.paths.daemonProcessName);
    }
    for (const pid of observedPids) {
      if (processExists(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (_error) {}
      }
    }

    const leftoverPids = Array.from(observedPids).filter((pid) =>
      processExists(pid)
    );
    if (leftoverPids.length > 0) {
      for (const pid of leftoverPids) {
        report.daemon.leftoverPids.push(pid);
      }
      recordFailure(
        report,
        "cleanup_leftover_daemon",
        cleanupError ??
          new Error(`leftover daemon pid=${leftoverPids.join(",")}`)
      );
    }
  } finally {
    fs.rmSync(context.rootDir, { recursive: true, force: true });
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
    if (onlineDevices.length === 0) {
      throw new StressError(
        "empty_devices",
        "No online Android device found. Connect a device and authorize adb first."
      );
    }
    return;
  }

  if (process.platform !== "darwin") {
    throw new StressError("empty_devices", "iOS stress test requires macOS");
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
  if (onlineDevices.length === 0) {
    throw new StressError(
      "empty_devices",
      "No online iOS device found. Connect and trust an iPhone before running this test."
    );
  }
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
      "android",
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

  if (candidates.length === 0) {
    throw new StressError(
      "empty_devices",
      `Expected ${platform} device${
        serial ? ` ${serial}` : ""
      }, got: ${devices
        .map((device) => `${device.serial}(${device.info.os})`)
        .join(", ")}`
    );
  }
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
      logStep(platform, "relaunching app after missing runtime client");
      await launchAppIfNeeded(platform, args, { serial });
    }
  }
  throw new StressError(
    "empty_clients",
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
      logStep(platform, "retrying matching runtime client discovery");
      await delay(500);
    }
  }
  throw new StressError(
    "empty_clients",
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
    const packageName = getAndroidPackageName(args.androidActivity);
    if (packageName) {
      await exec(
        `adb ${serialPrefix}shell am force-stop ${shellQuote(packageName)}`,
        10000
      );
      await delay(500);
    }
    const command = `adb ${serialPrefix}shell am start -n ${shellQuote(
      args.androidActivity
    )} --es connection_type usb`;
    logStep(platform, `launching Android test app: ${command}`);
    await exec(command, 10000);
    await delay(1000);
    return;
  }

  if (platform === "ios" && args.launchIOSApp) {
    const command = `xcrun devicectl device process launch --device ${shellQuote(
      device.serial
    )} --terminate-existing ${shellQuote(args.iosBundleId)}`;
    logStep(platform, `launching iOS test app: ${command}`);
    await execRetryingTransientIOSCancel(command, 15000);
    await delay(2500);
  }
}

async function launchAndroidWiFiApp(serial, args, websocketUrl, roomId) {
  if (!args.launchAndroidApp) {
    return;
  }
  const packageName = getAndroidPackageName(args.androidActivity);
  const schema =
    `lynx://remote_debug_lynx/enable?url=${encodeURIComponent(websocketUrl)}` +
    `&room=${encodeURIComponent(roomId ?? "")}`;
  await execFile(
    "adb",
    ["-s", serial, "shell", "am", "force-stop", packageName],
    10000
  );
  const output = await execFile(
    "adb",
    [
      "-s",
      serial,
      "shell",
      "am",
      "start",
      "-n",
      args.androidActivity,
      "--es",
      "connection_type",
      "websocket",
      "--es",
      "websocket_schema",
      schema,
    ],
    15000
  );
  if (output.includes("Error:")) {
    throw new StressError(
      "empty_clients",
      `Failed to launch Android WiFi app: ${output}`
    );
  }
  logStep("android", `launched Android WiFi runtime at ${websocketUrl}`);
}

function forceStopAndroidApp(serial, activity) {
  return execFile(
    "adb",
    [
      "-s",
      serial,
      "shell",
      "am",
      "force-stop",
      getAndroidPackageName(activity),
    ],
    10000
  );
}

async function waitForWiFiRuntime(connector, timeout, label, expectedClientId) {
  return waitFor(
    () =>
      connector.getAllWebsocketAppClients().find((client) => {
        if (expectedClientId !== undefined) {
          return client.clientId() === expectedClientId;
        }
        return client.type() === "runtime" && client.info?.network === "WiFi";
      }),
    timeout,
    label
  ).catch((error) => {
    throw new StressError("empty_clients", error.message);
  });
}

async function assertFrontendClientLists(state, args, label) {
  const clientId = state.targetClient.clientId();
  await waitFor(
    () =>
      activeFrontends(state).every((frontend) =>
        latestClientIds(frontend).includes(clientId)
      ),
    Math.max(args.clientTimeout, 5000),
    `${label}: frontends latest ClientList to include ${clientId}`
  ).catch((error) => {
    throw new StressError("client_list_missing", error.message);
  });
}

function latestClientIds(frontend) {
  const clientLists = frontend.messages.filter(
    (message) => message?.event === "ClientList"
  );
  if (clientLists.length === 0) {
    return [];
  }
  return clientLists[clientLists.length - 1].data
    .map((client) => client.id)
    .sort((first, second) => first - second);
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
              debugRouterVersion: "real-device-stress",
              deviceModel: "Driver",
              osVersion: process.platform,
              sdkVersion: "real-device-stress",
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

function createCustomizedEnvelope(
  clientId,
  cdpId,
  method,
  marker,
  type = DEFAULT_WEBSOCKET_MESSAGE_TYPE
) {
  const message = {
    id: cdpId,
    method,
    params: {
      marker,
    },
  };
  return JSON.stringify({
    event: "Customized",
    data: {
      type,
      data: {
        client_id: clientId,
        session_id: 1,
        message: type === "CDP" ? JSON.stringify(message) : message,
      },
      sender: 0,
    },
  });
}

function parseCustomizedEnvelope(message) {
  const envelope = typeof message === "string" ? JSON.parse(message) : message;
  const payload = envelope.data?.data?.message;
  return {
    envelope,
    cdp: typeof payload === "string" ? JSON.parse(payload) : payload,
  };
}

function waitForSocketMessage(
  socket,
  predicate,
  timeout,
  label = "WebSocket message"
) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new StressError("socket_timeout", `Timed out waiting for ${label}`)
      );
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
      reject(
        new StressError(
          "connector_closed",
          "WebSocket closed while waiting for message"
        )
      );
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

function getWebSocketUrl(connector) {
  if (!connector.wssPort) {
    throw new StressError(
      "client_list_missing",
      "WebSocket server has no port"
    );
  }
  return `ws://127.0.0.1:${connector.wssPort}/mdevices/page/android`;
}

function getMobileWebSocketUrl(connector) {
  if (!connector.wss?.wssPath) {
    throw new StressError(
      "client_list_missing",
      "WebSocket server has no phone-reachable path"
    );
  }
  const url = new URL(connector.wss.wssPath);
  if (!net.isIP(url.hostname) || isLoopbackOrLinkLocal(url.hostname)) {
    throw new StressError(
      "empty_clients",
      `Expected a LAN IP reachable by the phone, got ${url.hostname}`
    );
  }
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

function stressMessageMethod(args) {
  if (
    args.websocketMessageType === "CDP" &&
    args.messageMethod === DEFAULT_MESSAGE_METHOD
  ) {
    return DEFAULT_CDP_MESSAGE_METHOD;
  }
  return args.messageMethod;
}

function activeConnectors(state) {
  return state.connectors.filter((entry) => !entry.closed);
}

function activeFrontends(state) {
  return state.frontends.filter((entry) => !entry.closed);
}

function recordSuccess(report, latencyMs) {
  report.success++;
  report.latencySamples.push(latencyMs);
}

function recordFailure(report, category, error) {
  const normalized = FAILURE_CATEGORIES.includes(category)
    ? category
    : "unknown_exception";
  report.failures[normalized]++;
  if (report.failureSamples.length < 20) {
    report.failureSamples.push({
      category: normalized,
      message: error?.message ?? String(error),
    });
  }
}

function classifyError(error) {
  if (error?.category) {
    return error.category;
  }
  const message = error?.message ?? String(error);
  if (/Timeout after|timeout/i.test(message)) {
    return "send_timeout";
  }
  if (/No online|Expected .* device|missing device/i.test(message)) {
    return "empty_devices";
  }
  if (/runtime client|missing client|empty_clients/i.test(message)) {
    return "empty_clients";
  }
  if (/ClientList|room joined|WebSocket server/i.test(message)) {
    return "client_list_missing";
  }
  if (/closed|socket/i.test(message)) {
    return "connector_closed";
  }
  return "unknown_exception";
}

function finalizeReport(report, startedAt) {
  report.durationMs = Date.now() - startedAt;
  report.finishedAt = new Date().toISOString();
  report.latencyMs = summarizeLatency(report.latencySamples);
  delete report.latencySamples;
}

function summarizeLatency(samples) {
  if (samples.length === 0) {
    return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...samples].sort((first, second) => first - second);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    avg: Math.round((sum / sorted.length) * 100) / 100,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sorted, ratio) {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * ratio) - 1
  );
  return sorted[index];
}

function totalFailures(report) {
  return Object.values(report.failures).reduce(
    (total, value) => total + value,
    0
  );
}

function printReport(report) {
  const failures = totalFailures(report);
  logStep(
    report.platform,
    `summary transport=${report.transport} success=${report.success} failures=${failures} avg=${report.latencyMs.avg}ms p95=${report.latencyMs.p95}ms p99=${report.latencyMs.p99}ms daemonPidChanges=${report.daemon.pidChanges}`
  );
  const nonZeroFailures = Object.entries(report.failures).filter(
    ([_category, count]) => count > 0
  );
  if (nonZeroFailures.length > 0) {
    console.error(
      `[multiplexer-real-device-stress:${report.platform}] failures`
    );
    for (const [category, count] of nonZeroFailures) {
      console.error(`  ${category}: ${count}`);
    }
  }
}

function writeReports(reportPath, reports) {
  if (!reportPath) {
    return;
  }
  const outputPath = path.resolve(process.cwd(), reportPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      reports.length === 1 ? reports[0] : { platforms: reports },
      null,
      2
    )
  );
}

function containsMarker(value, marker) {
  if (typeof value === "string") {
    if (value.includes(marker)) {
      return true;
    }
    const parsed = parseJson(value);
    return parsed ? containsMarker(parsed, marker) : false;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsMarker(item, marker));
  }
  return Object.values(value).some((item) => containsMarker(item, marker));
}

function stringifyForLog(value) {
  if (typeof value === "string") {
    return value.slice(0, 500);
  }
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch (_error) {
    return String(value).slice(0, 500);
  }
}

async function runWithConcurrency(items, concurrency, task) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        await task(item);
      }
    }
  );
  await Promise.all(workers);
}

function spawnLegacyOwnerProcess() {
  const child = childProcess.spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000);"],
    {
      stdio: "ignore",
      windowsHide: true,
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
      reject(
        new StressError("send_timeout", `Timeout after ${timeout}ms: ${label}`)
      );
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

async function retryTransientDaemonReconnect(operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientDaemonReconnectError(error) || attempt === 3) {
        throw error;
      }
      await delay(500 * attempt);
    }
  }
  throw lastError ?? new Error(`${label} failed`);
}

function isTransientDaemonReconnectError(error) {
  const message = error?.message ?? String(error);
  return (
    message.includes("Multiplexer control socket closed") ||
    message.includes("closed before open") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET")
  );
}

function getAndroidPackageName(activity) {
  const [packageName] = String(activity).split("/");
  return packageName || "";
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function logStep(platform, message) {
  console.log(`[multiplexer-real-device-stress:${platform}] ${message}`);
}

async function stopInterferingMultiplexerDaemons() {
  const targets = await listInterferingMultiplexerDaemons();
  if (targets.length === 0) {
    return;
  }

  console.log(
    `[multiplexer-real-device-stress] stopping ${targets.length} existing multiplexer daemon(s)`
  );
  for (const target of targets) {
    try {
      process.kill(target.pid, "SIGTERM");
    } catch (_error) {}
  }

  await waitFor(
    () => targets.every((target) => !processExists(target.pid)),
    2000,
    "existing multiplexer daemon graceful stop"
  ).catch(() => {});

  for (const target of targets.filter((entry) => processExists(entry.pid))) {
    try {
      process.kill(target.pid, "SIGKILL");
    } catch (_error) {}
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
  const platforms =
    args.platform === "all" ? ["android", "ios"] : [args.platform];
  const reports = [];

  for (const platform of platforms) {
    reports.push(await runPlatformStressScenario(platform, args));
  }

  writeReports(args.report, reports);
  const failures = reports.reduce(
    (total, report) => total + totalFailures(report),
    0
  );
  if (failures > 0) {
    console.error(
      `[multiplexer-real-device-stress] TEST FAILED with ${failures} failure(s)`
    );
    process.exitCode = 1;
    return;
  }
  console.log("[multiplexer-real-device-stress] TEST SUCCESS");
}

main().catch((error) => {
  console.error("[multiplexer-real-device-stress] TEST FAILED");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
