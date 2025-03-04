// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { DeviceOS } from "../../utils/type";
import { BaseDevice } from "../BaseDevice";
import { DebugRouterConnector } from "../../connector/DebugRouterConnector";
import { getDriverReportService } from "../../report/interface/DriverReportService";

export default class NetworkDevice extends BaseDevice {
  constructor(driver: DebugRouterConnector, ip: string, ports: number[]) {
    super(driver, {
      serial: ip,
      title: "NetworkDevice_" + ip,
      os: DeviceOS.Network,
    });
    this.port = ports;
  }

  getHost(): string {
    if (this.serial == "" || !this.serial) {
      getDriverReportService()?.report(
        "network_connect_error",
        {},
        { msg: "Network connect error: no serial", stage: "device" },
      );
    }
    return this.serial;
  }
}
