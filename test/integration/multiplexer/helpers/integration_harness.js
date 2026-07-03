// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { WebSocket } = require(require.resolve("ws", {
  paths: [path.join(__dirname, "../../../../debug_router_connector")],
}));

require("../../../unit/multiplexer/register_ts");

const {
  DebugRouterConnector,
} = require("../../../../debug_router_connector/src/connector/DebugRouterConnector");
const {
  MultiplexerDaemonClient,
} = require("../../../../debug_router_connector/src/multiplexer/client/MultiplexerDaemonClient");
const {
  MultiplexerDaemonManager,
} = require("../../../../debug_router_connector/src/multiplexer/client/MultiplexerDaemonManager");
const {
  MultiplexerDiscovery,
} = require("../../../../debug_router_connector/src/multiplexer/client/MultiplexerDiscovery");
const {
  MULTIPLEXER_CONTROL_PATH,
  MULTIPLEXER_HEALTH_PATH,
} = require("../../../../debug_router_connector/src/multiplexer/protocol/discovery");
const {
  createMultiplexerPaths,
} = require("../../../../debug_router_connector/src/multiplexer/utils/paths");

const fakeDaemonEntry = path.join(
  __dirname,
  "../fixtures/fake_daemon_entry.js",
);

const DEFAULT_STATE = {
  devices: [
    {
      serial: "device-1",
      os: "Android",
      title: "Pixel 8",
      ports: [9001, 9002],
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
      port: 9101,
    },
  ],
};
const WINDOWS_TIMEOUT_MULTIPLIER = 4;

function createIntegrationContext(name, option = {}) {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `debug-router-${name}-`),
  );
  const homeDir = path.join(rootDir, "home");
  const legacyDriverDir = path.join(homeDir, ".DebugRouterConnector");
  const legacyOwnerPath = path.join(legacyDriverDir, "LatestDriverProcess");
  const originalEnv = captureEnv(["HOME", "USERPROFILE"]);
  fs.mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  const paths = createMultiplexerPaths({ rootDir });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  writeFakeState(paths, option.state ?? DEFAULT_STATE);

  const discovery = new MultiplexerDiscovery({
    discoveryPath: paths.discoveryPath,
    staleTimeout: option.staleTimeout ?? 1000,
    localProtocolVersion: option.localProtocolVersion,
  });

  const manager = createManager({
    paths,
    discovery,
    startupTimeout: option.startupTimeout ?? 3000,
    staleTimeout: option.staleTimeout ?? 1000,
    readyPollInterval: option.readyPollInterval ?? 25,
    heartbeatInterval: option.heartbeatInterval ?? 50,
    replacementTimeout: option.replacementTimeout ?? 100,
    localProtocolVersion: option.localProtocolVersion,
    minSupportedProtocolVersion: option.minSupportedProtocolVersion,
    daemonVersion: option.daemonVersion,
    capabilities: option.capabilities,
    legacyDriverDir,
    multiplexerDaemonIdleTimeout: option.multiplexerDaemonIdleTimeout,
    enableWebSocket: option.enableWebSocket,
    websocketOption: option.websocketOption,
  });

  const clients = [];
  const connectors = [];
  const sockets = [];

  return {
    rootDir,
    homeDir,
    legacyDriverDir,
    legacyOwnerPath,
    paths,
    discovery,
    manager,
    fakeDaemonEntry,
    createManager(extra = {}) {
      const extraDiscovery =
        extra.discovery ??
        new MultiplexerDiscovery({
          discoveryPath: paths.discoveryPath,
          staleTimeout: extra.staleTimeout ?? option.staleTimeout ?? 1000,
          localProtocolVersion:
            extra.localProtocolVersion ?? option.localProtocolVersion,
        });
      return createManager({
        paths,
        discovery: extraDiscovery,
        startupTimeout: extra.startupTimeout ?? option.startupTimeout ?? 3000,
        staleTimeout: extra.staleTimeout ?? option.staleTimeout ?? 1000,
        readyPollInterval:
          extra.readyPollInterval ?? option.readyPollInterval ?? 25,
        heartbeatInterval:
          extra.heartbeatInterval ?? option.heartbeatInterval ?? 50,
        replacementTimeout:
          extra.replacementTimeout ?? option.replacementTimeout ?? 100,
        localProtocolVersion:
          extra.localProtocolVersion ?? option.localProtocolVersion,
        minSupportedProtocolVersion:
          extra.minSupportedProtocolVersion ??
          option.minSupportedProtocolVersion,
        daemonVersion: extra.daemonVersion ?? option.daemonVersion,
        capabilities: extra.capabilities ?? option.capabilities,
        legacyDriverDir: extra.legacyDriverDir ?? legacyDriverDir,
        multiplexerDaemonIdleTimeout:
          extra.multiplexerDaemonIdleTimeout ??
          option.multiplexerDaemonIdleTimeout,
        enableWebSocket: extra.enableWebSocket ?? option.enableWebSocket,
        websocketOption: extra.websocketOption ?? option.websocketOption,
      });
    },
    createClient(extra = {}) {
      const client = new MultiplexerDaemonClient({
        daemonManager: extra.manager ?? manager,
        controlPath: extra.controlPath ?? MULTIPLEXER_CONTROL_PATH,
        rpcTimeout: extra.rpcTimeout ?? 1000,
        protocolVersion:
          extra.protocolVersion ??
          extra.manager?.localProtocolVersion ??
          manager.localProtocolVersion,
        clientVersion: extra.clientVersion,
        capabilities: extra.capabilities,
      });
      clients.push(client);
      return client;
    },
    createConnector(extra = {}) {
      const connector = new DebugRouterConnector({
        manualConnect: true,
        enableAndroid: false,
        enableIOS: false,
        enableHarmony: false,
        enableDesktop: false,
        enableNetworkDevice: false,
        enableWebSocket: extra.enableWebSocket ?? option.enableWebSocket,
        websocketOption: extra.websocketOption ?? option.websocketOption,
        multiplexerRootDir: rootDir,
        multiplexerLegacyDriverDir: legacyDriverDir,
        multiplexerDaemonEntry: fakeDaemonEntry,
        multiplexerStartupTimeout:
          extra.startupTimeout ?? option.startupTimeout ?? 3000,
        multiplexerStaleTimeout:
          extra.staleTimeout ?? option.staleTimeout ?? 1000,
        multiplexerRpcTimeout: extra.rpcTimeout ?? 1000,
        multiplexerDaemonIdleTimeout:
          extra.multiplexerDaemonIdleTimeout ??
          option.multiplexerDaemonIdleTimeout,
        reportService: null,
      });
      connectors.push(connector);
      return connector;
    },
    writeState(state) {
      writeFakeState(paths, state);
    },
    appendCommand(command) {
      appendCommand(paths, command);
    },
    readLog() {
      return readJsonLines(getLogPath(paths));
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
        for (const client of clients.splice(0)) {
          await client.close().catch(() => {});
        }
        await stopDiscoveredDaemon(paths.discoveryPath);
        fs.rmSync(rootDir, { recursive: true, force: true });
      } finally {
        restoreEnv(originalEnv);
      }
    },
  };
}

function createManager(option) {
  return new MultiplexerDaemonManager({
    discovery: option.discovery,
    spawnLockPath: option.paths.spawnLockPath,
    daemonLockPath: option.paths.daemonLockPath,
    daemonEntry: fakeDaemonEntry,
    startupTimeout: option.startupTimeout,
    staleTimeout: option.staleTimeout,
    readyPollInterval: option.readyPollInterval,
    heartbeatInterval: option.heartbeatInterval,
    replacementTimeout: option.replacementTimeout,
    localProtocolVersion: option.localProtocolVersion,
    minSupportedProtocolVersion: option.minSupportedProtocolVersion,
    daemonVersion: option.daemonVersion,
    capabilities: option.capabilities,
    legacyDriverDir: option.legacyDriverDir,
    controlPort: 0,
    multiplexerDaemonIdleTimeout: option.multiplexerDaemonIdleTimeout,
    enableWebSocket: option.enableWebSocket,
    websocketOption: option.websocketOption,
  });
}

function writeFakeState(paths, state) {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(paths.dataDir, "fake_physical_state.json"),
    JSON.stringify(state, null, 2),
  );
}

function appendCommand(paths, command) {
  fs.appendFileSync(
    path.join(paths.dataDir, "fake_physical_commands.jsonl"),
    `${JSON.stringify(command)}\n`,
  );
}

function getLogPath(paths) {
  return path.join(paths.dataDir, "fake_daemon_log.jsonl");
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

async function stopDiscoveredDaemon(discoveryPath) {
  const info = readJsonFile(discoveryPath, null);
  if (info?.pid) {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch (_error) {}
    await waitFor(() => !processExists(info.pid), 1000).catch(async () => {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch (_error) {}
      await waitFor(() => !processExists(info.pid), 1000).catch(() => {});
    });
    if (!processExists(info.pid)) {
      fs.rmSync(discoveryPath, { force: true });
      fs.rmSync(path.join(path.dirname(discoveryPath), "daemon.lock"), {
        recursive: true,
        force: true,
      });
    }
  }
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
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

async function waitFor(predicate, timeout = 2000, interval = 20) {
  const startedAt = Date.now();
  const effectiveTimeout = platformTimeout(timeout);
  let lastError;
  while (Date.now() - startedAt <= effectiveTimeout) {
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
  throw new Error(`Timed out after ${effectiveTimeout}ms waiting for condition`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: MULTIPLEXER_HEALTH_PATH,
        timeout: 1000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            body: JSON.parse(body),
          });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("health request timed out"));
    });
    request.on("error", reject);
  });
}

function collectConnectorEvents(connector, event) {
  const payloads = [];
  connector.on(event, (payload) => payloads.push(payload));
  return payloads;
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

function createCustomizedResponseEnvelope(clientId, cdpId, marker) {
  return JSON.stringify({
    event: "Customized",
    data: {
      type: "CDP",
      data: {
        client_id: clientId,
        session_id: 1,
        message: JSON.stringify({
          id: cdpId,
          result: {
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
    cdp:
      typeof payload === "string"
        ? JSON.parse(payload)
        : JSON.parse(JSON.stringify(payload)),
  };
}

function waitForSocketMessage(socket, predicate, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const effectiveTimeout = platformTimeout(timeout);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, effectiveTimeout);
    const onMessage = (data) => {
      const text = data.toString();
      let value;
      try {
        value = JSON.parse(text);
      } catch (_error) {
        value = text;
      }
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

function platformTimeout(timeout) {
  return process.platform === "win32"
    ? timeout * WINDOWS_TIMEOUT_MULTIPLIER
    : timeout;
}

function captureEnv(keys) {
  const snapshot = {};
  for (const key of keys) {
    snapshot[key] = {
      hadValue: Object.prototype.hasOwnProperty.call(process.env, key),
      value: process.env[key],
    };
  }
  return snapshot;
}

function restoreEnv(snapshot) {
  for (const [key, entry] of Object.entries(snapshot)) {
    if (entry.hadValue) {
      process.env[key] = entry.value;
    } else {
      delete process.env[key];
    }
  }
}

async function connectDriverWebSocket(url, option = {}) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on("message", (data) => {
    const text = data.toString();
    try {
      messages.push(JSON.parse(text));
    } catch (_error) {
      messages.push(text);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const initialize = await waitFor(
    () => messages.find((value) => value?.event === "Initialize"),
    1500,
  );
  const id = initialize.data;
  socket.send(
    JSON.stringify({
      event: "Register",
      data: {
        id,
        type: "Driver",
        info: {
          app: option.app ?? `driver-${id}`,
          debugRouterVersion: "test",
          deviceModel: "browser",
          osVersion: "test",
          sdkVersion: "test",
        },
      },
    }),
  );
  await waitFor(
    () => messages.find((value) => value?.event === "RoomJoined"),
    1500,
  );
  socket.send(JSON.stringify({ event: "ListClients" }));
  await waitFor(
    () => messages.find((value) => value?.event === "ClientList"),
    1500,
  );
  return { socket, id, messages };
}

function assertSamePid(infos) {
  assert(infos.length > 0);
  const pid = infos[0].pid;
  for (const info of infos) {
    assert.strictEqual(info.pid, pid);
  }
  return pid;
}

module.exports = {
  DEFAULT_STATE,
  assertSamePid,
  collectConnectorEvents,
  connectDriverWebSocket,
  createCustomizedEnvelope,
  createCustomizedResponseEnvelope,
  createIntegrationContext,
  delay,
  getHealth,
  parseCustomizedEnvelope,
  platformTimeout,
  processExists,
  readJsonFile,
  waitFor,
  waitForSocketMessage,
};
