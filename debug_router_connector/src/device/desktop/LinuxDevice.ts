// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { BaseDevice } from "../BaseDevice";
import { DebugRouterConnector } from "../../connector/DebugRouterConnector";
import { DeviceOS } from "../../utils/type";

export default class LinuxDevice extends BaseDevice {
  constructor(driver: DebugRouterConnector) {
    super(driver, {
      serial: "Linux",
      title: "Linux",
      os: DeviceOS.Linux,
    });
  }

  getHost(): string {
    return "127.0.0.1";
  }
}
