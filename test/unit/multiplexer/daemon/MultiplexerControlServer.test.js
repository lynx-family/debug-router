// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const {
  MultiplexerControlServer,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/MultiplexerControlServer");
const {
  MultiplexerControlTransport,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/transport/MultiplexerControlTransport");

function waitForMessage(transport) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 500);
    const unsubscribe = transport.onMessage((message) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(message);
    });
  });
}

async function connectTransport(endpoint) {
  const transport = new MultiplexerControlTransport(
    net.createConnection(endpoint)
  );
  await new Promise((resolve, reject) => {
    transport.onConnect(resolve);
    transport.onClose((error) =>
      reject(error ?? new Error("Control transport closed before connect"))
    );
  });
  return transport;
}

async function waitForProvisionalTransportsToBeRemoved(server) {
  const deadline = Date.now() + 500;
  while (server.provisionalTransports.size !== 0) {
    if (Date.now() >= deadline) {
      throw new Error("provisional control transport cleanup timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("MultiplexerControlServer", function () {
  let tempDir;
  let endpoint;
  let server;
  let connected;
  let disconnected;
  let rpcCalls;
  let daemonInUse;
  let host;

  beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-server-"));
    endpoint = path.join(tempDir, "control.sock");
    connected = [];
    disconnected = [];
    rpcCalls = [];
    daemonInUse = false;
    host = {
      isInUse() {
        return daemonInUse;
      },
      handleControlConnected(id) {
        connected.push(id);
      },
      handleControlDisconnected(id) {
        disconnected.push(id);
      },
      handleControlRpc(id, message) {
        rpcCalls.push([id, message]);
        if (message.method === "startWSServer") {
          return { port: 19783, host: "127.0.0.1" };
        }
        return undefined;
      },
    };
    server = new MultiplexerControlServer({
      controlEndpoint: endpoint,
      protocolVersion: 2,
      debugInfo: { daemonVersion: "test" },
      now: () => 1234,
      host,
    });
  });

  afterEach(async function () {
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves Health without PID and without registering a control", async function () {
    await server.start();
    const transport = await connectTransport(endpoint);
    const responsePromise = waitForMessage(transport);
    transport.send({ kind: "health" });
    const response = await responsePromise;
    assert.deepStrictEqual(response, {
      kind: "health-response",
      ok: true,
      protocolVersion: 2,
      isInUse: false,
      debugInfo: {
        daemonVersion: "test",
        protocolVersion: 2,
        processId: process.pid,
        timestamp: 1234,
      },
    });
    assert.strictEqual(Object.hasOwn(response, "pid"), false);
    assert.deepStrictEqual(connected, []);
    assert.strictEqual(server.connections.size, 0);
  });

  it("returns a handshake error for an invalid Health request", async function () {
    await server.start();
    const transport = await connectTransport(endpoint);
    const responsePromise = waitForMessage(transport);
    const closed = new Promise((resolve) => transport.onClose(resolve));
    transport.send({ kind: "health", debugInfo: "invalid" });
    assert.deepStrictEqual(await responsePromise, {
      kind: "handshake-error-response",
      error: {
        code: "invalid-control-handshake",
        message:
          "First control message must be a valid health or register request",
      },
    });
    await closed;
    await waitForProvisionalTransportsToBeRemoved(server);
    assert.deepStrictEqual(connected, []);
    assert.strictEqual(server.connections.size, 0);
    assert.strictEqual(server.provisionalTransports.size, 0);
  });

  it("reports whether the daemon has an active consumer", async function () {
    daemonInUse = true;
    await server.start();
    const transport = await connectTransport(endpoint);
    const responsePromise = waitForMessage(transport);
    transport.send({ kind: "health" });

    assert.strictEqual((await responsePromise).isInUse, true);
    assert.deepStrictEqual(connected, []);
    assert.strictEqual(server.connections.size, 0);
  });

  it("registers only after Register and unregisters on close", async function () {
    await server.start();
    const transport = await connectTransport(endpoint);
    const responsePromise = waitForMessage(transport);
    transport.send({ kind: "register" });
    assert.deepStrictEqual(await responsePromise, {
      kind: "register-response",
      ok: true,
    });
    assert.deepStrictEqual(connected, [1]);
    assert.strictEqual(server.connections.size, 1);
    transport.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepStrictEqual(disconnected, [1]);
  });

  it("does not register when sending Register response fails", async function () {
    const originalSend = MultiplexerControlTransport.prototype.send;
    const originalRegisterConnection = server.registerConnection;
    let registerCalls = 0;
    let resolveRegisterResponseSend;
    const registerResponseSendAttempted = new Promise((resolve) => {
      resolveRegisterResponseSend = resolve;
    });
    MultiplexerControlTransport.prototype.send = function (message) {
      if (message?.kind === "register-response") {
        resolveRegisterResponseSend();
        throw new Error("register response send failed");
      }
      return originalSend.call(this, message);
    };
    server.registerConnection = function (transport) {
      registerCalls += 1;
      return originalRegisterConnection.call(this, transport);
    };

    try {
      await server.start();
      const transport = await connectTransport(endpoint);
      const closed = new Promise((resolve) => transport.onClose(resolve));
      transport.send({ kind: "register" });
      await registerResponseSendAttempted;
      await closed;
      await waitForProvisionalTransportsToBeRemoved(server);

      assert.strictEqual(registerCalls, 0);
      assert.deepStrictEqual(connected, []);
      assert.deepStrictEqual(disconnected, []);
      assert.strictEqual(server.connections.size, 0);
      assert.strictEqual(server.provisionalTransports.size, 0);
    } finally {
      MultiplexerControlTransport.prototype.send = originalSend;
      server.registerConnection = originalRegisterConnection;
    }
  });

  it("dispatches framed RPCs and preserves explicit results", async function () {
    await server.start();
    const transport = await connectTransport(endpoint);
    let responsePromise = waitForMessage(transport);
    transport.send({ kind: "register" });
    await responsePromise;

    responsePromise = waitForMessage(transport);
    const request = {
      kind: "rpc",
      id: 9,
      method: "startWSServer",
      params: {},
    };
    transport.send(request);
    const response = await responsePromise;
    assert.deepStrictEqual(rpcCalls, [[1, request]]);
    assert.deepStrictEqual(response.result, {
      port: 19783,
      host: "127.0.0.1",
    });
  });

  it("closes a connection whose first message is not Health/Register", async function () {
    await server.start();
    const transport = await connectTransport(endpoint);
    const closed = new Promise((resolve) => transport.onClose(resolve));
    transport.send({ kind: "rpc", id: 1, method: "startWSServer", params: {} });
    await closed;
    await waitForProvisionalTransportsToBeRemoved(server);
    assert.deepStrictEqual(connected, []);
    assert.strictEqual(server.provisionalTransports.size, 0);
  });

  it("returns a handshake timeout error when no first message is received", async function () {
    server = new MultiplexerControlServer({
      controlEndpoint: endpoint,
      protocolVersion: 2,
      handshakeTimeoutMs: 20,
      host,
    });
    await server.start();
    const transport = await connectTransport(endpoint);
    const responsePromise = waitForMessage(transport);
    const closed = new Promise((resolve) => transport.onClose(resolve));

    assert.deepStrictEqual(await responsePromise, {
      kind: "handshake-error-response",
      error: {
        code: "control-handshake-timeout",
        message: "Timed out waiting for the first control message",
      },
    });
    await closed;
    await waitForProvisionalTransportsToBeRemoved(server);
    assert.deepStrictEqual(connected, []);
    assert.strictEqual(server.connections.size, 0);
    assert.strictEqual(server.provisionalTransports.size, 0);
  });

  it("cancels the handshake timeout after receiving Register", async function () {
    server = new MultiplexerControlServer({
      controlEndpoint: endpoint,
      protocolVersion: 2,
      handshakeTimeoutMs: 20,
      host,
    });
    await server.start();
    const transport = await connectTransport(endpoint);
    const responsePromise = waitForMessage(transport);
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });

    transport.send({ kind: "register" });
    assert.deepStrictEqual(await responsePromise, {
      kind: "register-response",
      ok: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.strictEqual(closed, false);
    assert.strictEqual(server.connections.size, 1);
    transport.destroy();
  });

  it("is idempotent and removes the Unix socket on stop", async function () {
    await server.start();
    await server.start();
    if (process.platform !== "win32") {
      assert.strictEqual(fs.existsSync(endpoint), true);
    }
    await server.stop();
    await server.stop();
    if (process.platform !== "win32") {
      assert.strictEqual(fs.existsSync(endpoint), false);
    }
  });
});
