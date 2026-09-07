// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { PhysicalConnector } from "../physical";

export abstract class DeviceManager {
  protected readonly driver: PhysicalConnector;

  constructor(driver: PhysicalConnector) {
    this.driver = driver;
  }

  abstract watchDevices(): Promise<void>;
}
