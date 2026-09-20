// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { DebugRouterConnector } from "../../connector";
import NetworkDevice from "./NetworkDevice";
import { DeviceManager } from "../DeviceManager";

export default class NetworkDeviceManager extends DeviceManager {
  private readonly networkDeviceOpt:
    | {
        ip: string;
        port: number[];
      }
    | undefined;
  constructor(driver: DebugRouterConnector, options: any) {
    super(driver);
    this.networkDeviceOpt = options;
  }

  async watchDevices() {
    const device = new NetworkDevice(
      this.driver,
      this.networkDeviceOpt!.ip,
      this.networkDeviceOpt!.port,
    );
    this.driver.registerDevice(device);
  }
}
