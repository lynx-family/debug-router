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
import { PhysicalConnector } from "../../physical";
import { defaultLogger } from "../../utils/logger";
import detectPort from "detect-port";
import child_process, { ExecException } from "child_process";
import { getDriverReportService } from "../../report/interface/DriverReportService";
import { DeviceOS } from "../../utils/type";
import { getAdbToolPath } from "../../utils/adb.validator";
import ForwardCommand from "@devicefarmer/adbkit/dist/src/adb/command/host-serial/forward";
import ListForwardsCommand from "@devicefarmer/adbkit/dist/src/adb/command/host-serial/listforwards";
import { withAdbConnection } from "../../utils/adb.connection";
import { AdbHealthGuard } from "./AdbHealthGuard";

export default class AndroidDevice extends BaseDevice {
  private adb: ADBClient;
  private static readonly localBasePort: number = 10000;
  private readonly healthGuard: AdbHealthGuard;
  private readonly forwardedPorts = new Map<number, number>();

  get ports() {
    return this.port;
  }

  constructor(
    driver: PhysicalConnector,
    serial: string,
    title: string,
    adb: ADBClient,
    private readonly host: string = "127.0.0.1",
  ) {
    super(driver, {
      serial: serial,
      os: DeviceOS.Android,
      title,
    });
    this.adb = adb;
    this.healthGuard = new AdbHealthGuard(adb, serial, (error) => {
      this.driver.emit("connector-error", error);
    });
  }

  getHost(): string {
    return this.host;
  }

  async forwards() {
    await this.forward(this.remotePorts);
  }

  async checkClientPort(port: number): Promise<"ready" | "skip" | "pause"> {
    if (!this.connected) return "pause";
    const remotePort = this.forwardedPorts.get(port);
    if (remotePort === undefined) return "skip";
    const result = await this.healthGuard.check(remotePort);
    return this.connected && this.forwardedPorts.get(port) === remotePort
      ? result
      : "pause";
  }

  disconnect() {
    this.healthGuard.close();
    this.forwardedPorts.clear();
    super.disconnect();
  }

  private async forward(remotePorts: number[]) {
    this.forwardedPorts.clear();
    const device = this.adb.getDevice(this.serial);
    if (!device) {
      defaultLogger.debug("device not found by serial:" + this.serial);
      getDriverReportService()?.report("android_device_forward_error", null, {
        msg: "device not found",
      });
      return;
    }
    try {
      await this.adbForwardRemove(device);
    } catch (e: any) {
      defaultLogger.debug(JSON.stringify(e));
      getDriverReportService()?.report("android_device_forward_error", null, {
        msg: "remove forward failed",
        error: e?.message,
      });
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
          hostport = await detectPort({
            port: hostport,
            hostname: "127.0.0.1",
          });
          defaultLogger.debug("adb try hostport:" + hostport);
        } while (this.port.indexOf(hostport) != -1);
        try {
          const result = await withAdbConnection(
            () => this.adb.connection(),
            (connection) =>
              new ForwardCommand(connection).execute(
                this.serial,
                // Keep ADB's atomic check even after detecting a free port.
                `norebind:tcp:${hostport}`,
                `tcp:${remotePort}`,
              ),
          );
          if (result) {
            defaultLogger.debug(
              "adb forward success:" + remotePort + " hostport:" + hostport,
            );
            this.port.push(hostport);
            this.forwardedPorts.set(hostport, remotePort);
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
    defaultLogger.debug("adbForwardRemove");
    return new Promise<void>(async (resolve, reject) => {
      const forwards: Forward[] = await withAdbConnection(
        () => this.adb.connection(),
        (connection) =>
          new ListForwardsCommand(connection).execute(this.serial),
      );
      for (let i = 0; i < forwards.length; i++) {
        if (forwards[i].serial !== this.serial) continue;
        const local = forwards[i].local;
        const remote = forwards[i].remote;
        const remotePort = parseInt(remote.replace(/^tcp:/, ""), 10);
        if (this.remotePorts.includes(remotePort)) {
          const adbToolPath = getAdbToolPath();
          let adbPath =
            adbToolPath + (process.platform !== "win32" ? "/adb" : "/adb.exe");
          if (adbToolPath === null) {
            adbPath = process.platform !== "win32" ? "adb" : "adb.exe";
          }
          const shellCmd = `${adbPath} -H ${this.adb.options.host} -P ${this.adb.options.port} -s ${this.serial} forward --remove ${local}`;
          defaultLogger.debug(shellCmd);
          const result = await this.exeCmd(shellCmd);
          defaultLogger.debug(result);
        } else {
          defaultLogger.debug(
            "not remove forward:" + local + ". for not used by connector",
          );
        }
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
