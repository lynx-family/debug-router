// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { DebugRouterConnector } from "../connector";
import { ClientController } from "../usb/ClientController";
import { defaultLogger } from "../utils/logger";
import { DeviceDescription } from "../utils/type";

export abstract class BaseDevice {
  readonly info: DeviceDescription;
  protected readonly driver: DebugRouterConnector;
  protected connected: boolean;
  protected clientController?: ClientController;

  protected static readonly remoteBasePort: number = 8901;
  // default is 19
  protected static readonly monitorCount: number = 19;
  protected readonly remotePorts: number[] = [
    ...Array(BaseDevice.monitorCount).keys(),
  ].map((i) => i + BaseDevice.remoteBasePort);
  protected port: number[];
  constructor(driver: DebugRouterConnector, info: DeviceDescription) {
    this.info = info;
    this.driver = driver;
    this.connected = true;
    if (process.env.DriverPortCount) {
      defaultLogger.debug("DriverPortCount:" + process.env.DriverPortCount);
      try {
        const count: number = new Number(process.env.DriverPortCount).valueOf();
        this.remotePorts = [...Array(count).keys()].map(
          (i) => i + BaseDevice.remoteBasePort,
        );
      } catch (e) {
        defaultLogger.debug("DriverPortCount error:" + JSON.stringify(e));
      }
    }
    defaultLogger.debug("remotePorts:" + this.remotePorts);
    this.port = this.remotePorts;
  }

  get ports(): number[] {
    return this.port;
  }

  get serial(): string {
    return this.info.serial;
  }

  abstract getHost(): string;

  startWatchClient() {
    defaultLogger.debug("connectUsbClients: startWatchClient");
    this.clientController?.stopWatchClient();
    this.clientController = new ClientController(this.driver, this);
    this.clientController.startWatchClient();
  }

  async stopWatchClient() {
    defaultLogger.debug("connectUsbClients: stopWatchClient");
    if (this.clientController) {
      await this.clientController.stopWatchClient();
    }
  }

  disConnect() {
    this.connected = false;
    if (this.clientController) {
      this.clientController.close();
    }
  }
}
