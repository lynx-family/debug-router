// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

require("../../../unit/multiplexer/register_ts");

const {
  parseEntryOption,
} = require("../../../../debug_router_connector/src/multiplexer/daemon/entry");
const {
  MultiplexerDaemon,
} = require("../../../../debug_router_connector/src/multiplexer/daemon/MultiplexerDaemon");
const {
  MultiplexerHost,
} = require("../../../../debug_router_connector/src/multiplexer/daemon/MultiplexerHost");

const STATE_FILE_NAME = "fake_physical_state.json";
const COMMAND_FILE_NAME = "fake_physical_commands.jsonl";
const LOG_FILE_NAME = "fake_daemon_log.jsonl";

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createDevice(snapshot, connector) {
  const state = {
    startWatchCalls: 0,
    stopWatchCalls: 0,
    disconnectCalls: 0,
  };
  return {
    info: {
      os: snapshot.os ?? "Android",
      title: snapshot.title ?? snapshot.serial,
      serial: snapshot.serial,
    },
    ports: snapshot.ports ?? [],
    state,
    get serial() {
      return this.info.serial;
    },
    getHost() {
      return snapshot.host;
    },
    startWatchClient() {
      state.startWatchCalls++;
      connector.record("device-start-watch", {
        serial: snapshot.serial,
        calls: state.startWatchCalls,
      });
    },
    async stopWatchClient() {
      state.stopWatchCalls++;
      connector.record("device-stop-watch", {
        serial: snapshot.serial,
        calls: state.stopWatchCalls,
      });
    },
    disConnect() {
      state.disconnectCalls++;
      connector.record("device-disconnect", {
        serial: snapshot.serial,
        calls: state.disconnectCalls,
      });
    },
  };
}

function createClient(snapshot, connector) {
  const id = snapshot.id;
  const deviceId = snapshot.deviceId ?? snapshot.query?.device_id ?? "device-1";
  const query = {
    app: snapshot.app ?? snapshot.query?.app ?? `app-${id}`,
    os: snapshot.os ?? snapshot.query?.os ?? "Android",
    device: snapshot.device ?? snapshot.query?.device ?? "Pixel",
    device_model:
      snapshot.deviceModel ?? snapshot.query?.device_model ?? "Pixel",
    device_id: deviceId,
    sdk_version: snapshot.sdkVersion ?? snapshot.query?.sdk_version ?? "1.0.0",
    raw_info:
      snapshot.rawInfo ??
      snapshot.query?.raw_info ?? {
        AppProcessName: snapshot.processName ?? `com.demo.${id}`,
        App: snapshot.appName ?? `Demo ${id}`,
      },
  };

  return {
    info: {
      id,
      port: snapshot.port ?? 9000 + id,
      query,
    },
    clientId() {
      return this.info.id;
    },
    deviceId() {
      return this.info.query.device_id;
    },
    sendMessage(message) {
      connector.record("client-send-message", {
        id,
        message,
      });
      connector.respondToRuntimeMessage(id, message);
    },
    async sendRawMessage(message) {
      connector.record("client-send-raw-message", {
        id,
        message,
      });
      return {
        event: "Customized",
        data: {
          type: "CDP",
          data: {
            client_id: id,
            session_id: message.data?.data?.session_id ?? -1,
            message: JSON.stringify({
              id: message.data?.data?.message?.id,
              result: {
                clientId: id,
                method: message.data?.data?.message?.method,
                params: message.data?.data?.message?.params,
              },
            }),
          },
          sender: 0,
        },
      };
    },
    close() {
      connector.record("client-close", { id });
    },
  };
}

class FakePhysicalConnector {
  constructor(option = {}) {
    this.events = new EventEmitter();
    this.devices = new Map();
    this.usbClients = new Map();
    this.nextClientId = 1000;
    this.closed = false;
    this.dataDir = path.dirname(option.discoveryPathForFake);
    this.statePath = path.join(this.dataDir, STATE_FILE_NAME);
    this.commandPath = path.join(this.dataDir, COMMAND_FILE_NAME);
    this.logPath = path.join(this.dataDir, LOG_FILE_NAME);
    this.commandOffset = 0;
    this.state = readJsonFile(this.statePath, {});

    for (const device of this.state.devices ?? []) {
      this.addDevice(device, false);
    }
    for (const client of this.state.clients ?? []) {
      this.addClient(client, false);
    }

    this.record("fake-physical-created", {
      pid: process.pid,
      devices: this.devices.size,
      clients: this.usbClients.size,
    });
    this.commandTimer = setInterval(() => this.consumeCommands(), 20);
  }

  on(event, callback) {
    this.events.on(event, callback);
  }

  off(event, callback) {
    this.events.off(event, callback);
  }

  emit(event, payload) {
    this.events.emit(event, payload);
  }

  record(event, data = {}) {
    appendJsonLine(this.logPath, {
      event,
      pid: process.pid,
      at: Date.now(),
      ...data,
    });
  }

  createClientId() {
    return ++this.nextClientId;
  }

  async connectDevices(_timeout = -1, serial = null, isAutoListenClients = true) {
    this.record("connect-devices", { serial, isAutoListenClients });
    return this.getDevices(-1, serial);
  }

  getDevices(_timeout = -1, serial = null) {
    const devices = Array.from(this.devices.values());
    if (serial === null || serial === undefined) {
      return Promise.resolve(devices);
    }
    return Promise.resolve(devices.filter((device) => device.serial === serial));
  }

  startWatchClient(device) {
    device.startWatchClient();
  }

  startWatchAllClients(force = true) {
    this.record("start-watch-all-clients", { force });
    for (const device of this.devices.values()) {
      device.startWatchClient();
    }
  }

  disableAllClients() {
    this.record("disable-all-clients");
  }

  async connectUsbClients(deviceId, timeout = -1, waitTimeout = true, clientName = null) {
    this.record("connect-usb-clients", {
      deviceId,
      timeout,
      waitTimeout,
      clientName,
    });
    return this.getDeviceUsbClients(deviceId, timeout, clientName);
  }

  getDeviceUsbClients(_deviceId, _timeout = -1, clientName = null) {
    const clients = Array.from(this.usbClients.values()).filter(
      (client) => client.deviceId() === _deviceId,
    );
    if (clientName === null || clientName === undefined) {
      return Promise.resolve(clients);
    }
    return Promise.resolve(
      clients.filter((client) => {
        const query = client.info.query;
        return (
          query.raw_info?.AppProcessName === clientName ||
          query.raw_info?.App === clientName
        );
      }),
    );
  }

  waitDeviceUsbClients(deviceId, timeout = -1) {
    return this.getDeviceUsbClients(deviceId, timeout, null);
  }

  getAllUsbClients() {
    return Array.from(this.usbClients.values());
  }

  sendMessage(clientId, message) {
    const client = this.usbClients.get(clientId);
    if (client) {
      client.sendMessage(message);
    }
  }

  sendRawMessage(clientId, message) {
    const client = this.usbClients.get(clientId);
    if (!client) {
      return Promise.reject(new Error(`client not found:${clientId}`));
    }
    return client.sendRawMessage(message);
  }

  closeClient(clientId) {
    this.usbClients.get(clientId)?.close();
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.commandTimer);
    this.record("fake-physical-closed");
  }

  addDevice(snapshot, shouldEmit = true) {
    if (!snapshot?.serial || this.devices.has(snapshot.serial)) {
      return;
    }
    const device = createDevice(snapshot, this);
    this.devices.set(device.serial, device);
    this.record("device-added", { serial: device.serial });
    if (shouldEmit) {
      this.emit("device-connected", device);
    }
  }

  removeDevice(serial) {
    const device = this.devices.get(serial);
    if (!device) {
      return;
    }
    this.devices.delete(serial);
    this.record("device-removed", { serial });
    this.emit("device-disconnected", device);
  }

  addClient(snapshot, shouldEmit = true) {
    if (!Number.isInteger(snapshot?.id) || this.usbClients.has(snapshot.id)) {
      return;
    }
    const client = createClient(snapshot, this);
    this.usbClients.set(client.clientId(), client);
    this.record("client-added", { id: client.clientId() });
    if (shouldEmit) {
      this.emit("client-connected", client);
    }
  }

  removeClient(id) {
    const client = this.usbClients.get(id);
    if (!client) {
      return;
    }
    this.usbClients.delete(id);
    this.record("client-removed", { id });
    this.emit("client-disconnected", id);
  }

  emitUsbMessage(id, message) {
    this.record("emit-usb-message", { id, message });
    this.emit("usb-client-message", { id, message });
  }

  respondToRuntimeMessage(clientId, message) {
    if (this.state.suppressResponses) {
      return;
    }
    const response = this.createRuntimeResponse(clientId, message);
    if (!response) {
      return;
    }
    const delay = this.state.responseDelayMs ?? 0;
    setTimeout(() => {
      this.emitUsbMessage(clientId, response);
    }, delay);
  }

  createRuntimeResponse(clientId, message) {
    const data = cloneJson(message);
    const customized = data?.event === "Customized" ? data.data?.data : null;
    if (!customized) {
      return null;
    }

    const payload = customized.message;
    const inner =
      typeof payload === "string" ? readJsonValue(payload) : cloneJson(payload);
    if (!inner || inner.id === undefined || inner.id === null) {
      return null;
    }

    const responseInner = {
      id: inner.id,
      result: {
        clientId,
        method: inner.method,
        params: inner.params,
      },
    };
    customized.message =
      typeof payload === "string" ? JSON.stringify(responseInner) : responseInner;
    return JSON.stringify(data);
  }

  consumeCommands() {
    let content;
    try {
      content = fs.readFileSync(this.commandPath, "utf8");
    } catch (_error) {
      return;
    }
    if (content.length <= this.commandOffset) {
      return;
    }
    const chunk = content.slice(this.commandOffset);
    this.commandOffset = content.length;
    for (const line of chunk.split(/\n/)) {
      if (!line.trim()) {
        continue;
      }
      const command = readJsonValue(line);
      if (!command) {
        continue;
      }
      this.handleCommand(command);
    }
  }

  handleCommand(command) {
    this.record("command", command);
    switch (command.type) {
      case "add-device":
        this.addDevice(command.device, true);
        break;
      case "remove-device":
        this.removeDevice(command.serial);
        break;
      case "add-client":
        this.addClient(command.client, true);
        break;
      case "remove-client":
        this.removeClient(command.id);
        break;
      case "emit-usb-message":
        this.emitUsbMessage(command.id, command.message);
        break;
      case "throw-uncaught-error":
        throw new Error(command.message ?? "fake daemon uncaught error");
      default:
        this.record("unknown-command", command);
    }
  }
}

function readJsonValue(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

async function main() {
  const entryOption = parseEntryOption(process.argv.slice(2));
  const dataDir = path.dirname(entryOption.discoveryPath);
  const logPath = path.join(dataDir, LOG_FILE_NAME);

  appendJsonLine(logPath, {
    event: "daemon-entry-start",
    pid: process.pid,
    at: Date.now(),
  });

  const host = new MultiplexerHost({
    controlPort: entryOption.controlPort,
    protocolVersion: entryOption.protocolVersion,
    minSupportedProtocolVersion: entryOption.minSupportedProtocolVersion,
    daemonVersion: entryOption.daemonVersion,
    capabilities: entryOption.capabilities,
    multiplexerDaemonIdleTimeout: entryOption.multiplexerDaemonIdleTimeout,
    enableWebSocket: entryOption.enableWebSocket,
    websocketOption: entryOption.websocketOption,
    PhysicalConnectorCtor: FakePhysicalConnector,
    discoveryPathForFake: entryOption.discoveryPath,
  });

  const daemon = new MultiplexerDaemon({
    discoveryPath: entryOption.discoveryPath,
    daemonLockPath: entryOption.daemonLockPath,
    protocolVersion: entryOption.protocolVersion,
    minSupportedProtocolVersion: entryOption.minSupportedProtocolVersion,
    daemonVersion: entryOption.daemonVersion,
    capabilities: entryOption.capabilities,
    heartbeatInterval: entryOption.heartbeatInterval,
    hostOption:
      entryOption.multiplexerDaemonIdleTimeout === undefined
        ? undefined
        : {
            multiplexerDaemonIdleTimeout:
              entryOption.multiplexerDaemonIdleTimeout,
          },
    host,
    onIdleTimeout(stopError) {
      if (stopError) {
        appendJsonLine(logPath, {
          event: "daemon-idle-cleanup-error",
          pid: process.pid,
          at: Date.now(),
          message: stopError?.message,
        });
      }
      process.exit(stopError ? 1 : 0);
    },
  });

  let cleaning = false;
  const cleanup = async (exitCode) => {
    if (cleaning) {
      return;
    }
    cleaning = true;
    try {
      await daemon.stop();
    } catch (error) {
      appendJsonLine(logPath, {
        event: "daemon-cleanup-error",
        pid: process.pid,
        at: Date.now(),
        message: error?.message,
      });
      if (exitCode === 0) {
        process.exitCode = 1;
      }
    }
  };
  const cleanupAndExit = (exitCode) => {
    void cleanup(exitCode).finally(() => process.exit(exitCode));
  };

  process.once("beforeExit", () => {
    void cleanup(process.exitCode ?? 0);
  });
  process.once("SIGINT", () => cleanupAndExit(130));
  process.once("SIGTERM", () => cleanupAndExit(143));
  process.once("uncaughtException", (error) => {
    appendJsonLine(logPath, {
      event: "daemon-uncaught-exception",
      pid: process.pid,
      at: Date.now(),
      message: error?.message,
    });
    cleanupAndExit(1);
  });
  process.once("unhandledRejection", (reason) => {
    appendJsonLine(logPath, {
      event: "daemon-unhandled-rejection",
      pid: process.pid,
      at: Date.now(),
      message: String(reason),
    });
    cleanupAndExit(1);
  });

  await daemon.start();
  appendJsonLine(logPath, {
    event: "daemon-started",
    pid: process.pid,
    at: Date.now(),
    controlPort: daemon.discoveryInfo?.controlPort,
  });
}

void main().catch((error) => {
  const discoveryPathIndex = process.argv.findIndex(
    (arg) => arg === "--discovery-path",
  );
  const discoveryPath =
    discoveryPathIndex >= 0 ? process.argv[discoveryPathIndex + 1] : undefined;
  const dataDir = discoveryPath ? path.dirname(discoveryPath) : process.cwd();
  appendJsonLine(path.join(dataDir, LOG_FILE_NAME), {
    event: "daemon-entry-error",
    pid: process.pid,
    at: Date.now(),
    message: error?.message,
    stack: error?.stack,
  });
  process.exit(1);
});
