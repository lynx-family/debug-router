// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

// @ts-ignore
import {
  Client as ADBClient,
  Adb,
  DeviceClient,
  Forward,
} from "@devicefarmer/adbkit";
import { BaseDevice } from "../BaseDevice";
import { DebugRouterConnector } from "../../connector";
import { defaultLogger } from "../../utils/logger";
import detectPort from "detect-port";
import child_process, { ExecException } from "child_process";
import { getDriverReportService } from "../../report/interface/DriverReportService";
import { DeviceOS } from "../../utils/type";

export default class AndroidDevice extends BaseDevice {
  private adb: ADBClient;
  private static readonly localBasePort: number = 10000;

  get ports() {
    return this.port;
  }

  constructor(
    driver: DebugRouterConnector,
    serial: string,
    title: string,
    adb: ADBClient,
  ) {
    super(driver, {
      serial: serial,
      os: DeviceOS.Android,
      title,
    });
    this.adb = adb;
  }

  getHost(): string {
    return this.driver.adbOption?.host ?? "127.0.0.1";
  }

  async forwards() {
    await this.forward(this.remotePorts);
  }

  private async forward(remotePorts: number[]) {
    const device = this.adb.getDevice(this.serial);
    if (!device) {
      return;
    }
    try {
      await this.adbForwardRemove(device);
    } catch (e) {
      defaultLogger.debug(JSON.stringify(e));
    }
    this.port = [];
    // randomBase <=19 && randomBase>=0
    const randomBase = Math.floor(Math.random() * 20);
    for (let i = 0; i < remotePorts.length; i++) {
      const remotePort = remotePorts[i];
      defaultLogger.debug("start forward:" + remotePort);
      let tryCount = 0;
      while (tryCount < 5) {
        // find a available hostport
        let hostport =
          AndroidDevice.localBasePort +
          randomBase * 500 +
          i * 100 +
          tryCount * 10;
        do {
          hostport++;
          hostport = await detectPort(hostport);
          defaultLogger.debug("try hostport:" + hostport);
        } while (this.port.indexOf(hostport) != -1);
        try {
          const result = await device.forward(
            `tcp:${hostport}`,
            `tcp:${remotePort}`,
          );
          if (result) {
            defaultLogger.debug(
              "forward success:" + remotePort + " hostport:" + hostport,
            );
            this.port.push(hostport);
            break;
          } else {
            tryCount++;
          }
        } catch (e: any) {
          defaultLogger.debug(
            "forward failed:" +
              remotePort +
              " e:" +
              e?.message +
              " tryCount:" +
              tryCount +
              " hostport:" +
              hostport,
          );
          getDriverReportService()?.report("android_connect_error", null, {
            msg: "forward failed:" + e?.message,
            stage: "forward",
          });
          tryCount++;
        }
      }

      if (tryCount >= 5) {
        defaultLogger.debug("forward failed:" + remotePort);
      }
    }
    defaultLogger.debug("adb forward result:" + JSON.stringify(this.port));
  }

  async adbForwardRemove(device: DeviceClient) {
    return new Promise<void>(async (resolve, reject) => {
      const forwards: Forward[] = await device.listForwards();
      for (let i = 0; i < forwards.length; i++) {
        const shellCmd = `adb -H ${this.adb.options.host} -P ${this.adb.options.port} forward --remove ${forwards[i].local}`;
        defaultLogger.debug(shellCmd);
        const result = await this.exeCmd(shellCmd);
        defaultLogger.debug(result);
      }
      resolve();
    });
  }

  async exeCmd(cmd: string) {
    return new Promise((resolve, reject) => {
      child_process.exec(
        cmd,
        (error: ExecException | null, stdout: string, stderr: string) => {
          resolve(
            "exeCmd result: " +
              stdout +
              "=====" +
              stderr +
              " exception:" +
              JSON.stringify(error),
          );
        },
      );
    });
  }

  async executeShell(command: string): Promise<string> {
    const device = this.adb.getDevice(this.serial);
    if (!device) {
      return "";
    }

    return await device
      .shell(command)
      .then(Adb.util.readAll)
      .then((output: Buffer) => output.toString().trim());
  }
}
