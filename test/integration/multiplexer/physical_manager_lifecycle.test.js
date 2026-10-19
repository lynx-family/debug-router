// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License, Version 2.0.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { waitFor, platformTimeout } = require("./helpers/integration_harness");
const load = (name) =>
  require(`../../../debug_router_connector/dist/cjs/src/${name}`);
const { PhysicalConnector } = load("physical/PhysicalConnector");
const { MultiplexerDaemonHost } = load(
  "multiplexer/daemon/MultiplexerDaemonHost"
);
const { MultiplexerDaemonClient } = load(
  "multiplexer/client/MultiplexerDaemonClient"
);
const { createMultiplexerPaths } = load("multiplexer/utils/paths");
const { MULTIPLEXER_PROTOCOL_VERSION } = load("multiplexer/protocol");
const { BaseDevice } = load("device/BaseDevice");
const AndroidDevice = load("device/android/AndroidDevice").default;
const adb = load("utils/adb.validator");
const hdc = load("utils/hdc.validator");
const usbmux = require("../../../debug_router_connector/dist/cjs/third_party/usbmux/lib/usbmux");

const disabled = {
  manualConnect: true,
  enableAndroid: false,
  enableIOS: false,
  enableHarmony: false,
  enableDesktop: false,
  enableNetworkDevice: false,
};
const discover = (client) => client.call("connectDevices", {});
const turn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("multiplexer integration physical manager lifecycle", function () {
  this.timeout(platformTimeout(10000));

  let rootDir, host, physical, clients, resources, restores, forwards;
  let nextTracker, properties, pendingOperations;

  function replace(object, name, value) {
    const original = object[name];
    object[name] = value;
    restores.push(() => {
      object[name] = original;
    });
  }

  function trackerClient(platform, options = {}) {
    const endpoint = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? (platform === "android" ? 5037 : 8710),
    };
    const track = async () => {
      const tracker = new EventEmitter();
      tracker.endCalls = 0;
      tracker.end = () => {
        tracker.endCalls++;
      };
      resources.push({ platform, ...endpoint, tracker });
      const pending = nextTracker;
      nextTracker = undefined;
      if (pending) await pending.promise;
      return tracker;
    };
    return {
      options: endpoint,
      trackDevices: track,
      trackTargets: track,
      getDevice: (serial) => ({ getProperties: () => properties(serial) }),
    };
  }

  beforeEach(async function () {
    clients = [];
    resources = [];
    restores = [];
    forwards = [];
    pendingOperations = [];
    nextTracker = undefined;
    properties = async () => ({ "ro.product.model": "Test Android" });
    // Keep real Host, PhysicalConnector, managers and socket transport. Only
    // hardware discovery/forwarding and runtime sockets are substituted.
    replace(adb, "getAdbInstance", async (options) =>
      trackerClient("android", options)
    );
    replace(hdc, "getHdcInstance", async (options) =>
      trackerClient("harmony", options)
    );
    replace(usbmux, "createListener", () => {
      const tracker = new EventEmitter();
      tracker.endCalls = 0;
      tracker.destroy = () => {
        tracker.endCalls++;
        tracker.emit("close", false);
      };
      resources.push({ platform: "ios", tracker });
      return tracker;
    });
    replace(BaseDevice.prototype, "startWatchClient", () => {});
    replace(AndroidDevice.prototype, "forwards", async function () {
      forwards.push(this);
      this.port = [];
    });
    rootDir = fs.mkdtempSync(
      path.join(
        process.platform === "win32" ? os.tmpdir() : "/tmp",
        "mux-platform-"
      )
    );
    const paths = createMultiplexerPaths({ rootDir });
    physical = new PhysicalConnector();
    host = new MultiplexerDaemonHost({
      physicalConnector: physical,
      physicalConnectorOption: disabled,
      controlEndpoint: paths.controlEndpoint,
      protocolVersion: MULTIPLEXER_PROTOCOL_VERSION,
      legacyDriverDir: path.join(rootDir, "legacy"),
      multiplexerDaemonIdleTimeout: -1,
    });
    await host.start();
  });

  afterEach(async function () {
    try {
      for (const client of clients) await client.close();
      await host?.stop();
    } finally {
      for (const pending of pendingOperations) pending.resolve();
      await turn();
      for (const restore of restores.reverse()) restore();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  async function connect(option = {}) {
    const client = new MultiplexerDaemonClient({
      // Host already listens in this process; registration and RPC still use
      // the real local socket, without spawning a second daemon.
      daemonManager: { setDaemonClient() {}, ensureDaemon: async () => true },
      controlEndpoint: host.option.controlEndpoint,
      connectorFacadeOption: { ...disabled, ...option },
    });
    client.snapshots = [];
    client.subscribe((event) => {
      if (event.event === "snapshot") client.snapshots.push(event.data);
    });
    clients.push(client);
    await client.connect();
    return client;
  }

  async function disconnect(client, abrupt = false) {
    const count = host.activeControlIds.size;
    if (abrupt)
      client.controlTransport.destroy(new Error("test: lost control socket"));
    else await client.close();
    await waitFor(() => host.activeControlIds.size === count - 1);
  }

  function assertPlatforms(expected) {
    assert.deepStrictEqual(
      [...host.enabledManagers.keys()].map((key) => key.platform).sort(),
      [...expected].sort()
    );
    assert.strictEqual(physical.devicesManager.size, expected.length);
  }

  it("releases only exclusive platforms when three controls have partially overlapping requirements", async function () {
    const observer = await connect();
    const first = await connect({ enableAndroid: true, enableDesktop: true });
    const second = await connect({ enableDesktop: true, enableHarmony: true });
    const third = await connect({
      enableHarmony: true,
      enableNetworkDevice: true,
      networkDeviceOpt: { ip: "127.0.0.2", port: [] },
    });
    await discover(first);
    await waitFor(() => resources.length === 2);
    assertPlatforms(["android", "desktop", "harmony", "network"]);
    const desktop = [...physical.devices.keys()].find(
      (serial) => serial !== "127.0.0.2"
    );
    assert(desktop);
    await disconnect(first);
    assertPlatforms(["desktop", "harmony", "network"]);
    assert.strictEqual(
      resources.find((r) => r.platform === "android").tracker.endCalls,
      1
    );
    assert(physical.devices.has(desktop));
    await disconnect(second, true);
    assertPlatforms(["harmony", "network"]);
    assert.strictEqual(
      resources.find((r) => r.platform === "harmony").tracker.endCalls,
      0
    );
    await waitFor(() => observer.snapshots.at(-1).devices.length === 1);
    assert.strictEqual(
      observer.snapshots.at(-1).devices[0].serial,
      "127.0.0.2"
    );
    await disconnect(third);
    assertPlatforms([]);
    await waitFor(() => observer.snapshots.at(-1).devices.length === 0);
    assert(resources.every((r) => r.tracker.endCalls === 1));
  });

  for (const [platform, flag, optionName, defaultPort] of [
    ["android", "enableAndroid", "adbHostPort", 5037],
    ["harmony", "enableHarmony", "hdcHostPort", 8710],
  ]) {
    it(`shares normalized ${platform} endpoints but releases different hosts and ports independently`, async function () {
      const first = await connect({ [flag]: true });
      const shared = await connect({
        [flag]: true,
        [optionName]: { host: "127.0.0.1", port: defaultPort },
      });
      const otherHost = await connect({
        [flag]: true,
        [optionName]: { host: "192.0.2.1", port: defaultPort },
      });
      const otherPort = await connect({
        [flag]: true,
        [optionName]: { host: "127.0.0.1", port: defaultPort + 1 },
      });
      await discover(first);
      await waitFor(() => resources.length === 3);
      assertPlatforms([platform, platform, platform]);
      const local = resources.find(
        (r) => r.host === "127.0.0.1" && r.port === defaultPort
      );
      await disconnect(first, true);
      assert.strictEqual(local.tracker.endCalls, 0);
      await disconnect(otherHost);
      assert.strictEqual(
        resources.find((r) => r.host === "192.0.2.1").tracker.endCalls,
        1
      );
      assert.strictEqual(local.tracker.endCalls, 0);
      await disconnect(otherPort, true);
      assertPlatforms([platform]);
      await disconnect(shared);
      assertPlatforms([]);
      assert(resources.every((r) => r.tracker.endCalls === 1));
    });

    it(`retains pending ${platform} discovery when one of its two controls disconnects`, async function () {
      const pending = deferred();
      pendingOperations.push(pending);
      nextTracker = pending;
      const first = await connect({ [flag]: true });
      await discover(first);
      const peer = await connect({ [flag]: true });
      await disconnect(first, true);
      pending.resolve();
      await waitFor(() => resources[0].tracker.listenerCount("add") === 1);
      await discover(peer);
      assert.strictEqual(
        resources.length,
        1,
        "pending discovery must be shared"
      );
      assert.strictEqual(resources[0].tracker.endCalls, 0);
      assertPlatforms([platform]);
      await disconnect(peer);
      assert.strictEqual(resources[0].tracker.endCalls, 1);
      assertPlatforms([]);
    });

    it(`disposes a late ${platform} tracker after disconnect without closing its replacement`, async function () {
      const pending = deferred();
      pendingOperations.push(pending);
      nextTracker = pending;
      const first = await connect({ [flag]: true });
      await discover(first);
      await waitFor(() => resources.length === 1);
      await disconnect(first, true);
      const second = await connect({ [flag]: true });
      await discover(second);
      await waitFor(() => resources.length === 2);
      pending.resolve();
      await waitFor(() => resources[0].tracker.endCalls === 1);
      assert.strictEqual(resources[0].tracker.listenerCount("add"), 0);
      assert.strictEqual(resources[1].tracker.endCalls, 0);
      assertPlatforms([platform]);
      await disconnect(second);
      assert.strictEqual(resources[1].tracker.endCalls, 1);
    });

    it(`keeps ${platform} discovery retrying for a remaining owner and stops retries after the last disconnect`, async function () {
      const first = await connect({ [flag]: true });
      const peer = await connect({ [flag]: true });
      await discover(first);
      resources[0].tracker.emit(
        "error",
        new Error("test: tracker unavailable")
      );
      await disconnect(first, true);
      await waitFor(() => resources.length === 2);
      assertPlatforms([platform]);
      assert.strictEqual(resources[0].tracker.endCalls, 1);
      resources[1].tracker.emit(
        "error",
        new Error("test: retry pending at close")
      );
      await disconnect(peer, true);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assertPlatforms([]);
      assert.strictEqual(
        resources.length,
        2,
        "closed manager must not restart discovery"
      );
      assert.strictEqual(resources[1].tracker.endCalls, 1);
    });
  }

  it("shares iOS listening and recreates it after the final control disconnects", async function () {
    if (!["darwin", "win32"].includes(process.platform)) this.skip();
    const first = await connect({ enableIOS: true });
    const second = await connect({ enableIOS: true });
    await discover(first);
    assert.strictEqual(resources.length, 1);
    await disconnect(first, true);
    assert.strictEqual(resources[0].tracker.endCalls, 0);
    await disconnect(second);
    assert.strictEqual(resources[0].tracker.endCalls, 1);
    const replacement = await connect({ enableIOS: true });
    await discover(replacement);
    assert.strictEqual(resources.length, 2);
    await disconnect(replacement);
    assert(resources.every((r) => r.tracker.endCalls === 1));
  });

  it("updates automatic mode after disconnect while keeping shared listeners and explicit network discovery working", async function () {
    const manual = await connect({ enableAndroid: true });
    assert.strictEqual(resources.length, 0);
    const automatic = await connect({ manualConnect: false });
    await waitFor(() => resources.length === 1);
    const automaticPeer = await connect({ manualConnect: false });
    await disconnect(automatic, true);
    assert.strictEqual(physical.manualConnect, false);
    const harmony = await connect({ enableHarmony: true });
    await waitFor(() => resources.length === 2);
    await disconnect(automaticPeer);
    assert.strictEqual(physical.manualConnect, true);
    assert(resources.every((r) => r.tracker.endCalls === 0));
    const network = await connect({
      enableNetworkDevice: true,
      networkDeviceOpt: { ip: "127.0.0.3", port: [] },
    });
    assert.strictEqual(
      physical.devices.size,
      0,
      "new manual manager must not start automatically"
    );
    await network.call("watchNetworkDeviceAtIp", { ip: "127.0.0.4", port: [] });
    assert(
      physical.devices.has("127.0.0.4"),
      "explicit watch must listen even in manual mode"
    );
    assert(!physical.devices.has("127.0.0.3"));
    await discover(manual);
    assert(physical.devices.has("127.0.0.3"));
    await disconnect(network);
    assert.strictEqual(physical.devices.size, 0);
    await disconnect(harmony);
    await disconnect(manual);
    assertPlatforms([]);
  });

  it("deduplicates concurrent network requests and releases all IPs once per disconnected control", async function () {
    const first = await connect();
    const second = await connect();
    const endpoint = { ip: "127.0.0.2", port: [12345] };
    await first.call("watchNetworkDeviceAtIp", endpoint);
    await Promise.all([
      ...Array.from({ length: 4 }, () =>
        first.call("watchNetworkDeviceAtIp", { ...endpoint, port: [] })
      ),
      second.call("watchNetworkDeviceAtIp", { ...endpoint, port: [] }),
      first.call("watchNetworkDeviceAtIp", { ip: "127.0.0.3", port: [] }),
    ]);
    assertPlatforms(["network", "network"]);
    const sharedDevice = physical.devices.get(endpoint.ip);
    assert.deepStrictEqual(sharedDevice.ports, endpoint.port);
    await disconnect(first, true);
    assertPlatforms(["network"]);
    assert.strictEqual(physical.devices.get(endpoint.ip), sharedDevice);
    assert(!physical.devices.has("127.0.0.3"));
    await disconnect(second);
    assertPlatforms([]);
    const replacement = await connect();
    await replacement.call("watchNetworkDeviceAtIp", { ...endpoint, port: [] });
    assert.notStrictEqual(physical.devices.get(endpoint.ip), sharedDevice);
    assert.deepStrictEqual(physical.devices.get(endpoint.ip).ports, []);
  });

  it("re-registers platform ownership after socket loss without replacing a manager still used by a peer", async function () {
    const first = await connect({ enableAndroid: true, enableDesktop: true });
    const peer = await connect({ enableAndroid: true });
    await discover(first);
    await waitFor(() => resources.length === 1);
    const shared = [...physical.devicesManager].find((manager) => manager.host);
    for (let round = 0; round < 3; round++) {
      await disconnect(first, true);
      assertPlatforms(["android"]);
      await first.connect();
      await discover(first);
      assertPlatforms(["android", "desktop"]);
      assert(physical.devicesManager.has(shared));
      assert.strictEqual(resources.length, 1);
      assert.deepStrictEqual(
        [...host.enabledManagers.values()]
          .map((usage) => usage.controlIds.size)
          .sort(),
        [1, 2]
      );
    }
    await disconnect(peer);
    assert.strictEqual(resources[0].tracker.endCalls, 0);
    await disconnect(first);
    assertPlatforms([]);
    assert.strictEqual(resources[0].tracker.endCalls, 1);
  });

  it("does not forward or register an Android device whose property lookup completes after owner loss", async function () {
    const pending = deferred();
    pendingOperations.push(pending);
    let lookups = 0;
    properties = () =>
      ++lookups === 1
        ? pending.promise
        : Promise.resolve({ "ro.product.model": "Replacement" });
    const first = await connect({ enableAndroid: true });
    await discover(first);
    resources[0].tracker.emit("add", { id: "same-device", type: "device" });
    await waitFor(() => lookups === 1);
    await disconnect(first, true);
    const replacement = await connect({ enableAndroid: true });
    await discover(replacement);
    resources[1].tracker.emit("add", { id: "same-device", type: "device" });
    await waitFor(() => physical.devices.has("same-device"));
    const device = physical.devices.get("same-device");
    pending.resolve({ "ro.product.model": "Stale" });
    await turn();
    assert.deepStrictEqual(
      forwards,
      [device],
      "stale initialization must not modify replacement forwards"
    );
    assert.strictEqual(physical.devices.get("same-device"), device);
    await disconnect(replacement);
    assert.strictEqual(physical.devices.size, 0);
  });

  it("creates one manager per key during concurrent registrations and releases it after concurrent closes", async function () {
    const group = await Promise.all(
      Array.from({ length: 8 }, () =>
        connect({
          manualConnect: false,
          enableAndroid: true,
          enableHarmony: true,
          enableNetworkDevice: true,
          networkDeviceOpt: { ip: "127.0.0.2", port: [] },
        })
      )
    );
    await waitFor(() => resources.length === 2 && physical.devices.size === 1);
    assertPlatforms(["android", "harmony", "network"]);
    assert(
      [...host.enabledManagers.values()].every(
        (usage) => usage.controlIds.size === group.length
      )
    );
    await Promise.all(group.slice(1).map((client) => client.close()));
    await waitFor(() => host.activeControlIds.size === 1);
    assertPlatforms(["android", "harmony", "network"]);
    assert(resources.every((r) => r.tracker.endCalls === 0));
    assert.strictEqual((await discover(group[0]))[0].serial, "127.0.0.2");
    await disconnect(group[0]);
    assertPlatforms([]);
    assert.strictEqual(physical.devices.size, 0);
    assert(resources.every((r) => r.tracker.endCalls === 1));
  });
});
