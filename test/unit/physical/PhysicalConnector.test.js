// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

const {
  PhysicalConnector,
} = require("../../../debug_router_connector/dist/cjs/src/physical/PhysicalConnector");

const ASYNC_TEST_TIMEOUT = 250;

function createConnector() {
  return new PhysicalConnector();
}

function collect(connector, event) {
  const payloads = [];
  connector.on(event, (payload) => payloads.push(payload));
  return payloads;
}

function assertSameMembers(actual, expected) {
  assert.strictEqual(actual.length, expected.length);
  expected.forEach((entry) => assert(actual.includes(entry)));
}

function createDevice(
  serial,
  {
    os = "Android",
    title = `Device ${serial}`,
    ports = [9001],
    infoExtras = {},
  } = {}
) {
  const state = {
    startWatchCalls: 0,
    stopWatchCalls: 0,
    disconnectCalls: 0,
  };
  const info = {
    ...infoExtras,
    serial,
    os,
    title,
  };

  return {
    info,
    ports,
    state,
    get serial() {
      return info.serial;
    },
    startWatchClient() {
      state.startWatchCalls++;
    },
    stopWatchClient() {
      state.stopWatchCalls++;
    },
    disconnect() {
      state.disconnectCalls++;
    },
  };
}

function assertDeviceContract(device, expected) {
  assert.strictEqual(typeof device.serial, "string");
  assert.strictEqual(device.serial, expected.serial);
  assert.strictEqual(device.info.serial, expected.serial);
  assert.strictEqual(device.info.os, expected.os);
  assert.strictEqual(device.info.title, expected.title);
  assert(Array.isArray(device.ports));
  device.ports.forEach((port) => assert(Number.isSafeInteger(port)));
}

function createClient(
  id,
  {
    deviceId = "device-1",
    port = 9000 + id,
    app = `app-${id}`,
    os = "Android",
    device = "Pixel",
    deviceModel = "Pixel",
    sdkVersion = "1.0.0",
    processName = `com.demo.${id}`,
    appName = `Demo ${id}`,
    rawInfoExtras = {},
    queryExtras = {},
    infoExtras = {},
  } = {}
) {
  const state = {
    closeCalls: 0,
  };
  const info = {
    ...infoExtras,
    id,
    port,
    query: {
      ...queryExtras,
      app,
      os,
      device,
      device_model: deviceModel,
      device_id: deviceId,
      sdk_version: sdkVersion,
      raw_info: {
        ...rawInfoExtras,
        AppProcessName: processName,
        App: appName,
      },
    },
  };

  return {
    info,
    state,
    clientId() {
      return info.id;
    },
    deviceId() {
      return info.query.device_id;
    },
    close() {
      state.closeCalls++;
    },
  };
}

function assertClientContract(client, expected) {
  assert(Number.isSafeInteger(client.clientId()));
  assert.strictEqual(client.clientId(), expected.id);
  assert.strictEqual(client.info.id, expected.id);
  assert.strictEqual(typeof client.deviceId(), "string");
  assert.strictEqual(client.deviceId(), expected.deviceId);
  assert.strictEqual(client.info.query.device_id, expected.deviceId);
  assert.strictEqual(typeof client.info.query.os, "string");
  assert.strictEqual(typeof client.info.query.device_model, "string");
  assert.strictEqual(typeof client.info.query.raw_info, "object");
  assert.notStrictEqual(client.info.query.raw_info, null);
}

describe("PhysicalConnector", function () {
  it("keeps physical options bounded and allocates unique numeric client IDs", async function () {
    const connector = createConnector();
    connector.updateUsbConnectOption({ retryTime: 1 });

    assert.strictEqual(connector.usbConnectRetryTime, 3000);
    assert.deepStrictEqual(await connector.connectDevices(-1), []);

    const clientIds = [
      connector.createClientId(),
      connector.createClientId(),
      connector.createClientId(),
    ];
    clientIds.forEach((id) => {
      assert(Number.isSafeInteger(id));
      assert(id > 0);
    });
    assert.strictEqual(new Set(clientIds).size, clientIds.length);
  });

  it("starts a device watcher only when the host predicate permits it", async function () {
    const connector = createConnector();
    const device = createDevice("device-1");
    let shouldStart = false;

    await connector.startWatchClient(device, () => shouldStart);
    assert.strictEqual(device.state.startWatchCalls, 0);

    shouldStart = true;
    await connector.startWatchClient(device, () => shouldStart);
    assert.strictEqual(device.state.startWatchCalls, 1);
  });

  it("owns device lifecycle state without automatically starting watchers", function () {
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
    const connector = new PhysicalConnector(trace);
    const connected = collect(connector, "device-connected");
    const disconnected = collect(connector, "device-disconnected");
    const device = createDevice("device-1", {
      infoExtras: { transport: "USB" },
    });
    const duplicate = createDevice("device-1");

    connector.registerDevice(device);
    connector.registerDevice(duplicate);

    assertDeviceContract(connected[0], {
      serial: "device-1",
      os: "Android",
      title: "Device device-1",
    });
    assert.strictEqual(connected[0], device);
    assert.strictEqual(connector.devices.get("device-1"), device);
    assert.strictEqual(device.state.startWatchCalls, 0);
    assert.strictEqual(duplicate.state.startWatchCalls, 0);
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

  it("owns USB client lifecycle state and emits strict physical events", function () {
    const connector = createConnector();
    const connected = collect(connector, "client-connected");
    const disconnected = collect(connector, "client-disconnected");
    const client = createClient(7, {
      deviceId: "device-1",
      infoExtras: { futureMetadata: true },
      queryExtras: { futureQueryField: "kept" },
    });
    const duplicate = createClient(7, { deviceId: "device-2" });

    connector.regiserUsbClient(client);
    connector.regiserUsbClient(duplicate);

    assertClientContract(connected[0], {
      id: 7,
      deviceId: "device-1",
    });
    assert.strictEqual(connected[0], client);
    assert.strictEqual(connector.usbClients.get(7), client);
    assert.strictEqual(client.info.futureMetadata, true);
    assert.strictEqual(client.info.query.futureQueryField, "kept");

    connector.unregiserUsbClient(404);
    connector.unregiserUsbClient(7);

    assert.strictEqual(connector.usbClients.has(7), false);
    assert.deepStrictEqual(disconnected, [7]);
    assert.strictEqual(typeof disconnected[0], "number");
  });

  it("keeps the USB message event payload typed while allowing additive fields", function () {
    const connector = createConnector();
    const received = [];
    const listener = (payload) => received.push(payload);
    const message = {
      id: 7,
      message: JSON.stringify({ method: "Runtime.consoleAPICalled" }),
      futureMetadata: "kept",
    };

    connector.on("usb-client-message", listener);
    connector.emit("usb-client-message", message);
    connector.off("usb-client-message", listener);
    connector.emit("usb-client-message", {
      id: 8,
      message: "ignored after unsubscribe",
    });

    assert.deepStrictEqual(received, [message]);
    assert(Number.isSafeInteger(received[0].id));
    assert(received[0].id > 0);
    assert.strictEqual(typeof received[0].message, "string");
    assert.strictEqual(received[0].futureMetadata, "kept");
  });

  it("queries current and future devices by stable serial identity", async function () {
    const connector = createConnector();
    const deviceA = createDevice("device-a");
    const deviceB = createDevice("device-b");
    connector.registerDevice(deviceA);

    assertSameMembers(await connector.getDevices(-1, null), [deviceA]);
    assert.deepStrictEqual(await connector.getDevices(-1, "device-a"), [
      deviceA,
    ]);
    assert.deepStrictEqual(await connector.getDevices(-1, "missing"), []);

    const waiting = connector.getDevices(ASYNC_TEST_TIMEOUT, "device-b");
    setImmediate(() => connector.registerDevice(deviceB));
    assert.deepStrictEqual(await waiting, [deviceB]);

    assert.deepStrictEqual(await connector.getDevices(0, "never"), []);
  });

  it("filters USB clients by device identity and platform application name", async function () {
    const connector = createConnector();
    const device = createDevice("device-1");
    const android = createClient(1, {
      deviceId: "device-1",
      os: "Android",
      processName: "com.target",
      rawInfoExtras: { futureAndroidField: "kept" },
    });
    const ios = createClient(2, {
      deviceId: "device-1",
      os: "iOS",
      deviceModel: "iPhone 15",
      appName: "TargetApp",
    });
    const otherDevice = createClient(3, {
      deviceId: "device-2",
      processName: "com.target",
    });
    connector.registerDevice(device);
    connector.regiserUsbClient(android);
    connector.regiserUsbClient(ios);
    connector.regiserUsbClient(otherDevice);

    assertSameMembers(connector.getAllUsbClients(), [
      android,
      ios,
      otherDevice,
    ]);
    assert.deepStrictEqual(
      await connector.getDeviceUsbClients("device-1", -1, "com.target"),
      [android]
    );
    assert.deepStrictEqual(
      await connector.getDeviceUsbClients("device-1", -1, "TargetApp"),
      [ios]
    );
    assert.deepStrictEqual(
      await connector.getDeviceUsbClients("device-1", -1, "missing-app"),
      []
    );
  });

  it("waits for the first USB client belonging to the requested device", async function () {
    const connector = createConnector();
    connector.registerDevice(createDevice("device-1"));
    connector.registerDevice(createDevice("device-2"));
    const ignored = createClient(1, { deviceId: "device-2" });
    const matching = createClient(2, { deviceId: "device-1" });

    const waiting = connector.waitDeviceUsbClients(
      "device-1",
      ASYNC_TEST_TIMEOUT
    );
    setImmediate(() => {
      connector.regiserUsbClient(ignored);
      connector.regiserUsbClient(matching);
    });

    assert.deepStrictEqual(await waiting, [matching]);
    assert.deepStrictEqual(
      await connector.waitDeviceUsbClients("unknown-device", 0),
      []
    );
  });

  it("waits for a named USB client without accepting another device", async function () {
    const connector = createConnector();
    connector.registerDevice(createDevice("device-1"));
    connector.registerDevice(createDevice("device-2"));
    const ignored = createClient(1, {
      deviceId: "device-2",
      processName: "com.target",
    });
    const matching = createClient(2, {
      deviceId: "device-1",
      processName: "com.target",
    });

    const waiting = connector.getDeviceUsbClients(
      "device-1",
      ASYNC_TEST_TIMEOUT,
      "com.target"
    );
    setImmediate(() => {
      connector.regiserUsbClient(ignored);
      connector.regiserUsbClient(matching);
    });

    assert.deepStrictEqual(await waiting, [matching]);
  });

  it("closes only the USB client selected by its numeric ID", function () {
    const connector = createConnector();
    const client = createClient(5);
    connector.regiserUsbClient(client);

    connector.closeClient(404);
    assert.strictEqual(client.state.closeCalls, 0);

    connector.closeClient(5);
    assert.strictEqual(client.state.closeCalls, 1);
  });

  it("creates managers independently while device registration retains the first serial", async function () {
    const connector = createConnector();
    const events = collect(connector, "device-connected");
    try {
      await Promise.all([
        connector.addNetworkDeviceManager({ ip: "127.0.0.1", port: [8901] }),
        connector.addNetworkDeviceManager({ ip: "127.0.0.1", port: [8902] }),
        connector.addNetworkDeviceManager({ ip: "127.0.0.2", port: [] }),
      ]);
      await connector.connectDevices();
      assert.deepStrictEqual(
        events.map((device) => device.serial),
        ["127.0.0.1", "127.0.0.2"]
      );
      assert.deepStrictEqual(connector.devices.get("127.0.0.1").ports, [8901]);
      assert.strictEqual(connector.devicesManager.size, 3);
      assert.strictEqual(
        connector.devices.get("127.0.0.2").getHost(),
        "127.0.0.2"
      );
    } finally {
      await connector.close();
    }
  });

  for (const count of [undefined, "3"]) {
    it(`uses BaseDevice ports for IP-only network watches (DriverPortCount=${count})`, async function () {
      const previous = process.env.DriverPortCount;
      if (count === undefined) delete process.env.DriverPortCount;
      else process.env.DriverPortCount = count;
      const connector = createConnector();
      try {
        await connector.addNetworkDeviceManager({ ip: "127.0.0.1" }, true);
        const expected = Array.from(
          { length: count ? Number(count) : 19 },
          (_, i) => 8901 + i
        );
        assert.deepStrictEqual(
          connector.devices.get("127.0.0.1").ports,
          expected
        );
        await connector.addNetworkDeviceManager(
          { ip: "127.0.0.1", port: [9000] },
          true
        );
        assert.deepStrictEqual(
          connector.devices.get("127.0.0.1").ports,
          expected
        );
        await connector.addNetworkDeviceManager(
          { ip: "127.0.0.2", port: [] },
          true
        );
        assert.deepStrictEqual(connector.devices.get("127.0.0.2").ports, []);
      } finally {
        if (previous === undefined) delete process.env.DriverPortCount;
        else process.env.DriverPortCount = previous;
        await connector.close();
      }
    });
  }

  it("uses default ports for an IP-only network manager", async function () {
    const previous = process.env.DriverPortCount;
    delete process.env.DriverPortCount;
    const connector = createConnector();
    await connector.addNetworkDeviceManager({ ip: "127.0.0.1" }, false);
    try {
      await connector.connectDevices();
      assert.deepStrictEqual(
        connector.devices.get("127.0.0.1").ports,
        Array.from({ length: 19 }, (_, i) => 8901 + i)
      );
    } finally {
      if (previous === undefined) delete process.env.DriverPortCount;
      else process.env.DriverPortCount = previous;
      await connector.close();
    }
  });

  it("leaves network manager deduplication to the Host", async function () {
    const connector = createConnector();
    await connector.addNetworkDeviceManager(
      { ip: "127.0.0.1", port: [8901] },
      false
    );
    try {
      await connector.connectDevices();
      const device = connector.devices.get("127.0.0.1");
      await connector.addNetworkDeviceManager({
        ip: "127.0.0.1",
        port: [8902],
      });
      assert.strictEqual(connector.devices.get("127.0.0.1"), device);
      assert.deepStrictEqual(device.ports, [8901]);
      assert.strictEqual(connector.devicesManager.size, 2);
    } finally {
      await connector.close();
    }
  });

  it("stops all physical resources and makes connector close idempotent", async function () {
    const connector = createConnector();
    const deviceA = createDevice("device-a");
    const deviceB = createDevice("device-b");
    const clientA = createClient(1, { deviceId: "device-a" });
    const clientB = createClient(2, { deviceId: "device-b" });
    connector.registerDevice(deviceA);
    connector.registerDevice(deviceB);
    connector.regiserUsbClient(clientA);
    connector.regiserUsbClient(clientB);

    await connector.close();
    await connector.close();

    assert.strictEqual(deviceA.state.stopWatchCalls, 1);
    assert.strictEqual(deviceB.state.stopWatchCalls, 1);
    assert.strictEqual(clientA.state.closeCalls, 1);
    assert.strictEqual(clientB.state.closeCalls, 1);
  });
});

describe("PhysicalConnector dynamic managers", function () {
  it("propagates watcher failures so the Host can close and retry the manager", async function () {
    const NetworkDeviceManager = require("../../../debug_router_connector/dist/cjs/src/device/network/NetworkDeviceManager")
      .default;
    const originalWatch = NetworkDeviceManager.prototype.watchDevices;
    const failure = new Error("watch failed");
    const connector = createConnector();
    NetworkDeviceManager.prototype.watchDevices = async () => {
      throw failure;
    };
    try {
      await assert.rejects(
        connector.addNetworkDeviceManager({ ip: "remote", port: [9001] }, true),
        (error) => error === failure
      );
      connector.closeNetworkDeviceManager("remote");
      NetworkDeviceManager.prototype.watchDevices = originalWatch;
      await connector.addNetworkDeviceManager(
        { ip: "remote", port: [9001] },
        true
      );
      assert.strictEqual(connector.devicesManager.size, 1);
      assert.deepStrictEqual(connector.devices.get("remote").ports, [9001]);
    } finally {
      NetworkDeviceManager.prototype.watchDevices = originalWatch;
      await connector.close();
    }
  });

  it("automatically watches an added Android manager only when manualConnect is false", async function () {
    const {
      AndroidDeviceManager,
    } = require("../../../debug_router_connector/dist/cjs/src/device/android/AndroidDeviceManager");
    const originalWatch = AndroidDeviceManager.prototype.watchDevices;
    const watched = [];
    AndroidDeviceManager.prototype.watchDevices = async function () {
      watched.push(this);
    };
    const connector = createConnector();
    try {
      await connector.addAndroidDeviceManager({ host: "manual" });
      connector.manualConnect = false;
      await connector.addAndroidDeviceManager({ host: "automatic" });
      assert.deepStrictEqual(
        watched.map((manager) => manager.adbOptions.host),
        ["automatic"]
      );
    } finally {
      AndroidDeviceManager.prototype.watchDevices = originalWatch;
      await connector.close();
    }
  });

  it("adds managers without starting them and watches them on connectDevices", async function () {
    const connector = createConnector();
    await connector.addAndroidDeviceManager({ host: "adb-remote", port: 5038 });
    await connector.addHarmonyDeviceManager({ host: "hdc-remote", port: 8711 });
    await connector.addDesktopDeviceManager();
    await connector.addIOSDeviceManager();
    const managers = Array.from(connector.devicesManager);
    assert.strictEqual(
      managers.length,
      ["darwin", "win32"].includes(process.platform) ? 4 : 3
    );
    assert.deepStrictEqual(managers[0].adbOptions, {
      host: "adb-remote",
      port: 5038,
    });
    assert.deepStrictEqual(managers[1].hdcOptions, {
      host: "hdc-remote",
      port: 8711,
    });
    let watched = 0;
    managers.forEach((manager) => {
      manager.watchDevices = async () => {
        watched++;
      };
    });
    await connector.connectDevices();
    assert.strictEqual(watched, managers.length);
    await connector.close();
  });

  it("keeps duplicate network device ownership with the first manager", async function () {
    const connector = createConnector();
    await connector.addNetworkDeviceManager(
      { ip: "remote", port: [9001] },
      false
    );
    await connector.addNetworkDeviceManager(
      { ip: "remote", port: [9002] },
      false
    );
    assert.strictEqual(connector.devices.size, 0);
    await connector.connectDevices();
    const device = connector.devices.get("remote");
    connector.addNetworkDeviceManager({ ip: "remote", port: [9003, 9001] });
    await connector.connectDevices();
    assert.strictEqual(connector.devices.get("remote"), device);
    assert.deepStrictEqual(device.ports, [9001]);
    assert.strictEqual(connector.devicesManager.size, 3);
    await connector.close();
  });

  it("updates the shared USB retry option with the existing minimum", async function () {
    const connector = createConnector();
    connector.updateUsbConnectOption({ retryTime: 8000 });
    connector.updateUsbConnectOption({ retryTime: 10000 });
    assert.strictEqual(connector.usbConnectRetryTime, 8000);
    connector.updateUsbConnectOption({ retryTime: 5000 });
    assert.strictEqual(connector.usbConnectRetryTime, 5000);
    connector.updateUsbConnectOption({ retryTime: 1 });
    assert.strictEqual(connector.usbConnectRetryTime, 3000);
    await connector.close();
  });
});

describe("Dynamic manager runtime addresses", function () {
  for (const platform of ["Android", "Harmony"]) {
    it(`isolates ${platform} manager cleanup across endpoints`, async function () {
      const directory = platform === "Android" ? "android" : "Harmony";
      const managerModule = require(`../../../debug_router_connector/dist/cjs/src/device/${directory}/${platform}DeviceManager`);
      const Manager =
        managerModule.AndroidDeviceManager ?? managerModule.default;
      const Device = require(`../../../debug_router_connector/dist/cjs/src/device/${directory}/${platform}Device`)
        .default;
      const connector = createConnector();
      const first = new Manager(connector, { host: "first" });
      const second = new Manager(connector, { host: "second" });
      const firstDevice = new Device(
        connector,
        "first-device",
        platform,
        {},
        "first"
      );
      const secondDevice = new Device(
        connector,
        "second-device",
        platform,
        {},
        "second"
      );
      first.createDevice = async () => firstDevice;
      second.createDevice = async () => secondDevice;
      try {
        await first.registerDevice({}, {});
        await second.registerDevice({}, {});
        if (platform === "Android") first.unregisterAllAndroidDevice();
        else first.unregisterAllHarmonyTarget();
        assert.strictEqual(connector.devices.has(firstDevice.serial), false);
        assert.strictEqual(
          connector.devices.get(secondDevice.serial),
          secondDevice
        );
        first.unregisterManagedDevice(secondDevice.serial);
        assert.strictEqual(
          connector.devices.get(secondDevice.serial),
          secondDevice
        );
      } finally {
        await connector.close();
      }
    });
  }

  it("uses the Android and Harmony runtime hosts supplied by their managers", async function () {
    const AndroidDevice = require("../../../debug_router_connector/dist/cjs/src/device/android/AndroidDevice")
      .default;
    const HarmonyDevice = require("../../../debug_router_connector/dist/cjs/src/device/Harmony/HarmonyDevice")
      .default;
    const connector = createConnector();
    assert.strictEqual(
      new AndroidDevice(connector, "a", "Android", {}, "second-adb").getHost(),
      "second-adb"
    );
    assert.strictEqual(
      new HarmonyDevice(connector, "h", "Harmony", {}, "second-hdc").getHost(),
      "second-hdc"
    );
    await connector.close();
  });
});
