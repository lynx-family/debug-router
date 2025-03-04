// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { DebugRouterConnector } from "../../connector";
import { DeviceOS } from "../../utils/type";
import { BaseDevice } from "../BaseDevice";

export default class iOSDevice extends BaseDevice {
  constructor(driver: DebugRouterConnector, serial: string, title: string) {
    super(driver, {
      serial,
      title,
      os: DeviceOS.iOS,
    });
  }

  getHost(): string {
    return "/var/run/usbmuxd";
  }
}
