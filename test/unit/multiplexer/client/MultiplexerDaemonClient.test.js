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
        if (option.ensureDaemon) {
          return option.ensureDaemon();
        }
        return true;
      },
      setDaemonClient(value) {
        this.client = value;
      },
      stopCalls: [],
      async stopDaemonForDebugging(withRespawn = false) {
        this.stopCalls.push(withRespawn);
      },
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

  it("stops after three attempts when ensuring the daemon keeps returning false", async function () {
    await start({ ensureDaemon: async () => false });
    await assert.rejects(client.call("startWSServer", {}), /after multiple attempts/);
    assert.strictEqual(ensureCalls, 3);
    assert.strictEqual(client.status, "disconnected");
    assert.strictEqual(client.connectPromise, null);
    assert.strictEqual(client.controlTransport, null);
    assert.deepStrictEqual(connectedIds, []);
  });

  for (const failures of [0, 1]) {
    it(`does not retry ensureDaemon exceptions after ${failures} retryable failures`, async function () {
      const error = new Error("daemon cannot be replaced");
      await start({
        async ensureDaemon() {
          if (ensureCalls <= failures) return false;
          throw error;
        },
      });
      await assert.rejects(client.connect(), (value) => value === error);
      assert.strictEqual(ensureCalls, failures + 1);
      assert.strictEqual(client.status, "disconnected");
      assert.strictEqual(client.connectPromise, null);
      assert.deepStrictEqual(connectedIds, []);
    });
  }

  it("shares startup and registration retries across concurrent RPCs", async function () {
    let rpcCalls = 0;
    await start({
      ensureDaemon: async () => ensureCalls > 1,
      handleControlRpc() {
        rpcCalls++;
        return { port: 19783, host: "127.0.0.1" };
      },
    });
    const originalSend = MultiplexerControlTransport.prototype.send;
    let failedTransport;
    MultiplexerControlTransport.prototype.send = function (message) {
      if (message.kind === "register" && !failedTransport) {
        failedTransport = this;
        this.destroy(new Error("daemon closed during registration"));
        return false;
      }
      return originalSend.call(this, message);
    };
    const states = [];
    client.subscribeConnectionEvent((event) => states.push(event.state));
    try {
      const expected = { port: 19783, host: "127.0.0.1" };
      assert.deepStrictEqual(
        await Promise.all([
          client.call("startWSServer", {}),
          client.call("startWSServer", {}),
        ]),
        [expected, expected]
      );
      assert.strictEqual(ensureCalls, 3);
      assert.strictEqual(rpcCalls, 2);
      assert.strictEqual(failedTransport.closed, true);
      assert.strictEqual(client.status, "connected");
      assert.strictEqual(client.connectPromise, null);
      assert.strictEqual(client.pendingRpc.size, 0);
      assert.deepStrictEqual(states, ["connected"]);
    } finally {
      MultiplexerControlTransport.prototype.send = originalSend;
    }
  });

  it("ensures the daemon again after the control endpoint disappears", async function () {
    await start({
      async ensureDaemon() {
        if (ensureCalls === 2) await server.start();
        return true;
      },
    });
    await server.stop();
    assert.deepStrictEqual(await client.call("startWSServer", {}), {
      port: 19783,
      host: "127.0.0.1",
    });
    assert.strictEqual(ensureCalls, 2);
    assert.strictEqual(client.status, "connected");
  });

  it("closes a shutdown connection before retrying daemon startup", async function () {
    let shutdownTransport;
    await start({
      async ensureDaemon() {
        if (ensureCalls === 1) {
          await client.call("shutdownDaemon", { reason: "test" }, false);
          shutdownTransport = client.controlTransport;
          return false;
        }
        assert.strictEqual(shutdownTransport.closed, true);
        return true;
      },
    });
    assert.deepStrictEqual(await client.call("startWSServer", {}), {
      port: 19783,
      host: "127.0.0.1",
    });
    assert.strictEqual(ensureCalls, 2);
    assert.strictEqual(server.connections.size, 1);
  });

  it("does not ensure or register again after closing during the retry delay", async function () {
    await start();
    client.registerTransport = async () => {
      throw new Error("Test registration failure");
    };
    const pending = client.call("startWSServer", {});
    const rejection = assert.rejects(pending, /client closed/);
    await new Promise(setImmediate);
    await client.close();
    await rejection;
    assert.strictEqual(ensureCalls, 1);
    assert.strictEqual(client.status, "disconnected");
    assert.strictEqual(client.connectPromise, null);
    assert.strictEqual(client.controlTransport, null);
    assert.deepStrictEqual(connectedIds, []);
  });

  for (const startupFails of [false, true]) {
    it(`stays closed when pending daemon startup ${startupFails ? "fails" : "completes"}`, async function () {
      let finishStartup;
      const startup = new Promise((resolve, reject) => {
        finishStartup = startupFails ? () => reject(new Error("startup failed")) : resolve;
      });
      let rpcCalls = 0;
      await start({ ensureDaemon: () => startup, handleControlRpc: () => { rpcCalls++; return {}; } });
      const events = [];
      client.subscribeConnectionEvent((event) => events.push(event));
      const pending = client.call("startWSServer", {});
      const rejection = assert.rejects(pending, startupFails ? /startup failed/ : /client closed/);
      await client.close();
      finishStartup();
      await rejection;
      assert.strictEqual(client.status, "disconnected");
      assert.strictEqual(client.closed, true);
      assert.strictEqual(client.controlTransport, null);
      assert.strictEqual(client.connectPromise, null);
      assert.strictEqual(rpcCalls, 0);
      assert.deepStrictEqual(connectedIds, []);
      assert.deepStrictEqual(events, []);
      const reconnect = client.connect();
      assert.strictEqual(client.connectPromise, null);
      await assert.rejects(reconnect, /client closed/);
      await assert.rejects(client.call("startWSServer", {}), /client closed/);
      await assert.rejects(client.call("shutdownDaemon", {}, false), /client closed/);
      assert.strictEqual(ensureCalls, 1);
    });
  }

  it("closes the transport and prevents RPCs after a late register response", async function () {
    let rpcCalls = 0;
    await start({ handleControlRpc: () => { rpcCalls++; return {}; } });
    const originalSend = MultiplexerControlTransport.prototype.send;
    let receivedRegister;
    const registered = new Promise((resolve) => { receivedRegister = resolve; });
    let serverTransport;
    let registerResponse;
    MultiplexerControlTransport.prototype.send = function (message) {
      if (message.kind === "register-response") {
        serverTransport = this;
        registerResponse = message;
        receivedRegister();
        return true;
      }
      // Do not deliver a snapshot before the delayed register response.
      if (message.kind === "event") return true;
      return originalSend.call(this, message);
    };
    try {
      const pending = client.call("startWSServer", {});
      const rejection = assert.rejects(pending, /client closed/);
      await registered;
      const disconnected = new Promise((resolve) => serverTransport.onClose(resolve));
      const onMessage = client.controlTransport.messageListener;
      const closing = client.close();
      onMessage(registerResponse);
      await closing;
      await rejection;
      await disconnected;
      assert.strictEqual(client.status, "disconnected");
      assert.strictEqual(client.closed, true);
      assert.strictEqual(client.controlTransport, null);
      assert.strictEqual(server.connections.size, 0);
      assert.strictEqual(rpcCalls, 0);
    } finally {
      MultiplexerControlTransport.prototype.send = originalSend;
    }
  });

  it("rejects an invalid outgoing message immediately and keeps the connection usable", async function () {
    await start({ rpcTimeout: 10000 });
    await client.connect();
    const transport = client.controlTransport;
    const message = {};
    message.self = message;

    await assert.rejects(
      client.call("sendMessageWithoutReply", {
        target: "app",
        clientId: 1,
        message,
      }),
      /Failed to send multiplexer RPC sendMessageWithoutReply request/
    );
    assert.strictEqual(client.pendingRpc.size, 0);
    assert.strictEqual(transport.closed, false);
    assert.deepStrictEqual(await client.call("startWSServer", {}), {
      port: 19783,
      host: "127.0.0.1",
    });
    assert.strictEqual(client.controlTransport, transport);
  });

  it("rejects the failed send immediately and closes other pending RPCs", async function () {
    await start({
      rpcTimeout: 10000,
      handleControlRpc: () => new Promise(() => {}),
    });
    await client.connect();
    const first = client.call("startWSServer", {});
    const results = Promise.allSettled([first]);
    await new Promise((resolve) => setImmediate(resolve));
    const transport = client.controlTransport;
    const writeError = new Error("control socket write failed");
    transport.socket.write = () => {
      throw writeError;
    };
    const second = client.call("startWSServer", {});
    await assert.rejects(second, /Failed to send multiplexer RPC startWSServer request/);
    assert.strictEqual((await results)[0].reason, writeError);
    assert.strictEqual(client.pendingRpc.size, 0);
    assert.strictEqual(client.status, "disconnected");
    assert.strictEqual(transport.closed, true);
  });

  it("rejects after repeated registration failures and allows retry", async function () {
    await start();
    const originalSend = MultiplexerControlTransport.prototype.send;
    const writeError = new Error("register write failed");
    MultiplexerControlTransport.prototype.send = function (message) {
      if (message?.kind === "register") {
        this.socket.write = () => {
          throw writeError;
        };
      }
      return originalSend.call(this, message);
    };
    try {
      await assert.rejects(client.connect(), /after multiple attempts/);
      assert.strictEqual(ensureCalls, 3);
      assert.strictEqual(client.status, "disconnected");
      assert.strictEqual(client.connectPromise, null);
      assert.strictEqual(client.controlTransport, null);
    } finally {
      MultiplexerControlTransport.prototype.send = originalSend;
    }
    await client.connect();
    assert.strictEqual(client.status, "connected");
  });

  it("ensures, registers, receives the initial snapshot, and reuses the socket", async function () {
    await start();
    const events = [];
    client.subscribe((event) => events.push(event));
    await client.connect();
    await client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(ensureCalls, 1);
    assert.strictEqual(client.status, "connected");
    assert.deepStrictEqual(connectedIds, [1]);
    assert.strictEqual(events[0].event, "snapshot");
  });

  it("exposes the connection lifecycle through status", async function () {
    let resolveEnsure;
    const ensure = new Promise((resolve) => {
      resolveEnsure = resolve;
    });
    await start({ ensureDaemon: () => ensure });

    assert.strictEqual(client.status, "disconnected");
    const connecting = client.connect();
    assert.strictEqual(client.status, "connecting");

    resolveEnsure(true);
    await connecting;
    assert.strictEqual(client.status, "connected");

    await client.close();
    assert.strictEqual(client.status, "disconnected");
    assert.strictEqual(client.closed, true);
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
    assert.strictEqual(client.status, "disconnected");
  });

  it("uses direct Register/RPC for graceful shutdown without ensure", async function () {
    await start();
    await client.call("shutdownDaemon", { reason: "test" }, false);
    assert.strictEqual(ensureCalls, 0);
    assert.strictEqual(client.status, "connected");
  });

  it("reuses a connected client for direct daemon RPCs", async function () {
    await start();
    await client.connect();
    await client.call("shutdownDaemon", { reason: "test" }, false);
    assert.strictEqual(ensureCalls, 1);
    assert.deepStrictEqual(connectedIds, [1]);
    assert.strictEqual(client.status, "connected");
  });

  it("stops the daemon for debugging without respawning it", async function () {
    const { manager } = await start();

    await client.forceStopDaemon();

    assert.deepStrictEqual(manager.stopCalls, [false]);
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
    let rpcReceived;
    const received = new Promise((resolve) => {
      rpcReceived = resolve;
    });
    await start({
      handleControlRpc() {
        rpcReceived();
        return new Promise(() => {});
      },
      rpcTimeout: 1000,
    });
    const call = client.call("startWSServer", {});
    const rejection = assert.rejects(call, /socket/);
    await received;
    await server.stop();
    server = null;
    await rejection;
    assert.strictEqual(client.pendingRpc.size, 0);
    assert.strictEqual(ensureCalls, 1);
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

  for (const ensureDaemon of [true, false]) {
    it(`bounds silent Register attempts and clears the successful handshake timer (ensureDaemon=${ensureDaemon})`, async function () {
      this.timeout(7000);
      let replyToRegister = false;
      let registerCount = 0;
      const transports = new Set();
      const rawServer = net.createServer((socket) => {
        const transport = new MultiplexerControlTransport(socket);
        transports.add(transport);
        transport.onClose(() => transports.delete(transport));
        transport.onMessage((message) => {
          if (message.kind === "register") {
            registerCount++;
            if (replyToRegister) {
              transport.send({ kind: "register-response", ok: true });
            }
          } else if (message.kind === "rpc") {
            transport.send({
              kind: "rpc-response",
              id: message.id,
              ok: true,
              result: { port: 19783, host: "127.0.0.1" },
            });
          }
        });
      });
      await new Promise((resolve) => rawServer.listen(endpoint, resolve));
      client = new MultiplexerDaemonClient({
        daemonManager: {
          async ensureDaemon() {
            ensureCalls++;
            return true;
          },
          setDaemonClient() {},
        },
        controlEndpoint: endpoint,
      });

      try {
        const call = client.call("startWSServer", {}, ensureDaemon);
        const calls = ensureDaemon
          ? [call, client.call("startWSServer", {})]
          : [call];
        await Promise.all(
          calls.map((pending) =>
            assert.rejects(
              pending,
              /after multiple attempts/
            )
          )
        );
        const attempts = 3;
        assert.strictEqual(registerCount, attempts);
        assert.strictEqual(client.status, "disconnected");
        assert.strictEqual(client.connectPromise, null);
        assert.strictEqual(client.controlTransport, null);
        assert.strictEqual(client.pendingRpc.size, 0);

        replyToRegister = true;
        const expected = { port: 19783, host: "127.0.0.1" };
        assert.deepStrictEqual(
          await client.call("startWSServer", {}, ensureDaemon),
          expected
        );
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.strictEqual(client.status, "connected");
        assert.deepStrictEqual(
          await client.call("startWSServer", {}, ensureDaemon),
          expected
        );
        assert.strictEqual(registerCount, attempts + 1);
        assert.strictEqual(ensureCalls, ensureDaemon ? attempts + 1 : 0);
      } finally {
        await client.close();
        for (const transport of transports) {
          transport.destroy();
        }
        await new Promise((resolve) => rawServer.close(resolve));
      }
    });
  }

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
      async ensureDaemon() { return true; },
      setDaemonClient() {},
      async stopDaemonForDebugging(_withRespawn = false) {},
    };
    client = new MultiplexerDaemonClient({
      daemonManager: manager,
      controlEndpoint: endpoint,
    });
    await assert.rejects(() => client.connect(), /after multiple attempts/);
    assert.strictEqual(client.status, "disconnected");
    await new Promise((resolve) => rawServer.close(resolve));
  });

  it("emits connection events only after Register succeeds", async function () {
    await start();
    const states = [];
    client.subscribeConnectionEvent((event) => states.push(event.state));
    await client.connect();
    await client.close();
    assert.deepStrictEqual(states, ["connected", "disconnected"]);
  });

  it("keeps only the latest host and connection event listeners", async function () {
    await start();
    const firstEvents = [];
    const secondEvents = [];
    const firstStates = [];
    const secondStates = [];
    client.subscribe((event) => firstEvents.push(event));
    client.subscribe((event) => secondEvents.push(event));
    client.subscribeConnectionEvent((event) => firstStates.push(event.state));
    client.subscribeConnectionEvent((event) => secondStates.push(event.state));

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
