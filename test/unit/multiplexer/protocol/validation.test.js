// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

const {
  isClientSnapshot,
  isMultiplexerDebugInfo,
  isControlEvent,
  isControlRpcMethod,
  isControlRpcRequest,
  isControlRpcResponse,
  isDeviceSnapshot,
  isMultiplexerHealthRequest,
  isMultiplexerHealthResponse,
  isMultiplexerHandshakeErrorResponse,
  isMultiplexerRegisterRequest,
  isMultiplexerRegisterResponse,
  isNumberArray,
  isSnapshot,
  isStringArray,
  isWebSocketClientSnapshot,
  parseJsonObject,
  parseJsonValue,
} = require("../../../../debug_router_connector/dist/cjs/src/multiplexer/protocol/validation");

function createDeviceSnapshot() {
  return {
    os: "Android",
    title: "Pixel",
    serial: "device-1",
    ports: [8080],
    host: "127.0.0.1",
  };
}

function createClientSnapshot() {
  return {
    port: 9000,
    id: 1,
    query: {
      app: "demo",
      os: "Android",
      device: "Pixel",
      device_model: "Pixel",
      device_id: "device-1",
      sdk_version: "1.0.0",
      raw_info: {
        extra: true,
      },
    },
  };
}

function createSnapshot() {
  return {
    protocolVersion: 1,
    generatedAt: 1000,
    devices: [createDeviceSnapshot()],
    clients: [createClientSnapshot()],
    debugInfo: {
      protocolVersion: 1,
      daemonVersion: "0.0.1",
      processId: 100,
      timestamp: 1000,
    },
    extraFutureField: true,
  };
}

function createWebSocketClientSnapshot() {
  return {
    id: 10,
    app: "demo",
    debugRouterVersion: "1.0.0",
    deviceModel: "Pixel",
    network: "WiFi",
    osVersion: "14",
    sdkVersion: "1.0.0",
    type: "CDP",
    raw_info: {
      source: "ws",
    },
  };
}

function createRpcRequest(method, params, extra = {}) {
  return {
    kind: "rpc",
    id: 1,
    method,
    params,
    ...extra,
  };
}

function createRpcResponse(result, method, extra = {}) {
  return [
    {
      kind: "rpc-response",
      id: 1,
      ok: true,
      result,
      ...extra,
    },
    method,
  ];
}

function createRegisterResponse() {
  return {
    event: "Register",
    data: {
      id: 1,
      info: {
        app: "demo",
        appVersion: "1.0.0",
        deviceModel: "Pixel",
        network: "WiFi",
        osVersion: "14",
        sdkVersion: "1.0.0",
      },
    },
  };
}

function createCustomizedRequestMessage() {
  return {
    event: "Customized",
    data: {
      type: "CDP",
      data: {
        client_id: 1,
        session_id: 2,
        message: {
          id: 1,
        },
      },
      sender: 0,
    },
  };
}

function createEvent(event, data, extra = {}) {
  return {
    kind: "event",
    event,
    data,
    ...extra,
  };
}

describe("multiplexer protocol validation", function () {
  it("parses JSON values and rejects bad object inputs", function () {
    assert.deepStrictEqual(parseJsonValue('{"ok":true}'), { ok: true });
    assert.deepStrictEqual(parseJsonValue("[1,2]"), [1, 2]);
    assert.strictEqual(parseJsonValue("{bad"), null);
    assert.deepStrictEqual(parseJsonObject('{"ok":true}'), { ok: true });
    assert.strictEqual(parseJsonObject("[1,2]"), null);
    assert.strictEqual(parseJsonObject("null"), null);
  });

  it("validates primitive helper branches", function () {
    assert.strictEqual(isStringArray(["a", "b"]), true);
    assert.strictEqual(isStringArray(["a", 1]), false);
    assert.strictEqual(isNumberArray([1, 2]), true);
    assert.strictEqual(isNumberArray([1, Number.NaN]), false);
    assert.strictEqual(isControlRpcMethod("connectDevices"), true);
    assert.strictEqual(isControlRpcMethod("unknown"), false);
  });

  it("validates debugInfo optional fields and rejects invalid typed fields", function () {
    assert.strictEqual(
      isMultiplexerDebugInfo({
        protocolVersion: 1,
        clientVersion: "0.0.1",
        daemonVersion: "0.0.1",
        processId: 100,
        timestamp: 1000,
        unknownFutureField: true,
      }),
      true
    );
    assert.strictEqual(isMultiplexerDebugInfo(null), false);
    assert.strictEqual(
      isMultiplexerDebugInfo({
        protocolVersion: "1",
      }),
      false
    );
    assert.strictEqual(
      isMultiplexerDebugInfo({
        processId: "100",
      }),
      false
    );
    assert.strictEqual(
      isMultiplexerDebugInfo({
        timestamp: "1000",
      }),
      false
    );
  });

  it("validates snapshot DTOs and permits unknown fields", function () {
    assert.strictEqual(isSnapshot(createSnapshot()), true);
    assert.strictEqual(
      isSnapshot({
        ...createSnapshot(),
        websocketAppClients: [createWebSocketClientSnapshot()],
        websocketWebClients: [
          { ...createWebSocketClientSnapshot(), id: 11, type: "Driver" },
        ],
        futureField: [{ nested: true }],
      }),
      true
    );
    assert.strictEqual(isDeviceSnapshot(createDeviceSnapshot()), true);
    assert.strictEqual(isClientSnapshot(createClientSnapshot()), true);
    assert.strictEqual(
      isWebSocketClientSnapshot(createWebSocketClientSnapshot()),
      true
    );
    assert.strictEqual(
      isWebSocketClientSnapshot({
        ...createWebSocketClientSnapshot(),
        network: "USB",
      }),
      false
    );
    assert.strictEqual(
      isWebSocketClientSnapshot({
        ...createWebSocketClientSnapshot(),
        raw_info: undefined,
      }),
      true
    );

    const invalidSnapshot = createSnapshot();
    delete invalidSnapshot.devices;
    assert.strictEqual(isSnapshot(invalidSnapshot), false);

    assert.strictEqual(
      isSnapshot({
        ...createSnapshot(),
        devices: [{ ...createDeviceSnapshot(), ports: ["8080"] }],
      }),
      false
    );
    assert.strictEqual(
      isSnapshot({
        ...createSnapshot(),
        clients: [{ ...createClientSnapshot(), query: null }],
      }),
      false
    );
    assert.strictEqual(
      isSnapshot({
        ...createSnapshot(),
        websocketAppClients: [
          { ...createWebSocketClientSnapshot(), network: "USB" },
        ],
      }),
      false
    );
    // connectionTrace is no longer a snapshot field. It is ignored here like
    // any other forward-compatible unknown field and validated on RPC/events.
    assert.strictEqual(
      isSnapshot({
        ...createSnapshot(),
        connectionTrace: [
          {
            sequence: "1",
            event: "client_watch_started",
            timestamp: "2026-07-15T00:00:00.000Z",
            traceSchemaVersion: "0.1",
          },
        ],
      }),
      true
    );
    assert.strictEqual(isDeviceSnapshot(null), false);
    assert.strictEqual(
      isClientSnapshot({
        ...createClientSnapshot(),
        query: {
          ...createClientSnapshot().query,
          sdk_version: 1,
        },
      }),
      false
    );
  });

  it("validates Health and Register DTOs without PID or versioned requests", function () {
    assert.strictEqual(
      isMultiplexerHealthRequest({
        kind: "health",
      }),
      true
    );
    assert.strictEqual(
      isMultiplexerHealthRequest({
        kind: "health",
        debugInfo: {
          daemonVersion: "0.0.1",
          processId: 123,
          timestamp: 1000,
        },
        extraFutureField: "ignored",
      }),
      true
    );
    assert.strictEqual(
      isMultiplexerHealthRequest({ kind: "health", debugInfo: "bad" }),
      false
    );
    assert.strictEqual(
      isMultiplexerHealthResponse({
        kind: "health-response",
        ok: true,
        protocolVersion: 1,
        isInUse: false,
        debugInfo: {
          daemonVersion: "0.0.1",
          processId: 123,
          timestamp: 1000,
        },
      }),
      true
    );
    assert.strictEqual(
      isMultiplexerHealthResponse({
        kind: "health-response",
        ok: true,
        protocolVersion: 1,
        isInUse: false,
      }),
      true
    );
    assert.strictEqual(
      isMultiplexerHealthResponse({
        kind: "health-response",
        ok: false,
        protocolVersion: 1,
        isInUse: false,
      }),
      false
    );
    assert.strictEqual(
      isMultiplexerHealthResponse({
        kind: "health-response",
        ok: true,
        protocolVersion: 1,
        isInUse: "false",
      }),
      false
    );
    assert.strictEqual(
      isMultiplexerRegisterRequest({ kind: "register" }),
      true
    );
    assert.strictEqual(
      isMultiplexerRegisterResponse({ kind: "register-response", ok: true }),
      true
    );
    assert.strictEqual(
      isMultiplexerRegisterResponse({
        kind: "register-response",
        ok: false,
        error: { code: "bad", message: "bad register" },
      }),
      false
    );
    assert.strictEqual(
      isMultiplexerHandshakeErrorResponse({
        kind: "handshake-error-response",
        error: { code: "bad", message: "bad handshake" },
      }),
      true
    );
    assert.strictEqual(
      isMultiplexerHandshakeErrorResponse({
        kind: "handshake-error-response",
      }),
      false
    );
  });

  it("validates every control RPC request method branch", function () {
    const validCases = [
      [
        "connectDevices",
        { timeout: 1000, serial: null, isAutoListenClients: true },
      ],
      ["connectDevices", { serial: "device-1" }],
      [
        "connectUsbClients",
        {
          deviceId: "device-1",
          timeout: 1000,
          waitTimeout: true,
          clientName: null,
        },
      ],
      ["connectUsbClients", { deviceId: "device-1", clientName: "demo" }],
      ["startDeviceClientWatcher", { deviceId: "device-1" }],
      ["stopDeviceClientWatcher", { deviceId: "device-1" }],
      ["disconnectDevice", { deviceId: "device-1" }],
      ["shutdownDaemon", {}],
      ["shutdownDaemon", { reason: "daemon-protocol-older-than-connector" }],
      ["startWSServer", {}],
      ["startAllDeviceClientWatchers", {}],
      ["stopAllDeviceClientWatchers", {}],
      [
        "sendMessageWithReply",
        {
          clientId: 1,
          message: {
            event: "Initialize",
            data: 1,
          },
        },
      ],
      [
        "sendMessageWithReply",
        {
          clientId: 1,
          message: createCustomizedRequestMessage(),
        },
      ],
      [
        "sendMessageWithoutReply",
        { target: "app", clientId: 1, message: null },
      ],
      [
        "sendMessageWithoutReply",
        { target: "app", clientId: 1, message: undefined },
      ],
      [
        "sendMessageWithoutReply",
        { target: "web", clientId: -1, message: "broadcast" },
      ],
      [
        "sendMessageWithoutReply",
        { target: "web", clientId: 2, message: "targeted" },
      ],
      [
        "sendMessageWithoutReply",
        { target: "web", clientId: -1, message: { event: "broadcast" } },
      ],
      ["closeClient", { clientId: 1 }],
    ];

    for (const [method, params] of validCases) {
      assert.strictEqual(
        isControlRpcRequest(
          createRpcRequest(method, params, {
            debugInfo: {
              protocolVersion: 1,
              processId: 100,
              timestamp: 1000,
            },
          })
        ),
        true,
        method
      );
    }
  });

  it("rejects invalid control RPC request base fields and params branches", function () {
    const invalidCases = [
      { kind: "event", id: 1, method: "connectDevices", params: {} },
      { kind: "rpc", id: "1", method: "connectDevices", params: {} },
      createRpcRequest("unknown", {}),
      createRpcRequest("connectDevices", null),
      createRpcRequest("connectDevices", { timeout: "1000" }),
      createRpcRequest("connectDevices", { serial: 1 }),
      createRpcRequest("connectDevices", { isAutoListenClients: "true" }),
      createRpcRequest("connectUsbClients", {}),
      createRpcRequest("connectUsbClients", { deviceId: 1 }),
      createRpcRequest("connectUsbClients", {
        deviceId: "device-1",
        waitTimeout: "true",
      }),
      createRpcRequest("connectUsbClients", {
        deviceId: "device-1",
        clientName: 1,
      }),
      createRpcRequest("setClientWatch", {
        action: "start",
        deviceId: "device-1",
      }),
      createRpcRequest("startDeviceClientWatcher", {}),
      createRpcRequest("startDeviceClientWatcher", { deviceId: 1 }),
      createRpcRequest("startDeviceClientWatcher", { deviceId: "" }),
      createRpcRequest("startDeviceClientWatcher", {
        deviceId: "device-1",
        action: "start",
      }),
      createRpcRequest("stopDeviceClientWatcher", {}),
      createRpcRequest("stopDeviceClientWatcher", { deviceId: 1 }),
      createRpcRequest("stopDeviceClientWatcher", { deviceId: "" }),
      createRpcRequest("stopDeviceClientWatcher", {
        deviceId: "device-1",
        action: "stop",
      }),
      createRpcRequest("startAllDeviceClientWatchers", { force: true }),
      createRpcRequest("startAllDeviceClientWatchers", { force: "true" }),
      createRpcRequest("stopAllDeviceClientWatchers", { force: false }),
      createRpcRequest("disconnectDevice", {}),
      createRpcRequest("disconnectDevice", { deviceId: 1 }),
      createRpcRequest("shutdownDaemon", { reason: 1 }),
      createRpcRequest("startWSServer", { unexpected: true }),
      createRpcRequest("sendMessageToWeb", { message: "hello" }),
      createRpcRequest("sendMessageToApp", {
        id: 1,
        message: "hello",
      }),
      createRpcRequest("sendCustomizedMessage", {
        clientId: 1,
        method: "Runtime.evaluate",
      }),
      createRpcRequest("sendMessageWithReply", { clientId: "1", message: {} }),
      createRpcRequest("sendMessageWithReply", {
        clientId: 1,
        message: { event: "Initialize", data: "1" },
      }),
      createRpcRequest("sendMessageWithReply", {
        clientId: 1,
        message: { event: "Customized", data: null },
      }),
      createRpcRequest("sendMessageWithReply", {
        clientId: 1,
        message: {
          ...createCustomizedRequestMessage(),
          data: {
            ...createCustomizedRequestMessage().data,
            sender: "0",
          },
        },
      }),
      createRpcRequest("sendMessageWithoutReply", { message: "hello" }),
      createRpcRequest("sendMessageWithoutReply", {
        target: "app",
        message: "hello",
      }),
      createRpcRequest("sendMessageWithoutReply", {
        target: "app",
        clientId: -1,
        message: "hello",
      }),
      createRpcRequest("sendMessageWithoutReply", {
        target: "web",
        message: "hello",
      }),
      createRpcRequest("sendMessageWithoutReply", {
        target: "web",
        clientId: "2",
        message: "hello",
      }),
      createRpcRequest("sendMessageWithoutReply", {
        target: "unknown",
        clientId: 1,
        message: "hello",
      }),
      createRpcRequest("closeClient", { clientId: "1" }),
      createRpcRequest("getConnectionTrace", {}),
      createRpcRequest("subscribeConnectionTrace", {}),
      createRpcRequest("unsubscribeConnectionTrace", {}),
    ];

    for (const request of invalidCases) {
      assert.strictEqual(isControlRpcRequest(request), false);
    }
  });

  it("validates all method-aware control RPC response result branches", function () {
    const validCases = [
      createRpcResponse([createDeviceSnapshot()], "connectDevices", {
        debugInfo: {
          protocolVersion: 1,
          daemonVersion: "0.0.1",
          processId: 100,
          timestamp: 1000,
        },
      }),
      createRpcResponse([createClientSnapshot()], "connectUsbClients"),
      createRpcResponse({}, "startDeviceClientWatcher"),
      createRpcResponse({}, "stopDeviceClientWatcher"),
      createRpcResponse({}, "startAllDeviceClientWatchers"),
      createRpcResponse({}, "stopAllDeviceClientWatchers"),
      createRpcResponse({}, "disconnectDevice"),
      createRpcResponse({}, "shutdownDaemon"),
      createRpcResponse(
        { port: 19783, host: "127.0.0.1:19783" },
        "startWSServer"
      ),
      createRpcResponse(createRegisterResponse(), "sendMessageWithReply"),
      createRpcResponse(
        { event: "Customized", data: { ok: true } },
        "sendMessageWithReply"
      ),
      createRpcResponse({}, "sendMessageWithoutReply"),
      createRpcResponse({}, "closeClient"),
    ];

    for (const [response, method] of validCases) {
      assert.strictEqual(isControlRpcResponse(response, method), true, method);
    }
  });

  it("rejects invalid control RPC response base fields and method results", function () {
    const invalidCases = [
      [{ kind: "rpc", id: 1, ok: true, result: undefined }, "startWSServer"],
      [
        { kind: "rpc-response", id: "1", ok: true, result: undefined },
        "startWSServer",
      ],
      [
        { kind: "rpc-response", id: 1, ok: "true", result: undefined },
        "startWSServer",
      ],
      createRpcResponse([createDeviceSnapshot()], "connectUsbClients"),
      createRpcResponse([createClientSnapshot()], "connectDevices"),
      createRpcResponse(
        { event: "Register", data: { id: 1, info: { app: 1 } } },
        "sendMessageWithReply"
      ),
      createRpcResponse(null, "startWSServer"),
      createRpcResponse({}, "startWSServer"),
      createRpcResponse(undefined, "startWSServer"),
      createRpcResponse(undefined, "closeClient"),
      createRpcResponse({ unexpected: true }, "shutdownDaemon"),
      [
        {
          kind: "rpc-response",
          id: 1,
          ok: false,
          error: {
            code: "E_TEST",
          },
        },
      ],
      [
        {
          kind: "rpc-response",
          id: 1,
          ok: false,
          error: {
            code: 1,
            message: "failed",
          },
        },
      ],
    ];

    for (const [response, method] of invalidCases) {
      assert.strictEqual(isControlRpcResponse(response, method), false);
    }
  });

  it("validates method-less control RPC response fallback branch", function () {
    const validResponses = [
      { kind: "rpc-response", id: 1, ok: true, result: undefined },
      { kind: "rpc-response", id: 1, ok: true, result: "ok" },
      {
        kind: "rpc-response",
        id: 1,
        ok: true,
        result: createRegisterResponse(),
      },
      {
        kind: "rpc-response",
        id: 1,
        ok: true,
        result: [createDeviceSnapshot(), createClientSnapshot()],
      },
      {
        kind: "rpc-response",
        id: 1,
        ok: true,
        result: { port: 61660, host: "127.0.0.1:61660" },
      },
      {
        kind: "rpc-response",
        id: 1,
        ok: true,
        result: 1,
      },
      {
        kind: "rpc-response",
        id: 1,
        ok: false,
        error: { code: "E_TEST", message: "failed", details: { ok: false } },
      },
    ];

    for (const response of validResponses) {
      assert.strictEqual(isControlRpcResponse(response), true);
    }

    assert.strictEqual(
      isControlRpcResponse({
        kind: "rpc-response",
        id: 1,
        ok: true,
      }),
      true
    );
  });

  it("validates every control event branch", function () {
    const validEvents = [
      createEvent("snapshot", createSnapshot(), {
        debugInfo: {
          protocolVersion: 1,
          daemonVersion: "0.0.1",
          processId: 100,
          timestamp: 1000,
        },
      }),
      createEvent("legacy-ownership-changed", {
        status: "attached",
        ownerPid: 100,
        reason: "daemon-started",
      }),
      createEvent("legacy-ownership-changed", {
        status: "unattached",
        ownerPid: 100,
        previousOwnerPid: 200,
        reason: "legacy-preempted",
      }),
      createEvent("client-message", {
        source: "usb-runtime",
        id: 1,
        message: "hello",
      }),
      createEvent("client-message", {
        source: "websocket-runtime",
        id: 1,
        message: "hello",
      }),
      createEvent("client-message", {
        source: "websocket-driver",
        id: 1,
        message: "hello",
      }),
    ];

    for (const event of validEvents) {
      assert.strictEqual(isControlEvent(event), true, event.event);
    }
  });

  it("rejects invalid control event base fields and event-specific data", function () {
    const invalidEvents = [
      null,
      createEvent("snapshot", createSnapshot(), { kind: "rpc" }),
      { kind: "event", event: 1, data: {} },
      createEvent("unknown", {}),
      createEvent("snapshot", { ...createSnapshot(), generatedAt: "1000" }),
      createEvent("legacy-ownership-changed", {
        status: "unknown",
        ownerPid: 100,
        reason: "daemon-started",
      }),
      createEvent("legacy-ownership-changed", {
        status: "attached",
        ownerPid: "100",
        reason: "daemon-started",
      }),
      createEvent("legacy-ownership-changed", {
        status: "attached",
        ownerPid: 100,
        previousOwnerPid: "200",
        reason: "daemon-started",
      }),
      createEvent("legacy-ownership-changed", {
        status: "attached",
        ownerPid: 100,
        reason: "unknown",
      }),
      createEvent("client-message", {
        source: "unknown",
        id: 1,
        message: "hello",
      }),
      createEvent("client-message", {
        source: "usb-runtime",
        id: "1",
        message: "hello",
      }),
      createEvent("client-message", {
        source: "websocket-runtime",
        id: 1,
        message: 1,
      }),
      createEvent("client-message", null),
      createEvent("device-connected", createDeviceSnapshot()),
      createEvent("device-disconnected", { serial: "device-1" }),
      createEvent("client-connected", createClientSnapshot()),
      createEvent("client-disconnected", { id: 1 }),
      createEvent("usb-client-message", { id: 1, message: "hello" }),
      createEvent("ws-client-message", { id: 1, message: "hello" }),
      createEvent("ws-web-message", { id: 1, message: "hello" }),
      createEvent(
        "websocket-app-client-connected",
        createWebSocketClientSnapshot()
      ),
      createEvent("websocket-app-client-disconnected", { id: 1 }),
      createEvent(
        "websocket-web-client-connected",
        createWebSocketClientSnapshot()
      ),
      createEvent("websocket-web-client-disconnected", { id: 1 }),
      createEvent("connection-trace-node", {
        sequence: 1,
        event: "client_watch_started",
        timestamp: "2026-07-15T00:00:00.000Z",
        traceSchemaVersion: "0.1",
      }),
    ];

    for (const event of invalidEvents) {
      assert.strictEqual(isControlEvent(event), false);
    }
  });
});
