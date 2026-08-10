// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const {
  MultiplexerDiscovery,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/client/MultiplexerDiscovery");
const {
  MultiplexerControlServer,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/daemon/MultiplexerControlServer");

function createTempContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-health-"));
  return { dir, endpoint: path.join(dir, "control.sock") };
}

function createHost() {
  return { handleControlRpc() {} };
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(4 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

describe("MultiplexerDiscovery", function () {
  const contexts = [];
  const servers = [];

  afterEach(async function () {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    for (const context of contexts.splice(0)) {
      fs.rmSync(context.dir, { recursive: true, force: true });
    }
  });

  async function startServer(option = {}) {
    const context = createTempContext();
    contexts.push(context);
    const server = new MultiplexerControlServer({
      host: createHost(),
      controlEndpoint: context.endpoint,
      protocolVersion: 1,
      minSupportedProtocolVersion: 1,
      ...option,
    });
    servers.push(server);
    await server.start();
    return context;
  }

  it("returns usable for the same version", async function () {
    const context = await startServer({
      protocolVersion: 1,
      minSupportedProtocolVersion: 1,
    });
    const discovery = new MultiplexerDiscovery({
      controlEndpoint: context.endpoint,
      localProtocolVersion: 1,
    });

    const result = await discovery.probeHealth();
    assert.strictEqual(result.status, "usable");
    assert.strictEqual(result.reason, "same-version");
  });

  it("accepts a newer compatible daemon", async function () {
    const context = await startServer({
      protocolVersion: 2,
      minSupportedProtocolVersion: 1,
    });
    const result = await new MultiplexerDiscovery({
      controlEndpoint: context.endpoint,
      localProtocolVersion: 1,
    }).probeHealth();
    assert.strictEqual(result.status, "usable");
    assert.strictEqual(result.reason, "daemon-newer-compatible");
  });

  it("requires replacement for an older daemon", async function () {
    const context = await startServer({ protocolVersion: 0 });
    const result = await new MultiplexerDiscovery({
      controlEndpoint: context.endpoint,
      localProtocolVersion: 1,
    }).probeHealth();
    assert.strictEqual(result.status, "replace-required");
  });

  it("rejects a connector below the daemon minimum", async function () {
    const context = await startServer({
      protocolVersion: 2,
      minSupportedProtocolVersion: 2,
    });
    const result = await new MultiplexerDiscovery({
      controlEndpoint: context.endpoint,
      localProtocolVersion: 1,
    }).probeHealth();
    assert.strictEqual(result.status, "unusable");
    assert.strictEqual(result.reason, "connector-protocol-too-old");
  });

  it("reports unreachable and timeout endpoints", async function () {
    const context = createTempContext();
    contexts.push(context);
    const unreachable = await new MultiplexerDiscovery({
      controlEndpoint: context.endpoint,
      localProtocolVersion: 1,
      healthCheckTimeout: 20,
    }).probeHealth();
    assert.strictEqual(unreachable.reason, "unreachable");

    const rawSockets = new Set();
    const rawServer = net.createServer((socket) => {
      rawSockets.add(socket);
      socket.on("close", () => rawSockets.delete(socket));
    });
    await new Promise((resolve) => rawServer.listen(context.endpoint, resolve));
    const timeout = await new MultiplexerDiscovery({
      controlEndpoint: context.endpoint,
      localProtocolVersion: 1,
      healthCheckTimeout: 20,
    }).probeHealth();
    assert.strictEqual(timeout.reason, "timeout");
    for (const socket of rawSockets) socket.destroy();
    await new Promise((resolve) => rawServer.close(resolve));
  });

  it("reports invalid response and invalid frames", async function () {
    const invalidResponseContext = createTempContext();
    contexts.push(invalidResponseContext);
    const invalidResponseServer = net.createServer((socket) => {
      socket.once("data", () => socket.end(frame({ kind: "unexpected" })));
    });
    await new Promise((resolve) =>
      invalidResponseServer.listen(invalidResponseContext.endpoint, resolve)
    );
    const invalidResponse = await new MultiplexerDiscovery({
      controlEndpoint: invalidResponseContext.endpoint,
      localProtocolVersion: 1,
    }).probeHealth();
    assert.strictEqual(invalidResponse.reason, "invalid-response");
    await new Promise((resolve) => invalidResponseServer.close(resolve));

    const invalidFrameContext = createTempContext();
    contexts.push(invalidFrameContext);
    const invalidFrameServer = net.createServer((socket) => {
      socket.once("data", () => {
        const bad = Buffer.alloc(5);
        bad.writeUInt32BE(2, 0);
        bad[4] = "{".charCodeAt(0);
        socket.end(bad);
      });
    });
    await new Promise((resolve) =>
      invalidFrameServer.listen(invalidFrameContext.endpoint, resolve)
    );
    const invalidFrame = await new MultiplexerDiscovery({
      controlEndpoint: invalidFrameContext.endpoint,
      localProtocolVersion: 1,
    }).probeHealth();
    assert.strictEqual(invalidFrame.reason, "invalid-frame");
    await new Promise((resolve) => invalidFrameServer.close(resolve));
  });
});
