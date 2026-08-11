// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { isDeepStrictEqual } = require("util");

const v1HealthRequest = { kind: "health" };
const v1HealthResponse = {
  kind: "health-response",
  ok: true,
  protocolVersion: 1,
  minSupportedProtocolVersion: 1,
};

const {
  MultiplexerDiscovery,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/client/MultiplexerDiscovery");
const {
  MULTIPLEXER_PROTOCOL_VERSION,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/protocol");

function createTempContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-health-"));
  return { dir, endpoint: path.join(dir, "control.sock") };
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(4 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

function receiveFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;

      const payloadLength = buffer.readUInt32BE(0);
      if (buffer.length < 4 + payloadLength) return;

      socket.off("data", onData);
      try {
        resolve(JSON.parse(buffer.subarray(4, 4 + payloadLength).toString()));
      } catch (error) {
        reject(error);
      }
    };
    socket.on("data", onData);
  });
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

describe("MultiplexerDiscovery", function () {
  const contexts = [];
  const servers = [];

  function trackServer(server, sockets = new Set()) {
    const tracked = {
      async stop() {
        for (const socket of sockets) socket.destroy();
        if (server.listening) {
          await new Promise((resolve) => server.close(resolve));
        }
      },
    };
    servers.push(tracked);
    return tracked;
  }

  afterEach(async function () {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    for (const context of contexts.splice(0)) {
      fs.rmSync(context.dir, { recursive: true, force: true });
    }
  });

  async function startServer(option = {}) {
    const context = createTempContext();
    contexts.push(context);
    const sockets = new Set();
    const requests = [];
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      void receiveFrame(socket).then(
        (request) => {
          requests.push(request);
          if (
            option.expectedRequest &&
            !isDeepStrictEqual(request, option.expectedRequest)
          ) {
            socket.end(
              frame({
                kind: "handshake-error-response",
                error: {
                  code: "unsupported-health-request",
                  message: "unsupported v1 health request",
                },
              })
            );
            return;
          }
          socket.end(
            frame(
              option.response ?? {
                kind: "health-response",
                ok: true,
                protocolVersion: option.protocolVersion ?? 1,
                minSupportedProtocolVersion:
                  option.minSupportedProtocolVersion ?? 1,
              }
            )
          );
        },
        () => socket.destroy()
      );
    });
    trackServer(server, sockets);
    await listen(server, context.endpoint);
    return { ...context, requests };
  }

  it("talks to a frozen v1 daemon using the v1 health contract", async function () {
    const context = await startServer({
      expectedRequest: v1HealthRequest,
      response: v1HealthResponse,
    });
    const discovery = new MultiplexerDiscovery({
      controlEndpoint: context.endpoint,
      localProtocolVersion: MULTIPLEXER_PROTOCOL_VERSION,
    });

    const result = await discovery.probeHealth();
    assert.strictEqual(
      result.status,
      MULTIPLEXER_PROTOCOL_VERSION === 1 ? "usable" : "replace-required"
    );
    assert.strictEqual(
      result.reason,
      MULTIPLEXER_PROTOCOL_VERSION === 1
        ? "same-version"
        : "daemon-older-than-connector"
    );
    assert.strictEqual(result.daemonProtocolVersion, 1);
    assert.deepStrictEqual(context.requests, [v1HealthRequest]);
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
    const context = await startServer({
      protocolVersion: 0,
      minSupportedProtocolVersion: 0,
    });
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
    trackServer(rawServer, rawSockets);
    await listen(rawServer, context.endpoint);
    const timeout = await new MultiplexerDiscovery({
      controlEndpoint: context.endpoint,
      localProtocolVersion: 1,
      healthCheckTimeout: 20,
    }).probeHealth();
    assert.strictEqual(timeout.reason, "timeout");
  });

  it("reports invalid response and invalid frames", async function () {
    const invalidResponseContext = createTempContext();
    contexts.push(invalidResponseContext);
    const invalidResponseServer = net.createServer((socket) => {
      socket.once("data", () => socket.end(frame({ kind: "unexpected" })));
    });
    trackServer(invalidResponseServer);
    await listen(invalidResponseServer, invalidResponseContext.endpoint);
    const invalidResponse = await new MultiplexerDiscovery({
      controlEndpoint: invalidResponseContext.endpoint,
      localProtocolVersion: 1,
    }).probeHealth();
    assert.strictEqual(invalidResponse.reason, "invalid-response");

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
    trackServer(invalidFrameServer);
    await listen(invalidFrameServer, invalidFrameContext.endpoint);
    const invalidFrame = await new MultiplexerDiscovery({
      controlEndpoint: invalidFrameContext.endpoint,
      localProtocolVersion: 1,
    }).probeHealth();
    assert.strictEqual(invalidFrame.reason, "invalid-frame");
  });
});
