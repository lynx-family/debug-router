// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");

require("../multiplexer/register_ts");

const {
  monitorUnregisterClient,
  monitorUnregisterDevice,
  setClientTimeMap,
  setDeviceTimeMap,
} = require("../../../debug_router_connector/src/physical/MonitorUtils");
const {
  setDriverReportService,
} = require("../../../debug_router_connector/src/report/interface/DriverReportService");

function createReportService() {
  const reports = [];
  return {
    reports,
    init() {},
    report(eventName, metrics, categories) {
      reports.push({ eventName, metrics, categories });
    },
  };
}

function createDevice(serial) {
  return {
    info: {
      serial,
      os: "TestOS",
      title: `Device ${serial}`,
    },
    get serial() {
      return this.info.serial;
    },
  };
}

function createClient(id, rawInfo) {
  return {
    info: {
      id,
      port: 9000 + id,
      query: {
        app: `app-${id}`,
        os: "Android",
        device: "Pixel",
        device_model: "Pixel",
        device_id: "device-1",
        raw_info: rawInfo,
      },
    },
    clientId() {
      return this.info.id;
    },
  };
}

describe("PhysicalConnector MonitorUtils", function () {
  afterEach(function () {
    setDriverReportService(null);
  });

  it("reports device registration and quick device loss only once", function () {
    const reportService = createReportService();
    setDriverReportService(reportService);
    const device = createDevice(`device-${Date.now()}-quick`);

    setDeviceTimeMap(device);
    monitorUnregisterDevice(device, 60 * 1000);
    monitorUnregisterDevice(device, 60 * 1000);

    assert.deepStrictEqual(
      reportService.reports.map((entry) => entry.eventName),
      ["register_new_device", "quick_lose_device"],
    );
    assert.deepStrictEqual(reportService.reports[0].categories, {
      serial: device.info.serial,
      deviceType: "Unknown",
    });
    assert.strictEqual(
      reportService.reports[1].categories.serial,
      device.info.serial,
    );
    assert.strictEqual(reportService.reports[1].categories.deviceType, "Unknown");
    assert(
      reportService.reports[1].categories.dur >= 0,
      "quick loss duration should be non-negative",
    );
  });

  it("does not report quick device loss outside the retry window", function () {
    const reportService = createReportService();
    setDriverReportService(reportService);
    const device = createDevice(`device-${Date.now()}-slow`);

    setDeviceTimeMap(device);
    monitorUnregisterDevice(device, 0);

    assert.deepStrictEqual(
      reportService.reports.map((entry) => entry.eventName),
      ["register_new_device"],
    );
  });

  it("reports client registration and quick client loss only once", function () {
    const reportService = createReportService();
    setDriverReportService(reportService);
    const client = createClient(Date.now() % 100000, {
      AppProcessName: "com.demo",
    });

    setClientTimeMap(client);
    monitorUnregisterClient(client, 60 * 1000);
    monitorUnregisterClient(client, 60 * 1000);

    assert.deepStrictEqual(
      reportService.reports.map((entry) => entry.eventName),
      ["register_new_client", "quick_lose_client"],
    );
    assert.strictEqual(
      reportService.reports[0].categories.client,
      JSON.stringify({ AppProcessName: "com.demo" }),
    );
    assert.strictEqual(
      reportService.reports[1].categories.client,
      JSON.stringify({ AppProcessName: "com.demo" }),
    );
    assert(
      reportService.reports[1].categories.dur >= 0,
      "quick loss duration should be non-negative",
    );
  });

  it("uses unknown client metadata when raw info is absent and skips slow loss reports", function () {
    const reportService = createReportService();
    setDriverReportService(reportService);
    const client = createClient((Date.now() % 100000) + 1, undefined);

    setClientTimeMap(client);
    monitorUnregisterClient(client, 0);

    assert.deepStrictEqual(reportService.reports, [
      {
        eventName: "register_new_client",
        metrics: null,
        categories: {
          client: "unknown",
        },
      },
    ]);
  });
});
