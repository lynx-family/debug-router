// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

require("../multiplexer/register_ts");

const {
  PhysicalConnector,
} = require("../../../debug_router_connector/src/physical/PhysicalConnector");
const {
  setDriverReportService,
} = require("../../../debug_router_connector/src/report/interface/DriverReportService");

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createReportService() {
  const state = {
    initCalls: [],
    reports: [],
  };

  return {
    state,
    init(manualConnect) {
      state.initCalls.push(manualConnect);
    },
    report(eventName, metrics, categories) {
      state.reports.push({ eventName, metrics, categories });
    },
  };
}

function createConnector(option = {}) {
  return new PhysicalConnector({
    manualConnect: false,
    enableWebSocket: false,
    enableAndroid: false,
    enableIOS: false,
    enableHarmony: false,
    enableDesktop: false,
    enableNetworkDevice: false,
    reportService: null,
    traceRecorder: null,
    ...option,
  });
}

function collect(connector, event) {
  const payloads = [];
  connector.on(event, (payload) => payloads.push(payload));
  return payloads;
}

function createDevice(serial, overrides = {}) {
  const state = {
    startWatchCalls: 0,
    stopWatchCalls: 0,
    disconnectCalls: 0,
  };
  return {
    info: {
      serial,
      os: overrides.os ?? "Android",
      title: overrides.title ?? `Device ${serial}`,
    },
    ports: overrides.ports ?? [9001],
    state,
    get serial() {
      return this.info.serial;
    },
    startWatchClient() {
      state.startWatchCalls++;
    },
    stopWatchClient() {
      state.stopWatchCalls++;
    },
    disConnect() {
      state.disconnectCalls++;
    },
  };
}

function createClient(id, overrides = {}) {
  const state = {
    sendMessages: [],
    sendRawMessages: [],
    closeCalls: 0,
  };
  const deviceId = overrides.deviceId ?? "device-1";
  return {
    info: {
      id,
      port: overrides.port ?? 9000 + id,
      query: {
        app: overrides.app ?? `app-${id}`,
        os: overrides.os ?? "Android",
        device: overrides.device ?? "Pixel",
        device_model: overrides.deviceModel ?? "Pixel",
        device_id: deviceId,
        sdk_version: overrides.sdkVersion ?? "1.0.0",
        raw_info: overrides.rawInfo ?? {
          AppProcessName: overrides.processName ?? `com.demo.${id}`,
          App: overrides.appName ?? `Demo ${id}`,
        },
      },
    },
    state,
    clientId() {
      return this.info.id;
    },
    deviceId() {
      return this.info.query.device_id;
    },
    sendMessage(message) {
      state.sendMessages.push(message);
    },
    async sendRawMessage(message) {
      state.sendRawMessages.push(message);
      if (overrides.sendRawError) {
        throw overrides.sendRawError;
      }
      return overrides.sendRawResult ?? { id: message.id, result: "ok" };
    },
    close() {
      state.closeCalls++;
    },
  };
}

describe("PhysicalConnector", function () {
  afterEach(function () {
    setDriverReportService(null);
  });

  it("initializes reporting, clamps retry time, and creates bounded client ids", function () {
    const reportService = createReportService();
    const connector = createConnector({
      manualConnect: false,
      reportService,
      usbConnectOpt: { retryTime: 1 },
    });

    assert.deepStrictEqual(reportService.state.initCalls, [false]);
    assert.strictEqual(connector.usbConnectOpt.retryTime, 3000);
    assert(
      reportService.state.reports.some(
        (entry) => entry.eventName === "PhysicalConnectorInit",
      ),
    );
    assert(
      reportService.state.reports.some(
        (entry) => entry.eventName === "PhysicalConnectorInitOfNoManualConnect",
      ),
    );
    assert.strictEqual(connector.createClientId(), 1);
    connector.nextClientId = 4294967295;
    assert.strictEqual(connector.createClientId(), 1);
  });

  it("starts added device managers and reports watch failures", async function () {
    const reportService = createReportService();
    const connector = createConnector({ reportService });
    const calls = [];
    connector.addDeviceManager({
      async watchDevices() {
        calls.push("first");
      },
    });
    connector.addDeviceManager({
      async watchDevices() {
        calls.push("second");
      },
    });

    const devices = await connector.connectDevices(-1);
    assert.deepStrictEqual(calls, ["first", "second"]);
    assert.deepStrictEqual(devices, []);

    const failing = createConnector({ reportService });
    failing.addDeviceManager({
      async watchDevices() {
        throw new Error("adb down");
      },
    });

    await assert.rejects(
      () => failing.connectDevices(-1),
      /adb down/,
    );
    assert(
      reportService.state.reports.some(
        (entry) =>
          entry.eventName === "device_connect_error" &&
          entry.categories.msg === "watchDevices error:adb down",
      ),
    );
  });

  it("registers devices once, emits events, records trace, and unregisters them", function () {
    const trace = {
      registered: [],
      unregistered: [],
      recordDeviceRegistered(serial, info) {
        this.registered.push({ serial, info });
      },
      recordDeviceUnregistered(serial, info) {
        this.unregistered.push({ serial, info });
      },
    };
    const connector = createConnector({ traceRecorder: trace });
    const connected = collect(connector, "device-connected");
    const disconnected = collect(connector, "device-disconnected");
    const device = createDevice("device-1");

    connector.registerDevice(device);
    connector.registerDevice(createDevice("device-1"));

    assert.strictEqual(connector.devices.get("device-1"), device);
    assert.strictEqual(device.state.startWatchCalls, 1);
    assert.deepStrictEqual(connected, [device]);
    assert.deepStrictEqual(trace.registered, [
      {
        serial: "device-1",
        info: { os: "Android", title: "Device device-1" },
      },
    ]);

    connector.unregisterDevice("missing-device");
    connector.unregisterDevice("device-1");

    assert.strictEqual(connector.devices.has("device-1"), false);
    assert.strictEqual(device.state.disconnectCalls, 1);
    assert.deepStrictEqual(disconnected, [device]);
    assert.deepStrictEqual(trace.unregistered, [
      {
        serial: "device-1",
        info: { os: "Android", title: "Device device-1" },
      },
    ]);
  });

  it("respects manual connection and explicit watch flags when registering devices", function () {
    const manual = createConnector({ manualConnect: true });
    const manualDevice = createDevice("manual-device");
    manual.registerDevice(manualDevice);
    assert.strictEqual(manualDevice.state.startWatchCalls, 0);

    const automatic = createConnector({ manualConnect: false });
    const skippedDevice = createDevice("skipped-device");
    automatic.registerDevice(skippedDevice, false);
    assert.strictEqual(skippedDevice.state.startWatchCalls, 0);
  });

  it("registers and unregisters USB clients with compatibility events and selection cleanup", function () {
    const connector = createConnector();
    const connected = collect(connector, "client-connected");
    const appConnected = collect(connector, "app-client-connected");
    const disconnected = collect(connector, "client-disconnected");
    const appDisconnected = collect(connector, "app-client-disconnected");
    const client = createClient(7);

    connector.regiserUsbClient(client);
    connector.regiserUsbClient(createClient(7));
    connector.selecteUsbClient(7);

    assert.strictEqual(connector.usbClients.get(7), client);
    assert.strictEqual(connector.selectedClient, client);
    assert.deepStrictEqual(connected, [client]);
    assert.deepStrictEqual(appConnected, [client]);

    connector.unregiserUsbClient(404);
    connector.unregiserUsbClient(7);

    assert.strictEqual(connector.usbClients.has(7), false);
    assert.strictEqual(connector.selectedClient, undefined);
    assert.deepStrictEqual(disconnected, [7]);
    assert.deepStrictEqual(appDisconnected, [7]);
  });

  it("queries existing and future devices by serial with timeout cleanup", async function () {
    const connector = createConnector();
    const deviceA = createDevice("device-a");
    const deviceB = createDevice("device-b");
    connector.registerDevice(deviceA);

    assert.deepStrictEqual(await connector.getDevices(-1, null), [deviceA]);
    assert.deepStrictEqual(await connector.getDevices(-1, "device-a"), [
      deviceA,
    ]);
    assert.deepStrictEqual(await connector.getDevices(-1, "missing"), []);

    const waiting = connector.getDevices(50, "device-b");
    setTimeout(() => connector.registerDevice(deviceB), 5);
    assert.deepStrictEqual(await waiting, [deviceB]);

    assert.deepStrictEqual(await connector.getDevices(5, "never"), []);
  });

  it("connects USB clients through a device watcher and filters clients by platform name", async function () {
    const connector = createConnector();
    const device = createDevice("device-1");
    const android = createClient(1, {
      deviceId: "device-1",
      os: "Android",
      processName: "com.target",
    });
    const ios = createClient(2, {
      deviceId: "device-1",
      os: "iOS",
      deviceModel: "iPhone 15",
      appName: "TargetApp",
    });
    const other = createClient(3, {
      deviceId: "device-2",
      processName: "com.target",
    });
    connector.registerDevice(device, false);
    connector.regiserUsbClient(android);
    connector.regiserUsbClient(ios);
    connector.regiserUsbClient(other);

    assert.deepStrictEqual(
      await connector.connectUsbClients("device-1", -1, true, null),
      [android, ios],
    );
    assert.strictEqual(device.state.startWatchCalls, 1);
    assert.strictEqual(device.state.stopWatchCalls, 1);

    assert.deepStrictEqual(
      await connector.getDeviceUsbClients("device-1", -1, "com.target"),
      [android],
    );
    assert.deepStrictEqual(
      await connector.getDeviceUsbClients("device-1", -1, "TargetApp"),
      [ios],
    );
    assert.deepStrictEqual(
      await connector.connectUsbClients("missing-device", -1, true, null),
      [],
    );
  });

  it("deduplicates USB clients with the same runtime identity", function () {
    const connector = createConnector();
    const connected = collect(connector, "client-connected");
    const first = createClient(1, {
      deviceId: "device-1",
      port: 9222,
      processName: "com.target",
      appName: "TargetApp",
    });
    const duplicate = createClient(2, {
      deviceId: "device-1",
      port: 9222,
      processName: "com.target",
      appName: "TargetApp",
    });

    connector.regiserUsbClient(first);
    connector.regiserUsbClient(duplicate);

    assert.deepStrictEqual(
      connector.getAllUsbClients().map((client) => client.clientId()),
      [1],
    );
    assert.deepStrictEqual(
      connected.map((client) => client.clientId()),
      [1],
    );
    assert.strictEqual(duplicate.state.closeCalls, 1);
  });

  it("waits for future clients and times out with the current device clients", async function () {
    const connector = createConnector();
    const device = createDevice("device-1");
    const initial = createClient(1, { deviceId: "device-1" });
    connector.registerDevice(device, false);
    connector.regiserUsbClient(initial);

    assert.deepStrictEqual(await connector.waitDeviceUsbClients("missing"), []);
    assert.deepStrictEqual(
      await connector.waitDeviceUsbClients("device-1", -1),
      [initial],
    );

    connector.unregiserUsbClient(1);
    const future = createClient(2, { deviceId: "device-1" });
    const waiting = connector.waitDeviceUsbClients("device-1", 50);
    setTimeout(() => connector.regiserUsbClient(future), 5);
    assert.deepStrictEqual(await waiting, [future]);

    connector.unregiserUsbClient(2);
    assert.deepStrictEqual(
      await connector.waitDeviceUsbClients("device-1", 5),
      [],
    );
  });

  it("waits for a named future USB client through getDeviceUsbClients", async function () {
    const connector = createConnector();
    connector.registerDevice(createDevice("device-1"), false);

    const matching = createClient(1, {
      deviceId: "device-1",
      processName: "com.target",
    });
    const ignored = createClient(2, {
      deviceId: "device-2",
      processName: "com.target",
    });

    const waiting = connector.getDeviceUsbClients("device-1", 50, "com.target");
    setTimeout(() => {
      connector.regiserUsbClient(ignored);
      connector.regiserUsbClient(matching);
    }, 5);
    assert.deepStrictEqual(await waiting, [matching]);
    assert.deepStrictEqual(
      await connector.getDeviceUsbClients("device-1", 5, "missing-app"),
      [],
    );
  });

  it("emits USB messages and delegates send, raw send, close, and app-client queries", async function () {
    const connector = createConnector();
    const messages = collect(connector, "usb-client-message");
    const client = createClient(5, {
      sendRawResult: { id: 10, result: { ok: true } },
    });
    connector.regiserUsbClient(client);

    connector.handleUsbMessage(5, "payload");
    connector.sendMessage(5, { method: "Runtime.enable" });
    assert.deepStrictEqual(messages, [{ id: 5, message: "payload" }]);
    assert.deepStrictEqual(client.state.sendMessages, [
      { method: "Runtime.enable" },
    ]);

    await assert.rejects(
      () => connector.sendRawMessage(404, { id: 1, method: "Missing" }),
      /client not found:404/,
    );
    assert.deepStrictEqual(
      await connector.sendRawMessage(5, { id: 10, method: "Runtime.evaluate" }),
      { id: 10, result: { ok: true } },
    );
    assert.deepStrictEqual(client.state.sendRawMessages, [
      { id: 10, method: "Runtime.evaluate" },
    ]);

    assert.deepStrictEqual(connector.getAllAppClients(), [client]);
    assert.deepStrictEqual(connector.getAllPhysicalClients(), [client]);
    connector.closeClient(404);
    connector.closeClient(5);
    assert.strictEqual(client.state.closeCalls, 1);
  });

  it("stops device watchers and closes clients once when closed", async function () {
    const connector = createConnector();
    const device = createDevice("device-1");
    const client = createClient(1);
    connector.registerDevice(device, false);
    connector.regiserUsbClient(client);

    connector.disableAllClients();
    assert.strictEqual(device.state.stopWatchCalls, 1);
    assert.strictEqual(client.state.closeCalls, 1);

    await connector.close();
    await connector.close();
    assert.strictEqual(device.state.stopWatchCalls, 2);
    assert.strictEqual(client.state.closeCalls, 2);

    await delay(0);
  });
});
