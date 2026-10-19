// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License, Version 2.0.

const assert = require("assert");
const { EventEmitter } = require("events");
const root = "../../../debug_router_connector/dist/cjs/src";
const { PhysicalConnector } = require(`${root}/physical/PhysicalConnector`);
const { DeviceManager } = require(`${root}/device/DeviceManager`);
const {
  AndroidDeviceManager,
} = require(`${root}/device/android/AndroidDeviceManager`);
const HarmonyDeviceManager = require(`${root}/device/Harmony/HarmonyDeviceManager`)
  .default;
const IOSDeviceManager = require(`${root}/device/ios/iOSDeviceManager`).default;
const Tracker = require(`${root}/utils/hdc/tracker`).default;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function device(serial) {
  return {
    serial,
    info: { serial, os: "Android", title: serial },
    disconnects: 0,
    disconnect() {
      this.disconnects++;
    },
    stopWatchClient() {},
  };
}

class TestManager extends DeviceManager {
  async watchDevices() {}
}

describe("Device manager shutdown", function () {
  it("handles close from a device-connected listener", async function () {
    const connector = new PhysicalConnector();
    const manager = new TestManager(connector);
    connector.on("device-connected", () => manager.close());
    const owned = device("owned");
    manager.registerManagedDevice(owned);
    assert.strictEqual(connector.devices.size, 0);
    assert.strictEqual(owned.disconnects, 1);
    await connector.close();
  });

  it("does not unregister a replacement owned by another manager", async function () {
    const connector = new PhysicalConnector();
    const oldManager = new TestManager(connector);
    const newManager = new TestManager(connector);
    oldManager.registerManagedDevice(device("same-serial"));
    connector.unregisterDevice("same-serial");
    const replacement = device("same-serial");
    newManager.registerManagedDevice(replacement);
    oldManager.close();
    assert.strictEqual(connector.devices.get("same-serial"), replacement);
    assert.strictEqual(replacement.disconnects, 0);
    newManager.close();
    await connector.close();
  });

  it("unregisters only owned devices and ignores late registrations and retries", async function () {
    const connector = new PhysicalConnector();
    const first = new TestManager(connector);
    const second = new TestManager(connector);
    const owned = device("owned");
    const other = device("other");
    first.registerManagedDevice(owned);
    second.registerManagedDevice(other);
    let retries = 0;
    first.scheduleWatchRetry(() => retries++);
    first.close();
    first.close();
    assert.strictEqual(owned.disconnects, 1);
    assert.deepStrictEqual([...connector.devices.keys()], ["other"]);
    const late = device("late");
    first.registerManagedDevice(late);
    assert.strictEqual(late.disconnects, 1);
    assert.strictEqual(connector.devices.has("late"), false);
    first.scheduleWatchRetry(() => retries++);
    await new Promise((resolve) => setTimeout(resolve, 330));
    assert.strictEqual(retries, 0);
    second.close();
    await connector.close();
  });

  it("removes network managers from the registry and allows fresh options on re-add", async function () {
    const connector = new PhysicalConnector();
    connector.manualConnect = false;
    await connector.addNetworkDeviceManager({
      ip: "first",
      port: [1],
    });
    const [first] = connector.devicesManager;
    await connector.addNetworkDeviceManager({ ip: "second", port: [2] });
    connector.closeNetworkDeviceManager("first");
    assert.strictEqual(connector.devices.has("first"), false);
    assert.strictEqual(connector.devices.has("second"), true);
    assert.strictEqual(connector.devicesManager.has(first), false);
    await connector.connectDevices();
    assert.strictEqual(connector.devices.has("first"), false);
    await connector.addNetworkDeviceManager({
      ip: "first",
      port: [3],
    });
    const replacement = [...connector.devicesManager].find(
      (manager) => manager.ip === "first"
    );
    assert(replacement);
    assert.notStrictEqual(replacement, first);
    assert.deepStrictEqual(connector.devices.get("first").ports, [3]);
    connector.closeNetworkDeviceManager("first");
    assert.strictEqual(connector.devices.has("second"), true);
    connector.closeNetworkDeviceManager("second");
    assert.strictEqual(connector.devices.size, 0);
    assert.strictEqual(connector.devicesManager.size, 0);
    await connector.close();
  });

  it("closes selected managers without stopping other endpoints or platforms", async function () {
    const connector = new PhysicalConnector();
    await connector.addAndroidDeviceManager({ host: "one" });
    await connector.addAndroidDeviceManager({ host: "two" });
    await connector.addHarmonyDeviceManager();
    await connector.addDesktopDeviceManager();
    const managers = [...connector.devicesManager];
    connector.closeAndroidDeviceManager({ host: "one", port: 5037 });
    assert.strictEqual(connector.devicesManager.size, 3);
    assert.strictEqual(managers[0].closed, true);
    assert(managers.slice(1).every((manager) => !manager.closed));
    connector.closeAndroidDeviceManager({ host: "two", port: 5037 });
    assert.strictEqual(connector.devicesManager.size, 2);
    assert(managers.slice(0, 2).every((manager) => manager.closed));
    connector.closeHarmonyDeviceManager({ host: "127.0.0.1", port: 8710 });
    connector.closeDesktopDeviceManager();
    assert.strictEqual(connector.devicesManager.size, 0);
    await connector.close();
  });

  for (const platform of ["Android", "Harmony"]) {
    it(`closes only the selected ${platform} host and port`, async function () {
      const connector = new PhysicalConnector();
      const add = (options) =>
        connector[`add${platform}DeviceManager`](options);
      await add(undefined);
      await add({ host: "remote", port: 1001 });
      await add({ host: "remote", port: 1002 });
      await add({ host: "other", port: 1001 });
      const [local, first, second, other] = connector.devicesManager;
      connector[`close${platform}DeviceManager`]({
        host: "remote",
        port: 1001,
      });
      assert.strictEqual(first.closed, true);
      assert.strictEqual(second.closed, false);
      assert.strictEqual(other.closed, false);
      connector[`close${platform}DeviceManager`]({
        host: "127.0.0.1",
        port: platform === "Android" ? 5037 : 8710,
      });
      assert.strictEqual(local.closed, true);
      assert.strictEqual(connector.devicesManager.size, 2);
      connector[`close${platform}DeviceManager`]({
        host: "remote",
        port: 1002,
      });
      assert.strictEqual(connector.devicesManager.size, 1);
      assert.strictEqual(other.closed, false);
      connector[`close${platform}DeviceManager`]({
        host: "other",
        port: 1001,
      });
      assert.strictEqual(connector.devicesManager.size, 0);
      await connector.close();
    });
  }

  for (const [name, Manager, field, method] of [
    ["Android", AndroidDeviceManager, "adbClient", "trackDevices"],
    ["Harmony", HarmonyDeviceManager, "hdcClient", "trackTargets"],
  ]) {
    it(`disposes a ${name} tracker that arrives after close`, async function () {
      const connector = new PhysicalConnector();
      const manager = new Manager(connector, {});
      let resolve;
      manager[field] = {
        [method]: () =>
          new Promise((done) => {
            resolve = done;
          }),
      };
      await manager.watchDevices();
      manager.close();
      const tracker = new EventEmitter();
      let ends = 0;
      tracker.end = () => ends++;
      resolve(tracker);
      await tick();
      assert.strictEqual(ends, 1);
      assert.strictEqual(tracker.listenerCount("add"), 0);
      assert.doesNotThrow(() => tracker.emit("error", new Error("closed")));
      await connector.close();
    });

    it(`ends the active ${name} tracker once and ignores subsequent events`, async function () {
      const connector = new PhysicalConnector();
      const manager = new Manager(connector, {});
      const tracker = new EventEmitter();
      let ends = 0;
      tracker.end = () => ends++;
      manager[field] = { [method]: async () => tracker };
      await manager.watchDevices();
      await tick();
      manager.close();
      manager.close();
      assert.strictEqual(ends, 1);
      tracker.emit("add", {});
      tracker.emit("error", new Error("late error"));
      await manager.watchDevices();
      assert.strictEqual(connector.devices.size, 0);
      assert.strictEqual(manager.retryTimer, undefined);
      await connector.close();
    });
  }

  it("destroys iOS discovery sockets and tunnels and unregisters its devices", async function () {
    const connector = new PhysicalConnector();
    const manager = new IOSDeviceManager(connector);
    let destroyed = 0;
    manager.listener = {
      getRawSocket: () => ({
        destroy() {
          destroyed++;
        },
      }),
    };
    manager.tunnels.add({
      destroy() {
        destroyed++;
      },
    });
    await manager.registerDevice("iphone", "iPhone");
    manager.close();
    manager.close();
    await manager.watchDevices();
    assert.strictEqual(destroyed, 2);
    assert.strictEqual(connector.devices.size, 0);
    assert.strictEqual(manager.tunnels.size, 0);
    await connector.close();
  });

  it("does not resume HDC polling when an in-flight request completes after end", async function () {
    let resolve;
    const tracker = new Tracker({
      listTargets: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    let changes = 0;
    tracker.on("deviceChangeSet", () => changes++);
    tracker.end();
    resolve([]);
    await tick();
    assert.strictEqual(changes, 0);
    assert.strictEqual(tracker.timer, undefined);
  });

  it("closes registered managers when the physical connector closes", async function () {
    const connector = new PhysicalConnector();
    await connector.addNetworkDeviceManager({ ip: "network" });
    const [manager] = connector.devicesManager;
    await connector.close();
    assert.strictEqual(manager.closed, true);
    assert.strictEqual(connector.devicesManager.size, 0);
    assert.strictEqual(connector.devices.size, 0);
  });
});
