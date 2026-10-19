// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License, Version 2.0.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");
const { DebugRouterConnector } = require("@lynx-js/debug-router-connector");
const {
  createMultiplexerPaths,
} = require("@lynx-js/debug-router-connector/dist/cjs/src/multiplexer/utils/paths");
const {
  startFakeDebugRouterAppServer,
} = require("../debug_router_connector_auto_test");
const { findDaemonProcess, stopDaemonProcesses } = require("./daemon_process");

async function waitFor(predicate, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function main() {
  const rootDir = fs.mkdtempSync(
    path.join(
      process.platform === "win32" ? os.tmpdir() : "/tmp",
      "mux-manager-lifecycle-"
    )
  );
  const paths = createMultiplexerPaths({ rootDir });
  const connectors = [];
  const workers = [];
  let app;
  const options = (networkDeviceOpt, extra = {}) => ({
    manualConnect: false,
    enableAndroid: false,
    enableIOS: false,
    enableHarmony: false,
    enableDesktop: false,
    enableNetworkDevice: true,
    networkDeviceOpt,
    multiplexerRootDir: rootDir,
    multiplexerLegacyDriverDir: path.join(rootDir, "legacy"),
    multiplexerDaemonIdleTimeout: 30000,
    ...extra,
  });
  const create = (networkDeviceOpt, extra) => {
    const connector = new DebugRouterConnector(
      options(networkDeviceOpt, extra)
    );
    connectors.push(connector);
    return connector;
  };
  const startWorker = async (endpoint, watches = []) => {
    const worker = fork(
      path.join(__dirname, "fixtures/physical_manager_owner.js"),
      [],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }
    );
    workers.push(worker);
    let output = "";
    for (const stream of [worker.stdout, worker.stderr]) {
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-8000);
      });
    }
    worker.exited = new Promise((resolve) => worker.once("exit", resolve));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`owner startup timeout: ${output}`)),
        15000
      );
      const onExit = (code, signal) =>
        finish(new Error(`owner exited (${code}, ${signal}): ${output}`));
      const onMessage = (message) =>
        finish(message.ready ? undefined : new Error(message.error));
      const finish = (error) => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("exit", onExit);
        worker.off("error", finish);
        if (error) reject(error);
        else resolve();
      };
      worker.once("error", finish);
      worker.once("exit", onExit);
      worker.once("message", onMessage);
      worker.send({ options: options(endpoint), watches });
    });
    return worker;
  };
  const killWorker = async (worker) => {
    if (worker.exitCode === null && worker.signalCode === null)
      worker.kill("SIGKILL");
    await worker.exited;
  };
  const ping = async (connector, ip, marker) => {
    const client = await waitFor(
      () =>
        connector.getAllUsbClients().find((client) => client.deviceId() === ip),
      `runtime for ${ip}`
    );
    const reply = await client.sendCustomizedMessage(
      "NetworkRuntime.Ping",
      { marker },
      -1,
      "App"
    );
    assert.strictEqual(JSON.parse(reply).result.params.marker, marker);
    return client;
  };
  try {
    app = await startFakeDebugRouterAppServer();
    const endpoint = { ip: "127.0.0.1", port: [app.port] };
    const first = create(endpoint);
    const peer = create();
    const observer = create();
    await Promise.all([
      first.connectDevices(),
      peer.connectDevices(),
      observer.connectDevices(),
    ]);
    await Promise.all([
      peer.watchNetworkDeviceAtIp({ ...endpoint, port: [] }),
      peer.watchNetworkDeviceAtIp(endpoint),
      first.watchNetworkDeviceAtIp({ ip: "127.0.0.2", port: [] }),
    ]);
    await waitFor(
      () => observer.devices.size === 2 && peer.getAllUsbClients().length === 1,
      "network discovery"
    );
    assert.deepStrictEqual(observer.devices.get(endpoint.ip).ports, [app.port]);

    await first.close();
    await waitFor(
      () => !observer.devices.has("127.0.0.2"),
      "exclusive IP removal"
    );
    assert(observer.devices.has(endpoint.ip));
    const client = peer.getAllUsbClients()[0];
    const reply = await client.sendCustomizedMessage(
      "NetworkRuntime.Ping",
      { marker: "remaining-owner" },
      -1,
      "App"
    );
    assert.strictEqual(
      JSON.parse(reply).result.params.marker,
      "remaining-owner"
    );

    await peer.close();
    await waitFor(
      () =>
        observer.devices.size === 0 && observer.getAllUsbClients().length === 0,
      "last owner cleanup"
    );
    // The observer keeps the daemon alive but does not own any endpoint yet.
    await observer.watchNetworkDeviceAtIp({ ip: endpoint.ip, port: [] });
    assert.deepStrictEqual(observer.devices.get(endpoint.ip).ports, []);
    console.log(
      "[physical-manager-lifecycle] shared ownership, last-owner cleanup and fresh re-add passed"
    );
    await observer.close();

    // A and B share desktop; A and C share one IP; B owns a second IP.
    // A network-only observer sees device removal without acquiring endpoints.
    const monitor = create(undefined, { manualConnect: true });
    await monitor.connectDevices();
    const desktopA = create(
      { ip: endpoint.ip, port: [] },
      { manualConnect: true, enableDesktop: true }
    );
    const desktopB = create(
      { ip: "127.0.0.2", port: [] },
      { manualConnect: true, enableDesktop: true }
    );
    const networkC = create(
      { ip: endpoint.ip, port: [] },
      { manualConnect: true }
    );
    await Promise.all([
      desktopA.connectDevices(),
      desktopB.connectDevices(),
      networkC.connectDevices(),
    ]);
    await desktopA.watchNetworkDeviceAtIp({ ip: "127.0.0.3", port: [] });
    await waitFor(
      () => desktopB.devices.size === 4 && monitor.devices.size === 3,
      "partially overlapping platforms"
    );
    const desktopId = [...desktopB.devices.keys()].find(
      (id) => !monitor.devices.has(id)
    );
    assert(desktopId, "desktop must be exposed only to facades enabling it");
    await desktopA.close();
    await waitFor(
      () => !monitor.devices.has("127.0.0.3"),
      "first control's exclusive IP cleanup"
    );
    assert(desktopB.devices.has(desktopId));
    assert(monitor.devices.has(endpoint.ip));
    await desktopB.close();
    await waitFor(
      () => monitor.devices.size === 1,
      "exclusive desktop and IP owner cleanup"
    );
    await networkC.close();
    await waitFor(
      () => monitor.devices.size === 0,
      "all overlapping owners removed"
    );
    console.log(
      "[physical-manager-lifecycle] partially overlapping desktop/network requirements passed"
    );

    const daemon = await findDaemonProcess(paths.daemonProcessName);
    assert(daemon);
    const owner = await startWorker(endpoint, [{ ip: "127.0.0.2", port: [] }]);
    const survivingOwner = await startWorker(endpoint);
    await waitFor(() => monitor.devices.size === 2, "worker-owned endpoints");
    const runtime = await ping(monitor, endpoint.ip, "before-process-crash");
    const runtimeDisconnects = [];
    monitor.on("client-disconnected", (id) => runtimeDisconnects.push(id));
    await killWorker(owner);
    await waitFor(
      () => !monitor.devices.has("127.0.0.2"),
      "exclusive endpoint removal after SIGKILL"
    );
    assert.strictEqual(
      await ping(monitor, endpoint.ip, "surviving-process"),
      runtime
    );
    assert(
      !runtimeDisconnects.includes(runtime.clientId()),
      "shared runtime must not disconnect"
    );
    await killWorker(survivingOwner);
    await waitFor(
      () =>
        monitor.devices.size === 0 && monitor.getAllUsbClients().length === 0,
      "last crashed owner cleanup"
    );
    assert.strictEqual(
      runtimeDisconnects.filter((id) => id === runtime.clientId()).length,
      1
    );
    const fresh = create({ ip: endpoint.ip, port: [] });
    await fresh.connectDevices();
    await waitFor(
      () => monitor.devices.has(endpoint.ip),
      "re-enable after process crashes"
    );
    assert.deepStrictEqual(monitor.devices.get(endpoint.ip).ports, []);
    assert.strictEqual(monitor.getAllUsbClients().length, 0);
    await fresh.close();
    await waitFor(() => monitor.devices.size === 0, "fresh manager removal");
    assert.strictEqual(
      (await findDaemonProcess(paths.daemonProcessName)).pid,
      daemon.pid
    );
    console.log(
      "[physical-manager-lifecycle] SIGKILL, surviving runtime, final-owner cleanup and re-enable passed"
    );

    const recovering = create(endpoint);
    const independent = create({ ip: "127.0.0.2", port: [] });
    await Promise.all([
      recovering.connectDevices(),
      independent.connectDevices(),
    ]);
    await waitFor(() => monitor.devices.size === 2, "recovery setup");
    await ping(recovering, endpoint.ip, "before-control-loss");
    const independentDevice = monitor.devices.get("127.0.0.2");
    const removed = [];
    const added = [];
    monitor.on("device-disconnected", (device) => removed.push(device.serial));
    monitor.on("device-connected", (device) => added.push(device.serial));
    // Fault injection only: recovery itself must use the facade's desired state.
    recovering.daemonClient.controlTransport.destroy(
      new Error("E2E: control connection lost")
    );
    await waitFor(
      () => removed.includes(endpoint.ip) && added.includes(endpoint.ip),
      "configured endpoint recovery"
    );
    await ping(recovering, endpoint.ip, "after-control-recovery");
    assert.strictEqual(monitor.devices.get("127.0.0.2"), independentDevice);
    assert(!removed.includes("127.0.0.2"));
    await recovering.close();
    await waitFor(
      () => !monitor.devices.has(endpoint.ip),
      "recovered owner release"
    );
    await independent.close();
    await waitFor(
      () => monitor.devices.size === 0,
      "independent owner release"
    );
    assert.strictEqual(
      (await findDaemonProcess(paths.daemonProcessName)).pid,
      daemon.pid
    );
    console.log(
      "[physical-manager-lifecycle] control reconnect restores configured capability and preserves other endpoints passed"
    );

    // Repeated concurrent registration/close catches leaked users and accidental
    // shared-manager replacement. The only remaining owner must keep its runtime.
    for (let round = 0; round < 3; round++) {
      const group = Array.from({ length: 4 }, () => create(endpoint));
      await Promise.all(group.map((connector) => connector.connectDevices()));
      await Promise.all(
        group.map((connector) =>
          connector.watchNetworkDeviceAtIp({ ...endpoint, port: [] })
        )
      );
      const retained = await ping(
        group[3],
        endpoint.ip,
        `churn-${round}-before`
      );
      await Promise.all(
        group.slice(0, 3).map((connector) => connector.close())
      );
      assert.strictEqual(
        await ping(group[3], endpoint.ip, `churn-${round}-after`),
        retained
      );
      await group[3].close();
      await waitFor(
        () =>
          monitor.devices.size === 0 && monitor.getAllUsbClients().length === 0,
        `churn ${round} cleanup`
      );
    }
    console.log(
      "[physical-manager-lifecycle] concurrent registration and last-owner churn passed (3 rounds)"
    );
  } finally {
    try {
      for (const worker of workers) await killWorker(worker);
      for (const connector of connectors) await connector.close();
    } finally {
      await stopDaemonProcesses(paths.daemonProcessName);
      await app?.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error("[physical-manager-lifecycle] FAILED", error);
  process.exitCode = 1;
});
