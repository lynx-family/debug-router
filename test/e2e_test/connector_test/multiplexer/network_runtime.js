const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DebugRouterConnector } = require("@lynx-js/debug-router-connector");
const {
  createMultiplexerPaths,
} = require("@lynx-js/debug-router-connector/dist/cjs/src/multiplexer/utils/paths");
const {
  startFakeDebugRouterAppServer,
} = require("../debug_router_connector_auto_test");
const { stopDaemonProcesses } = require("./daemon_process");

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
      "mux-network-runtime-"
    )
  );
  const paths = createMultiplexerPaths({ rootDir });
  const originalHome = process.env.HOME;
  const connectors = [];
  let app;
  process.env.HOME = path.join(rootDir, "home");
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const createConnector = (enableNetworkDevice = true) => {
    const connector = new DebugRouterConnector({
      manualConnect: true,
      enableAndroid: false,
      enableIOS: false,
      enableHarmony: false,
      enableDesktop: false,
      enableNetworkDevice,
      enableWebSocket: true,
      multiplexerRootDir: rootDir,
      multiplexerLegacyDriverDir: path.join(rootDir, "legacy"),
      multiplexerDaemonIdleTimeout: 1000,
    });
    connectors.push(connector);
    return connector;
  };
  try {
    app = await startFakeDebugRouterAppServer();
    const first = createConnector();
    const peer = createConnector();
    const observer = createConnector(false);
    const options = { ip: "127.0.0.1", port: [app.port] };
    const deviceEvents = [];
    first.on("device-connected", (device) => deviceEvents.push(device.serial));

    await Promise.all([
      first.watchNetworkDeviceAtIp(options),
      peer.watchNetworkDeviceAtIp(options),
    ]);
    await first.watchNetworkDeviceAtIp({ ip: options.ip, port: [1] });
    await first.watchNetworkDeviceAtIp({ ip: "127.0.0.2", port: [] });
    await observer.startWSServer();
    assert.deepStrictEqual(deviceEvents, ["127.0.0.1", "127.0.0.2"]);
    assert.deepStrictEqual(
      [...first.devices.keys()],
      ["127.0.0.1", "127.0.0.2"]
    );
    await waitFor(
      () => peer.devices.has("127.0.0.2"),
      "shared network device snapshot"
    );
    assert.deepStrictEqual(
      [...peer.devices.keys()],
      ["127.0.0.1", "127.0.0.2"]
    );
    assert.strictEqual(observer.devices.size, 0);
    assert.deepStrictEqual(first.devices.get(options.ip).ports, [app.port]);
    assert(observer.wssHost && !observer.wssHost.startsWith("0.0.0.0:"));
    console.log(
      "[multiplexer-network-runtime-e2e] runtime add, shared IP deduplication and visibility passed"
    );

    const roundTrip = async (connector, marker) => {
      await waitFor(
        () => connector.getAllUsbClients().length === 1,
        "automatic network client discovery"
      );
      const clients = await connector.connectUsbClients(options.ip);
      assert.strictEqual(clients.length, 1);
      assert.strictEqual(clients[0].info.query.app, app.appName);
      const response = await clients[0].sendCustomizedMessage(
        "NetworkRuntime.Ping",
        { marker },
        -1,
        "App"
      );
      assert.strictEqual(JSON.parse(response).result.params.marker, marker);
    };
    await Promise.all([roundTrip(first, "first"), roundTrip(peer, "peer")]);
    console.log("[multiplexer-network-runtime-e2e] message routing passed");
  } finally {
    try {
      for (const connector of connectors) await connector.close();
    } finally {
      await stopDaemonProcesses(paths.daemonProcessName);
      await app?.close();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
  console.log("[multiplexer-network-runtime-e2e] TEST SUCCESS");
}

main().catch((error) => {
  console.error("[multiplexer-network-runtime-e2e] TEST FAILED", error);
  process.exitCode = 1;
});
