// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { PhysicalConnector } from "../physical";
import { BaseDevice } from "./BaseDevice";

export abstract class DeviceManager {
  protected readonly driver: PhysicalConnector;
  private readonly managedDevices = new Map<string, BaseDevice>();
  protected closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(driver: PhysicalConnector) {
    this.driver = driver;
  }

  abstract watchDevices(): Promise<void>;

  // Closing is terminal; enabling the platform again creates a new manager.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    try {
      this.stopWatching();
    } finally {
      this.unregisterManagedDevices();
    }
  }

  protected stopWatching(): void {}

  protected scheduleWatchRetry(retry: () => void): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.closed) retry();
    }, 300);
  }

  protected registerManagedDevice(device: BaseDevice): void {
    if (this.closed) {
      device.disconnect();
      return;
    }
    const existing = this.driver.devices.get(device.serial);
    if (existing && existing !== device) return;
    // Track ownership before emitting device-connected: a listener may close us.
    this.managedDevices.set(device.serial, device);
    this.driver.registerDevice(device);
  }

  protected unregisterManagedDevice(serial: string): void {
    const device = this.managedDevices.get(serial);
    this.managedDevices.delete(serial);
    if (device && this.driver.devices.get(serial) === device) {
      this.driver.unregisterDevice(serial);
    }
  }

  protected unregisterManagedDevices(): void {
    for (const serial of this.managedDevices.keys()) {
      this.unregisterManagedDevice(serial);
    }
  }
}
