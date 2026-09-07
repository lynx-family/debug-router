// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const {
  createIntegrationContext,
  waitFor,
  platformTimeout,
} = require("./helpers/integration_harness");
const {
  setDriverReportService,
} = require("../../../debug_router_connector/dist/cjs/src/report/interface/DriverReportService");

describe("multiplexer integration report service", function () {
  this.timeout(platformTimeout(15000));
  let context;
  let reports;
  let initCalls;
  let service;

  beforeEach(function () {
    setDriverReportService(null);
    reports = [];
    initCalls = 0;
    service = {
      init() {
        initCalls++;
      },
      report(eventName, metrics, categories) {
        reports.push({ eventName, metrics, categories, pid: process.pid });
      },
    };
  });

  afterEach(async function () {
    await context?.cleanup();
    context = undefined;
    setDriverReportService(null);
  });

  async function report(eventName) {
    context.appendCommand({
      type: "report",
      eventName,
      metrics: { count: 1 },
      categories: { source: "daemon" },
    });
    await waitFor(
      () =>
        context
          .readLog()
          .some(
            (item) =>
              item.event === "report-processed" && item.eventName === eventName
          ),
      2000
    );
  }

  function lastActiveControlCount() {
    const logs = context
      .readLog()
      .filter(
        (item) =>
          item.event === "control-disconnected-callback" ||
          item.event === "control-connected-callback"
      );
    return logs[logs.length - 1]?.activeControlCount;
  }

  it("reports once in the caller, fails over, and drains disabled and disconnected backlog", async function () {
    context = createIntegrationContext("reports", {});
    const first = context.createConnector({ reportService: service });
    const second = context.createConnector({
      reportService: {
        init() {
          throw new Error("reinitialized");
        },
        report() {
          throw new Error("wrong service");
        },
      },
    });
    const disabled = context.createConnector();
    await first.connectDevices();
    await second.connectDevices();
    await disabled.connectDevices();
    assert.strictEqual(initCalls, 1);
    assert.strictEqual(
      reports.filter((r) => r.eventName === "fixture-startup-report").length,
      1
    );
    await report("first");
    await first.connectDevices();
    await second.connectDevices();
    assert.strictEqual(
      reports.filter((r) => r.eventName === "first").length,
      1
    );
    await first.close();
    await waitFor(() => lastActiveControlCount() === 2, 2000);
    await report("second");
    await second.connectDevices();
    assert.strictEqual(
      reports.filter((r) => r.eventName === "second").length,
      1
    );
    await second.close();
    await waitFor(() => lastActiveControlCount() === 1, 2000);
    await report("disabled");
    await disabled.connectDevices();
    assert.deepStrictEqual(
      reports.map((r) => r.eventName),
      ["fixture-startup-report", "first", "second"]
    );
    await disabled.close();
    await waitFor(() => lastActiveControlCount() === 0, 2000);
    await report("queued");
    const later = context.createConnector({ reportService: service });
    await later.connectDevices();
    assert.strictEqual(initCalls, 1);
    assert.deepStrictEqual(
      reports.map((r) => r.eventName),
      ["fixture-startup-report", "first", "second", "disabled", "queued"]
    );
    assert(reports.every((r) => r.pid === process.pid));
    assert.deepStrictEqual(reports[1].metrics, { count: 1 });
    assert.deepStrictEqual(reports[1].categories, { source: "daemon" });
  });

  it("retains startup reports while only reporting-disabled Connectors are connected", async function () {
    context = createIntegrationContext("disabled-reports", {});
    const disabled = context.createConnector();
    await disabled.connectDevices();
    await report("disabled");
    await disabled.connectDevices();
    assert.deepStrictEqual(reports, []);
    const enabled = context.createConnector({ reportService: service });
    await enabled.connectDevices();
    assert.deepStrictEqual(
      reports.map((r) => r.eventName),
      ["fixture-startup-report", "disabled"]
    );
    await report("enabled");
    await enabled.connectDevices();
    assert.deepStrictEqual(
      reports.map((r) => r.eventName),
      ["fixture-startup-report", "disabled", "enabled"]
    );
  });
});
