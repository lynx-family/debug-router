import Client from "../../utils/hdc/client";
import TargetClient from "../../utils/hdc/TargetClient";
import Forward from "../../utils/hdc/Forward";

import { defaultLogger } from "../../utils/logger";
import { DebugRouterConnector } from "../../connector";
import { BaseDevice } from "../BaseDevice";
import detectPort from "detect-port";
import { DeviceOS } from "../../utils/type";
import { getDriverReportService } from "../../report/interface/DriverReportService";

export default class HarmonyDevice extends BaseDevice {
  private hdc: Client;
  private static readonly localBasePort: number = 15000;

  constructor(
    driver: DebugRouterConnector,
    serial: string,
    title: string,
    hdc: Client,
  ) {
    super(driver, {
      serial: serial,
      os: DeviceOS.Harmony,
      title,
    });
    this.hdc = hdc;
  }

  getHost(): string {
    return this.driver.hdcOption?.host ?? "127.0.0.1";
  }

  async forwards() {
    await this.forward(this.remotePorts);
  }

  private async forward(remotePorts: number[]) {
    const device = this.hdc.getDevice(this.serial);
    const failures: { remotePort: number; error: unknown }[] | undefined = this
      .driver.traceRecorder
      ? []
      : undefined;
    if (!device) {
      this.driver.traceRecorder?.record(
        "direct_device",
        "failed",
        {
          deviceId: this.serial,
          metadata: { os: this.info.os, step: "forward" },
        },
        "Device not found",
      );
      getDriverReportService()?.report("harmony_device_forward_error", null, {
        msg: "device not found",
      });
      return;
    }
    try {
      await this.removeForward(device);
    } catch (e: any) {
      this.driver.traceRecorder?.record(
        "direct_device",
        "failed",
        {
          deviceId: this.serial,
          metadata: { os: this.info.os, step: "remove_forward" },
        },
        e,
      );
      defaultLogger.debug(JSON.stringify(e));
      getDriverReportService()?.report("harmony_device_forward_error", null, {
        msg: "remove forward failed",
        error: e?.message,
      });
    }
    this.port = [];
    // randomBase <=19 && randomBase>=0
    const randomBase = Math.floor(Math.random() * 20);
    for (let i = 0; i < remotePorts.length; i++) {
      const remotePort = remotePorts[i];
      let tryCount = 0;
      let lastError: unknown;
      while (tryCount < 5) {
        let hostport =
          HarmonyDevice.localBasePort +
          randomBase * 500 +
          i * 100 +
          tryCount * 10;
        do {
          hostport++;
          hostport = await detectPort(hostport);
          defaultLogger.debug("hdc try hostport:" + hostport);
        } while (this.port.indexOf(hostport) != -1);
        try {
          const result = await device.forward(
            `tcp:${hostport}`,
            `tcp:${remotePort}`,
          );
          if (result) {
            defaultLogger.debug(
              "hdc forward success:" + remotePort + " hostport:" + hostport,
            );
            this.port.push(hostport);
            break;
          } else {
            lastError = "Forward returned no result";
            tryCount++;
          }
        } catch (e: any) {
          lastError = e;
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
          getDriverReportService()?.report(
            "harmony_device_forward_error",
            null,
            {
              msg: "forward remotePort failed",
              error: e?.message,
            },
          );
          tryCount++;
        }
      }

      if (tryCount >= 5) {
        failures?.push({ remotePort, error: lastError });
        defaultLogger.debug("forward failed:" + remotePort);
      }
    }
    this.driver.traceRecorder?.forwardResult(this.info, this.port, failures);
    defaultLogger.debug("hdc forward result:" + JSON.stringify(this.port));
  }

  async removeForward(device: TargetClient) {
    return new Promise<void>(async (resolve, reject) => {
      const forwards: Forward[] = await device.listForwards();
      for (let i = 0; i < forwards.length; i++) {
        const local = forwards[i].local;
        const remote = forwards[i].remote;
        const remotePort = parseInt(remote.replace(/^tcp:/, ""), 10);
        if (this.remotePorts.includes(remotePort)) {
          const result = await device.removeForward(local, remote);
          defaultLogger.debug("removeForward result:" + result);
        } else {
          defaultLogger.debug(
            "not remove forward:" + local + ". for not used by connector",
          );
        }
      }
      resolve();
    });
  }
}
