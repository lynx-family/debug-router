// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { DeviceDescription } from "../../utils/type";
import { defaultLogger } from "../../utils/logger";
import type { DeviceSnapshot } from "../protocol";
import type { MultiplexerDaemonClient } from "./MultiplexerDaemonClient";

const DEFAULT_DEVICE_HOST = "127.0.0.1";

export type MultiplexerDeviceOption = {
  snapshot: DeviceSnapshot;
  daemonClient: MultiplexerDaemonClient;
};

export class MultiplexerDevice {
  private snapshot: DeviceSnapshot;
  private connected = true;
  private readonly daemonClient: MultiplexerDaemonClient;

  constructor(option: MultiplexerDeviceOption) {
    this.snapshot = cloneDeviceSnapshot(option.snapshot);
    this.daemonClient = option.daemonClient;
  }

  static fromSnapshot(
    snapshot: DeviceSnapshot,
    daemonClient: MultiplexerDaemonClient,
  ): MultiplexerDevice {
    return new MultiplexerDevice({
      snapshot,
      daemonClient,
    });
  }

  get info(): DeviceDescription {
    return {
      os: this.snapshot.os,
      title: this.snapshot.title,
      serial: this.snapshot.serial,
    };
  }

  get ports(): number[] {
    return this.snapshot.ports ? [...this.snapshot.ports] : [];
  }

  get serial(): string {
    return this.snapshot.serial;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  getHost(): string {
    return this.snapshot.host ?? DEFAULT_DEVICE_HOST;
  }

  updateFromSnapshot(snapshot: DeviceSnapshot): void {
    if (snapshot.serial !== this.serial) {
      throw new Error(
        `Cannot update multiplexer device ${this.serial} with snapshot ${snapshot.serial}`,
      );
    }

    this.snapshot = cloneDeviceSnapshot(snapshot);
    this.connected = true;
  }

  startWatchClient(): void {
    void this.getDaemonClient()
      .call("startWatchClient", {
        deviceId: this.serial,
      })
      .catch((error: Error) => {
        defaultLogger.warn(
          `Failed to start multiplexer device client watcher: ${error.message}`,
        );
      });
  }

  async stopWatchClient(): Promise<void> {
    await this.getDaemonClient().call("stopWatchClient", {
      deviceId: this.serial,
    });
  }

  disConnect(): void {
    this.connected = false;
    void this.getDaemonClient()
      .call("disconnectDevice", {
        deviceId: this.serial,
      })
      .catch((error: Error) => {
        defaultLogger.warn(
          `Failed to disconnect multiplexer device: ${error.message}`,
        );
      });
  }

  private getDaemonClient(): MultiplexerDaemonClient {
    return this.daemonClient;
  }
}

function cloneDeviceSnapshot(snapshot: DeviceSnapshot): DeviceSnapshot {
  return {
    os: snapshot.os,
    title: snapshot.title,
    serial: snapshot.serial,
    ports: snapshot.ports ? [...snapshot.ports] : undefined,
    host: snapshot.host,
  };
}
