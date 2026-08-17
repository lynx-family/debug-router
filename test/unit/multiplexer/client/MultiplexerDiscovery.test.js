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
  isInUse: false,
};

const {
  MultiplexerDiscovery,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/client/MultiplexerDiscovery");
const {
  MULTIPLEXER_PROTOCOL_VERSION,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/protocol");

const FRAME_PREFIX = Buffer.from("$MUX", "ascii");
const FRAME_HEADER_SIZE = FRAME_PREFIX.length + 4;

function createTempContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-router-health-"));
  return { dir, endpoint: path.join(dir, "control.sock") };
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(FRAME_HEADER_SIZE + payload.length);
  FRAME_PREFIX.copy(result, 0);
  result.writeUInt32BE(payload.length, FRAME_PREFIX.length);
  payload.copy(result, FRAME_HEADER_SIZE);
  return result;
}

function receiveFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < FRAME_HEADER_SIZE) return;

      assert.deepStrictEqual(
        buffer.subarray(0, FRAME_PREFIX.length),
        FRAME_PREFIX
      );
      const payloadLength = buffer.readUInt32BE(FRAME_PREFIX.length);
      if (buffer.length < FRAME_HEADER_SIZE + payloadLength) return;

      socket.off("data", onData);
      try {
        resolve(
          JSON.parse(
            buffer
              .subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + payloadLength)
              .toString()
          )
        );
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
                isInUse: option.isInUse ?? false,
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

  it("[v1 compatibility gate] recognizes a frozen v1 daemon health contract", async function () {
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

  it("[v1 compatibility gate] lets a v1 connector reuse a newer daemon", async function () {
    const context = await startServer({
      expectedRequest: v1HealthRequest,
      protocolVersion: 2,
    });
    const result = await new MultiplexerDiscovery({
      controlEndpoint: context.endpoint,
      localProtocolVersion: 1,
    }).probeHealth();
    assert.strictEqual(result.status, "usable");
    assert.strictEqual(result.reason, "daemon-newer-compatible");
    assert.deepStrictEqual(context.requests, [v1HealthRequest]);
  });

  it("requires replacement for an older daemon", async function () {
    const context = await startServer({
      protocolVersion: 0,
    });
    const result = await new MultiplexerDiscovery({
      controlEndpoint: context.endpoint,
      localProtocolVersion: 1,
    }).probeHealth();
    assert.strictEqual(result.status, "replace-required");
  });

  it("rejects replacement when an older daemon is in use", async function () {
    const context = await startServer({
      protocolVersion: 0,
      isInUse: true,
    });
    const result = await new MultiplexerDiscovery({
      controlEndpoint: context.endpoint,
      localProtocolVersion: 1,
    }).probeHealth();
    assert.deepStrictEqual(result, {
      status: "unusable",
      reason: "daemon-upgrade-blocked-by-active-connections",
      daemonProtocolVersion: 0,
      connectorProtocolVersion: 1,
    });
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
        const bad = Buffer.alloc(FRAME_HEADER_SIZE + 1);
        FRAME_PREFIX.copy(bad, 0);
        bad.writeUInt32BE(2, FRAME_PREFIX.length);
        bad[FRAME_HEADER_SIZE] = "{".charCodeAt(0);
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
