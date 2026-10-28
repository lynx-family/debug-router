// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License, Version 2.0.

const assert = require("assert");
const { EventEmitter } = require("events");
const root = "../../../../debug_router_connector/dist/cjs/src";
const { isControlEvent } = require(`${root}/multiplexer/protocol`);
const { MultiplexerDaemonHost } = require(`${root}/multiplexer/daemon/MultiplexerDaemonHost`);
const { MultiplexerControlServer } = require(`${root}/multiplexer/daemon/MultiplexerControlServer`);
const { DebugRouterConnector } = require(`${root}/connector/DebugRouterConnector`);
const AndroidDevice = require(`${root}/device/android/AndroidDevice`).default;
const { getDriverReportService, setDriverReportService } = require(`${root}/report/interface/DriverReportService`);

describe("connector-error", () => {
  it("delivers an ADB failure to every facade without telemetry", async () => {
    const previous = getDriverReportService();
    const physical = new EventEmitter();
    const host = new MultiplexerDaemonHost({ physicalConnector: physical, protocolVersion: 2 });
    const server = Object.create(MultiplexerControlServer.prototype);
    const received = [[], []];
    // Exercise the real broadcast and facade dispatch without opening sockets.
    server.connections = new Map(received.map((events, id) => {
      const facade = Object.create(DebugRouterConnector.prototype);
      facade.events = new EventEmitter();
      facade.on("connector-error", (error) => events.push(error));
      return [id, { send(event) {
        const decoded = JSON.parse(JSON.stringify(event));
        assert(isControlEvent(decoded));
        assert(!isControlEvent({ ...decoded, data: { code: 1 } }));
        facade.applyHostEvent(decoded);
      } }];
    }));
    host.controlServer = server;
    host.bindPhysicalConnectorEvents();
    const device = new AndroidDevice(physical, "redmi", "phone", { options: {} });
    try {
      device.healthGuard.shell = async () => { throw new Error("device offline"); };
      assert.strictEqual(await device.healthGuard.check(8901), "pause");
      assert.strictEqual(received[0].length, 1);
      assert.deepStrictEqual(received[0], received[1]);
      assert.strictEqual(received[0][0].code, "ADB_UNRESPONSIVE");
      assert.strictEqual(received[0][0].deviceSerial, "redmi");
      assert.strictEqual(host.reportBridge.queue.length, 0);
      host.unbindPhysicalConnectorEvents();
      physical.emit("connector-error", received[0][0]);
      assert.strictEqual(received[0].length, 1);
    } finally {
      device.healthGuard.close();
      host.unbindPhysicalConnectorEvents();
      host.reportBridge.close();
      setDriverReportService(previous);
    }
  });
});
