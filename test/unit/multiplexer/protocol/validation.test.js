// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

require("../register_ts");

const {
  isClientSnapshot,
  isControlMessageMeta,
  isControlEvent,
  isControlRpcMethod,
  isControlRpcRequest,
  isControlRpcResponse,
  isDeviceSnapshot,
  isMultiplexerDiscoveryInfo,
  isMultiplexerHealthResponse,
  isNumberArray,
  isSnapshot,
  isStringArray,
  isWebSocketClientSnapshot,
  parseJsonObject,
  parseJsonValue,
} = require("../../../../debug_router_connector/src/multiplexer/protocol/validation");

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
    daemonVersion: "0.0.1",
    capabilities: ["control"],
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

  it("validates meta optional fields and rejects invalid known optional fields", function () {
    assert.strictEqual(
      isControlMessageMeta({
        protocolVersion: 1,
        clientVersion: "0.0.1",
        daemonVersion: "0.0.1",
        capabilities: ["control"],
        unknownFutureField: true,
      }),
      true
    );
    assert.strictEqual(isControlMessageMeta(null), false);
    assert.strictEqual(
      isControlMessageMeta({
        capabilities: ["control", 1],
      }),
      false
    );
    assert.strictEqual(
      isControlMessageMeta({
        protocolVersion: "1",
      }),
      false
    );
  });

  it("validates snapshot DTOs and permits unknown fields", function () {
    assert.strictEqual(isSnapshot(createSnapshot()), true);
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
        daemonVersion: 1,
      }),
      false
    );
    assert.strictEqual(
      isSnapshot({
        ...createSnapshot(),
        capabilities: ["control", 1],
      }),
      false
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

  it("validates discovery and health DTOs without token", function () {
    assert.strictEqual(
      isMultiplexerDiscoveryInfo({
        pid: 123,
        protocolVersion: 1,
        minSupportedProtocolVersion: 1,
        controlPort: 10000,
        heartbeat: Date.now(),
        startedAt: Date.now(),
        capabilities: ["control"],
        extraFutureField: "ignored",
      }),
      true
    );

    assert.strictEqual(
      isMultiplexerDiscoveryInfo({
        pid: 123,
        protocolVersion: 1,
        heartbeat: Date.now(),
      }),
      false
    );
    assert.strictEqual(
      isMultiplexerDiscoveryInfo({
        pid: 123,
        protocolVersion: 1,
        controlPort: 10000,
        heartbeat: Date.now(),
        startedAt: "now",
      }),
      false
    );
    assert.strictEqual(
      isMultiplexerDiscoveryInfo({
        pid: 123,
        protocolVersion: 1,
        minSupportedProtocolVersion: "1",
        controlPort: 10000,
        heartbeat: Date.now(),
      }),
      false
    );
    assert.strictEqual(
      isMultiplexerDiscoveryInfo({
        pid: 123,
        protocolVersion: 1,
        controlPort: 10000,
        heartbeat: Date.now(),
        capabilities: ["control", 1],
      }),
      false
    );

    assert.strictEqual(
      isMultiplexerHealthResponse({
        ok: true,
        pid: 123,
        protocolVersion: 1,
        minSupportedProtocolVersion: 1,
        heartbeat: Date.now(),
        daemonVersion: "0.0.1",
      }),
      true
    );
    assert.strictEqual(
      isMultiplexerHealthResponse({
        ok: false,
        pid: 123,
        protocolVersion: 1,
        heartbeat: Date.now(),
      }),
      false
    );
    assert.strictEqual(
      isMultiplexerHealthResponse({
        ok: true,
        pid: 123,
        protocolVersion: 1,
        minSupportedProtocolVersion: "1",
        heartbeat: Date.now(),
      }),
      false
    );
    assert.strictEqual(
      isMultiplexerHealthResponse({
        ok: true,
        pid: 123,
        protocolVersion: 1,
        heartbeat: Date.now(),
        capabilities: [1],
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
      ["getDevices", { timeout: 1000, serial: "device-1" }],
      ["getDevices", { serial: null }],
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
      ["startWatchClient", { deviceId: "device-1" }],
      ["stopWatchClient", { deviceId: "device-1" }],
      ["disconnectDevice", { deviceId: "device-1" }],
      ["reacquireLegacyOwnership", {}],
      ["startWSServer", {}],
      ["startWatchAllClients", { force: true }],
      ["sendMessageToWeb", { message: "hello" }],
      ["sendMessageToApp", { id: 1, message: "hello", fromWebClientId: 2 }],
      [
        "sendCustomizedMessage",
        {
          clientId: 1,
          method: "Runtime.evaluate",
          params: { expression: "1+1" },
          sessionId: 2,
          type: "CDP",
        },
      ],
      [
        "sendCustomizedMessage",
        {
          clientId: 1,
          method: "Runtime.evaluate",
          params: "payload",
        },
      ],
      [
        "sendRawMessage",
        {
          clientId: 1,
          message: {
            event: "Initialize",
            data: 1,
          },
        },
      ],
      [
        "sendRawMessage",
        {
          clientId: 1,
          message: createCustomizedRequestMessage(),
        },
      ],
      ["sendMessage", { clientId: 1, message: null }],
      ["sendMessage", { clientId: 1, message: undefined }],
      ["closeClient", { clientId: 1 }],
    ];

    for (const [method, params] of validCases) {
      assert.strictEqual(
        isControlRpcRequest(
          createRpcRequest(method, params, {
            meta: {
              protocolVersion: 1,
              capabilities: ["control"],
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
      {
        kind: "rpc",
        id: 1,
        method: "connectDevices",
        params: {},
        meta: { capabilities: [1] },
      },
      createRpcRequest("unknown", {}),
      createRpcRequest("connectDevices", null),
      createRpcRequest("connectDevices", { timeout: "1000" }),
      createRpcRequest("connectDevices", { serial: 1 }),
      createRpcRequest("connectDevices", { isAutoListenClients: "true" }),
      createRpcRequest("getDevices", { timeout: "1000" }),
      createRpcRequest("getDevices", { serial: 1 }),
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
      createRpcRequest("startWatchClient", {}),
      createRpcRequest("startWatchClient", { deviceId: 1 }),
      createRpcRequest("stopWatchClient", {}),
      createRpcRequest("stopWatchClient", { deviceId: 1 }),
      createRpcRequest("disconnectDevice", {}),
      createRpcRequest("disconnectDevice", { deviceId: 1 }),
      createRpcRequest("startWatchAllClients", { force: "true" }),
      createRpcRequest("sendMessageToWeb", { message: 1 }),
      createRpcRequest("sendMessageToApp", { id: "1", message: "hello" }),
      createRpcRequest("sendMessageToApp", { id: 1, message: 1 }),
      createRpcRequest("sendMessageToApp", {
        id: 1,
        message: "hello",
        fromWebClientId: "2",
      }),
      createRpcRequest("sendCustomizedMessage", {
        clientId: "1",
        method: "Runtime.evaluate",
      }),
      createRpcRequest("sendCustomizedMessage", { clientId: 1, method: 1 }),
      createRpcRequest("sendCustomizedMessage", {
        clientId: 1,
        method: "Runtime.evaluate",
        params: 1,
      }),
      createRpcRequest("sendCustomizedMessage", {
        clientId: 1,
        method: "Runtime.evaluate",
        sessionId: "2",
      }),
      createRpcRequest("sendRawMessage", { clientId: "1", message: {} }),
      createRpcRequest("sendRawMessage", {
        clientId: 1,
        message: { event: "Initialize", data: "1" },
      }),
      createRpcRequest("sendRawMessage", {
        clientId: 1,
        message: { event: "Customized", data: null },
      }),
      createRpcRequest("sendRawMessage", {
        clientId: 1,
        message: {
          ...createCustomizedRequestMessage(),
          data: {
            ...createCustomizedRequestMessage().data,
            sender: "0",
          },
        },
      }),
      createRpcRequest("sendMessage", { message: "hello" }),
      createRpcRequest("closeClient", { clientId: "1" }),
    ];

    for (const request of invalidCases) {
      assert.strictEqual(isControlRpcRequest(request), false);
    }
  });

  it("validates all method-aware control RPC response result branches", function () {
    const validCases = [
      createRpcResponse([createDeviceSnapshot()], "connectDevices"),
      createRpcResponse([createDeviceSnapshot()], "getDevices"),
      createRpcResponse([createClientSnapshot()], "connectUsbClients"),
      createRpcResponse(undefined, "startWatchClient"),
      createRpcResponse(undefined, "stopWatchClient"),
      createRpcResponse(undefined, "disconnectDevice"),
      createRpcResponse(undefined, "reacquireLegacyOwnership"),
      createRpcResponse(undefined, "startWSServer"),
      createRpcResponse(undefined, "startWatchAllClients"),
      createRpcResponse(undefined, "sendMessageToWeb"),
      createRpcResponse(undefined, "sendMessageToApp"),
      createRpcResponse("ok", "sendCustomizedMessage"),
      createRpcResponse(createRegisterResponse(), "sendRawMessage"),
      createRpcResponse(
        { event: "Customized", data: { ok: true } },
        "sendRawMessage"
      ),
      createRpcResponse(undefined, "sendMessage"),
      createRpcResponse(undefined, "closeClient"),
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
      [
        {
          kind: "rpc-response",
          id: 1,
          ok: true,
          result: undefined,
          meta: { capabilities: [1] },
        },
        "startWSServer",
      ],
      createRpcResponse([createDeviceSnapshot()], "connectUsbClients"),
      createRpcResponse([createClientSnapshot()], "connectDevices"),
      createRpcResponse(1, "sendCustomizedMessage"),
      createRpcResponse(
        { event: "Register", data: { id: 1, info: { app: 1 } } },
        "sendRawMessage"
      ),
      createRpcResponse(null, "startWSServer"),
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
      createEvent("snapshot", createSnapshot()),
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
    ];

    for (const event of validEvents) {
      assert.strictEqual(isControlEvent(event), true, event.event);
    }
  });

  it("rejects invalid control event base fields and event-specific data", function () {
    const invalidEvents = [
      null,
      createEvent("snapshot", createSnapshot(), { kind: "rpc" }),
      createEvent("snapshot", createSnapshot(), {
        meta: { capabilities: [1] },
      }),
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
      createEvent("device-connected", { ...createDeviceSnapshot(), serial: 1 }),
      createEvent("device-disconnected", { serial: 1 }),
      createEvent("client-connected", { ...createClientSnapshot(), id: "1" }),
      createEvent("client-disconnected", { id: "1" }),
      createEvent("usb-client-message", { id: "1", message: "hello" }),
      createEvent("ws-client-message", { id: 1, message: 1 }),
      createEvent("ws-web-message", null),
      createEvent("websocket-app-client-connected", {
        ...createWebSocketClientSnapshot(),
        network: "USB",
      }),
      createEvent("websocket-app-client-disconnected", { id: "1" }),
      createEvent(
        "websocket-web-client-connected",
        (() => {
          const snapshot = createWebSocketClientSnapshot();
          delete snapshot.raw_info;
          return snapshot;
        })()
      ),
      createEvent("websocket-web-client-disconnected", { id: "1" }),
    ];

    for (const event of invalidEvents) {
      assert.strictEqual(isControlEvent(event), false);
    }
  });
});
