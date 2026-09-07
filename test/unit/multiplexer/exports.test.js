// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

function keys(moduleExports) {
  return Object.keys(moduleExports).sort();
}

function assertNoInternalExports(moduleExports) {
  [
    "MultiplexerDaemonClient",
    "MultiplexerDaemonManager",
    "MultiplexerDiscovery",
    "MultiplexerDaemonHost",
    "MultiplexerControlConnection",
    "MultiplexerControlServer",
    "PendingRouteTable",
    "PhysicalConnector",
  ].forEach((name) => {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(moduleExports, name),
      false,
      `${name} should not be exported`
    );
  });
}

describe("multiplexer public export indexes", function () {
  it("connector index exposes only the DebugRouterConnector runtime facade", function () {
    const connector = require("../../../debug_router_connector/dist/cjs/src/connector");

    assert.deepStrictEqual(keys(connector), ["DebugRouterConnector"]);
    assert.strictEqual(typeof connector.DebugRouterConnector, "function");
    assertNoInternalExports(connector);
  });

  it("multiplexer client index exposes connector-side mirror classes only", function () {
    const client = require("../../../debug_router_connector/dist/cjs/src/multiplexer/client");

    assert.deepStrictEqual(keys(client), [
      "MultiplexerDevice",
      "MultiplexerUsbClient",
    ]);
    assert.strictEqual(typeof client.MultiplexerDevice, "function");
    assert.strictEqual(typeof client.MultiplexerUsbClient, "function");
    assertNoInternalExports(client);
  });

  it("multiplexer root index exposes only public mirror classes at runtime", function () {
    const multiplexer = require("../../../debug_router_connector/dist/cjs/src/multiplexer");

    assert.deepStrictEqual(keys(multiplexer), [
      "MultiplexerDevice",
      "MultiplexerUsbClient",
    ]);
    assert.strictEqual(typeof multiplexer.MultiplexerDevice, "function");
    assert.strictEqual(typeof multiplexer.MultiplexerUsbClient, "function");
    assertNoInternalExports(multiplexer);
  });

  it("package root keeps legacy public exports and adds multiplexer mirrors without daemon internals", function () {
    const root = require("../../../debug_router_connector/dist/cjs/src");

    [
      "BaseDevice",
      "Client",
      "DebugRouterConnector",
      "DeviceManager",
      "MultiOpenStatus",
      "MultiplexerDevice",
      "MultiplexerUsbClient",
      "SocketEvent",
      "UsbClient",
      "WatchStatus",
      "WebSocketClient",
      "defaultLogger",
      "getDriverReportService",
    ].forEach((name) => {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(root, name),
        true,
        `${name} should be exported from package root`
      );
    });
    assertNoInternalExports(root);
  });

  it("protocol index keeps runtime constants and validators available for package internals", function () {
    const protocol = require("../../../debug_router_connector/dist/cjs/src/multiplexer/protocol");

    [
      "MULTIPLEXER_PROTOCOL_VERSION",
      "isClientSnapshot",
      "isControlEvent",
      "isControlRpcRequest",
      "isControlRpcResponse",
      "isDeviceSnapshot",
      "isMultiplexerDebugInfo",
      "isMultiplexerHealthRequest",
      "isMultiplexerHealthResponse",
      "isMultiplexerHandshakeErrorResponse",
      "isMultiplexerRegisterRequest",
      "isMultiplexerRegisterResponse",
      "isSnapshot",
      "isWebSocketClientSnapshot",
      "parseJsonObject",
      "parseJsonValue",
    ].forEach((name) => {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(protocol, name),
        true,
        `${name} should be exported from protocol index`
      );
    });
    assertNoInternalExports(protocol);
  });
});
