// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License, Version 2.0.

// A separate application process, deliberately terminated without close() by
// the lifecycle E2E. The connector and daemon are the real package entries.
const { DebugRouterConnector } = require("@lynx-js/debug-router-connector");

process.once("message", async ({ options, watches }) => {
  try {
    const connector = new DebugRouterConnector(options);
    await connector.connectDevices();
    for (const endpoint of watches) {
      await connector.watchNetworkDeviceAtIp(endpoint);
    }
    process.send({ ready: true });
  } catch (error) {
    process.send({ error: error.stack ?? String(error) }, () =>
      process.exit(1)
    );
  }
});
