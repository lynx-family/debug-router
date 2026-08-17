// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const {
  MultiplexerDaemonClient,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/client/MultiplexerDaemonClient");
const {
  MultiplexerControlServer,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/MultiplexerControlServer");
const {
  MultiplexerControlTransport,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/transport/MultiplexerControlTransport");

function snapshot() {
  return {
    protocolVersion: 1,
    generatedAt: 1,
    devices: [],
    clients: [],
  };
}

describe("MultiplexerDaemonClient", function () {
  let tempDir;
  let endpoint;
  let server;
  let client;
  let ensureCalls;
  let connectedIds;

  beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-client-"));
    endpoint = path.join(tempDir, "control.sock");
    ensureCalls = 0;
    connectedIds = [];
  });

  afterEach(async function () {
    await client?.close().catch(() => {});
    await server?.stop().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function start(option = {}) {
    server = new MultiplexerControlServer({
      controlEndpoint: endpoint,
      protocolVersion: 1,
      host: {
        isInUse() {
          return connectedIds.length > 0;
        },
        handleControlConnected(id) {
          connectedIds.push(id);
          server.sendToControl(id, {
            kind: "event",
            event: "snapshot",
            data: snapshot(),
          });
        },
        handleControlRpc(_id, message) {
          if (option.handleControlRpc) {
            return option.handleControlRpc(message);
          }
          if (message.method === "startWSServer") {
            return { port: 19783, host: "127.0.0.1" };
          }
          return {};
        },
      },
    });
    await server.start();
    const manager = {
      controlEndpoint: endpoint,
      async ensureDaemon() {
        ensureCalls++;
        return {
          kind: "health-response",
          ok: true,
          protocolVersion: 1,
          isInUse: false,
        };
      },
      setDaemonClient(value) {
        this.client = value;
      },
      async stopDaemonForDebugging() {},
    };
    client = new MultiplexerDaemonClient({
      daemonManager: manager,
      controlEndpoint: endpoint,
      rpcTimeout: option.rpcTimeout ?? 100,
      debugInfo: option.debugInfo,
      now: () => 123,
    });
    return { manager };
  }

  it("ensures, registers, receives the initial snapshot, and reuses the socket", async function () {
    await start();
    const events = [];
    client.subscribe((event) => events.push(event));
    await client.connect();
    await client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(ensureCalls, 1);
    assert.strictEqual(client.ready, true);
    assert.deepStrictEqual(connectedIds, [1]);
    assert.strictEqual(events[0].event, "snapshot");
  });

  it("sends framed RPCs and resolves method-aware responses", async function () {
    await start();
    assert.deepStrictEqual(await client.call("startWSServer", {}), {
      port: 19783,
      host: "127.0.0.1",
    });
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("rejects invalid RPC params before ensuring the daemon", async function () {
    await start();
    await assert.rejects(
      () =>
        client.call("startDeviceClientWatcher", {
          deviceId: "",
        }),
      /Invalid multiplexer RPC startDeviceClientWatcher params/
    );
    assert.strictEqual(ensureCalls, 0);
    assert.strictEqual(client.ready, false);
  });

  it("uses direct Register/RPC for graceful shutdown without ensure", async function () {
    await start();
    await client.call("shutdownDaemon", { reason: "test" }, false);
    assert.strictEqual(ensureCalls, 0);
    assert.strictEqual(client.ready, true);
  });

  it("reuses a ready connection for direct daemon RPCs", async function () {
    await start();
    await client.connect();
    await client.call("shutdownDaemon", { reason: "test" }, false);
    assert.strictEqual(ensureCalls, 1);
    assert.deepStrictEqual(connectedIds, [1]);
    assert.strictEqual(client.ready, true);
  });

  it("rejects daemon RPC errors and invalid successful results", async function () {
    await start({
      handleControlRpc(message) {
        if (message.method === "startWSServer") {
          const error = new Error("disabled");
          error.code = "websocket-disabled";
          throw error;
        }
        return {};
      },
    });
    await assert.rejects(() => client.call("startWSServer", {}), /disabled/);
  });

  it("rejects pending RPCs when the control closes", async function () {
    await start({
      handleControlRpc() {
        return new Promise(() => {});
      },
      rpcTimeout: 1000,
    });
    const call = client.call("startWSServer", {});
    const rejection = assert.rejects(call, /socket/);
    await new Promise((resolve) => setImmediate(resolve));
    await server.stop();
    server = null;
    await rejection;
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("times out pending RPCs", async function () {
    await start({
      handleControlRpc() {
        return new Promise(() => {});
      },
      rpcTimeout: 20,
    });
    await assert.rejects(() => client.call("startWSServer", {}), /Timed out/);
    assert.strictEqual(client.pendingRpc.size, 0);
  });

  it("rejects an invalid Register response", async function () {
    const rawServer = net.createServer((socket) => {
      const transport = new MultiplexerControlTransport(socket);
      transport.onMessage(() => {
        transport.send({ kind: "unexpected" });
      });
    });
    await new Promise((resolve) => rawServer.listen(endpoint, resolve));
    const manager = {
      controlEndpoint: endpoint,
      async ensureDaemon() {},
      setDaemonClient() {},
      async stopDaemonForDebugging() {},
    };
    client = new MultiplexerDaemonClient({
      daemonManager: manager,
      controlEndpoint: endpoint,
    });
    await assert.rejects(() => client.connect(), /register response/);
    await new Promise((resolve) => rawServer.close(resolve));
  });

  it("emits connection state only after Register succeeds", async function () {
    await start();
    const states = [];
    client.subscribeConnectionState((state) => states.push(state.state));
    await client.connect();
    await client.close();
    assert.deepStrictEqual(states, ["connected", "disconnected"]);
  });

  it("keeps only the latest event and connection state listeners", async function () {
    await start();
    const firstEvents = [];
    const secondEvents = [];
    const firstStates = [];
    const secondStates = [];
    client.subscribe((event) => firstEvents.push(event));
    client.subscribe((event) => secondEvents.push(event));
    client.subscribeConnectionState((state) => firstStates.push(state.state));
    client.subscribeConnectionState((state) => secondStates.push(state.state));

    await client.connect();
    await client.close();

    assert.deepStrictEqual(firstEvents, []);
    assert.deepStrictEqual(
      secondEvents.map((event) => event.event),
      ["snapshot"]
    );
    assert.deepStrictEqual(firstStates, []);
    assert.deepStrictEqual(secondStates, ["connected", "disconnected"]);
  });
});
