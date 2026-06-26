// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("../../unit/multiplexer/register_ts");

const connectorIndexPath = path.join(
  __dirname,
  "../../../debug_router_connector/src/connector",
);
const packageRootPath = path.join(
  __dirname,
  "../../../debug_router_connector/src",
);
const legacyPath = path.join(
  __dirname,
  "../../../debug_router_connector/src/connector/LegacyDebugRouterConnector",
);

describe("multiplexer integration legacy backup boundary", function () {
  it("keeps the legacy connector as an explicit backup file but out of public connector exports", function () {
    assert.strictEqual(
      fs.existsSync(`${legacyPath}.ts`),
      true,
      "legacy backup source should remain available for audit",
    );

    const legacyModule = require(legacyPath);
    assert.strictEqual(
      typeof legacyModule.LegacyDebugRouterConnector,
      "function",
    );

    const connectorIndex = require(connectorIndexPath);
    assert.strictEqual(typeof connectorIndex.DebugRouterConnector, "function");
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        connectorIndex,
        "LegacyDebugRouterConnector",
      ),
      false,
      "connector index must not export legacy backup",
    );
  });

  it("keeps the package root on the Multiplexer facade and hides daemon and legacy internals", function () {
    const packageRoot = require(packageRootPath);
    assert.strictEqual(typeof packageRoot.DebugRouterConnector, "function");
    assert.strictEqual(typeof packageRoot.MultiplexerDevice, "function");
    assert.strictEqual(typeof packageRoot.MultiplexerUsbClient, "function");

    for (const forbidden of [
      "LegacyDebugRouterConnector",
      "LegacyMultiOpenGuard",
      "MultiplexerDaemon",
      "MultiplexerHost",
      "MultiplexerControlServer",
      "PendingRouteTable",
      "PhysicalConnector",
    ]) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(packageRoot, forbidden),
        false,
        `${forbidden} should not be exported from the package root`,
      );
    }
  });
});
