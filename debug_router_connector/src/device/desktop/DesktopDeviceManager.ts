// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { DebugRouterConnector } from "../../connector";
import MacDevice from "./MacDevice";
import WindowsDevice from "./WindowsDevice";
import { DeviceManager } from "../DeviceManager";

export default class DesktopDeviceManager extends DeviceManager {
  constructor(driver: DebugRouterConnector) {
    super(driver);
  }
  async watchDevices() {
    let device;
    if (process.platform === "darwin") {
      device = new MacDevice(this.driver);
    } else if (process.platform === "win32") {
      device = new WindowsDevice(this.driver);
    } else {
      return;
    }
    this.driver.registerDevice(device);
  }
}
