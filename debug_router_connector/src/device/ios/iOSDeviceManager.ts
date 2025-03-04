// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import * as plist from "plist";
import iOSDevice from "./iOSDevice";
import { DeviceManager } from "../DeviceManager";
import { DebugRouterConnector } from "../../connector";
import { defaultLogger } from "../../utils/logger";
import { getDriverReportService } from "../../report/interface/DriverReportService";
import { Socket } from "net";
import { DeviceWatchStatusSocket } from "./DeviceWatchStatusSocket";
import { WatchStatus } from "../WatchStatus";
// @ts-ignore
import {
  createListener,
  getTunnel,
} from "../../../third_party/usbmux/lib/usbmux";

export default class IOSDeviceManager extends DeviceManager {
  // lockdown port
  private readonly LOCKDOWN_PORT: number = 62078;
  private listener: DeviceWatchStatusSocket | null = null;
  constructor(driver: DebugRouterConnector) {
    super(driver);
  }

  private createDevice(
    serial: string,
    title: string,
  ): Promise<iOSDevice | undefined> {
    return new Promise(async (resolve, reject) => {
      try {
        const device: iOSDevice = new iOSDevice(this.driver, serial, title);
        resolve(device);
      } catch (e: any) {
        const msg = "createDevice: iOS: error" + serial + " " + e?.message;
        defaultLogger.debug(msg);
        getDriverReportService()?.report("ios_connect_error", null, {
          msg: msg,
          stage: "device",
        });
        resolve(undefined);
      }
    });
  }

  private async reWatchIOSDevices() {
    setTimeout(() => {
      this.watchDevices();
    }, 300);
  }

  private createUsbmuxListener() {
    let client: Socket | null = null;
    try {
      client = createListener();
    } catch (err: any) {
      const msg = "createUsbmuxListener error:" + err?.message;
      defaultLogger.debug(msg);
      getDriverReportService()?.report("ios_connect_error", null, {
        msg: msg,
        stage: "device",
        detail: "createUsbmuxListener",
      });
    }
    return client;
  }

  public async watchDevices() {
    if (
      this.listener !== null &&
      this.listener?.currentWatchStatus !== WatchStatus.StopWatching
    ) {
      return;
    }
    this.listener?.getRawSocket().destroy();
    this.listener = null;
    try {
      let usbmuxListener = this.createUsbmuxListener();
      if (usbmuxListener === null) {
        this.reWatchIOSDevices();
        return;
      }
      let statusSocket = new DeviceWatchStatusSocket(usbmuxListener);
      statusSocket.currentWatchStatus = WatchStatus.PrepareToWatch;
      // TODO on usbmux_error before create createUsbmuxListener
      usbmuxListener.on("usbmux_error", (err: Error) => {
        statusSocket.currentWatchStatus = WatchStatus.StopWatching;
        const msg = "watchIOSDevices listener_error:" + err?.message;
        defaultLogger.debug(msg);
        getDriverReportService()?.report("ios_connect_error", null, {
          msg: msg,
          stage: "device",
          detail: "listenerOnError",
        });
        this.reWatchIOSDevices();
      });

      usbmuxListener.on("close", (hadError: boolean) => {
        statusSocket.currentWatchStatus = WatchStatus.StopWatching;
        defaultLogger.debug("watchIOSDevices listener_close");
        this.reWatchIOSDevices();
      });

      usbmuxListener.on("attached", (udid: string) => {
        statusSocket.currentWatchStatus = WatchStatus.Watching;
        defaultLogger.debug("watchIOSDevices attached:" + JSON.stringify(udid));
        this.handleDeviceConnect(udid, statusSocket);
      });

      usbmuxListener.on("detached", (udid: string) => {
        statusSocket.currentWatchStatus = WatchStatus.Watching;
        defaultLogger.debug("watchIOSDevices detached:" + JSON.stringify(udid));
        this.driver.unregisterDevice(udid);
      });
      this.listener = statusSocket;
    } catch (e: any) {
      // TODO ineffectively catch
      const msg = "watchIOSDevices error:" + e?.message;
      defaultLogger.debug(msg);
      getDriverReportService()?.report("ios_connect_error", null, {
        msg: msg,
        stage: "device",
        detail: "watchIOSDevices_catch",
      });
      this.reWatchIOSDevices();
    }
  }

  async handleDeviceConnect(
    udid: string,
    statusSocket: DeviceWatchStatusSocket,
  ) {
    getTunnel(this.LOCKDOWN_PORT, { udid: udid })
      .then((tunnel: any) => {
        const parse = this.makeParse((result: any) => {
          const deviceName: string | undefined = result?.Value?.DeviceName;
          if (deviceName) {
            if (!this.driver.devices.has(udid)) {
              this.registerDevice(udid, deviceName);
            }
          } else {
            getDriverReportService()?.report("ios_connect_error", null, {
              stage: "device",
              detail: "handleDeviceConnect_deviceName_null",
              udid: udid,
            });
          }
        });

        tunnel.on("data", parse);

        tunnel.on("close", (hadError: boolean) => {
          const msg = "handleDeviceConnect: tunnel close:" + udid;
          defaultLogger.debug(msg);
          getDriverReportService()?.report("ios_connect_close", null, {
            stage: "device",
            detail: "handleDeviceConnect_tunnel_close",
            udid: udid,
          });
          tunnel.destroy();
          statusSocket.currentWatchStatus = WatchStatus.StopWatching;
          this.reWatchIOSDevices();
        });

        tunnel.on("usbmux_error", (err: Error) => {
          const msg =
            "handleDeviceConnect: tunnel error:" + udid + " " + err?.message;
          defaultLogger.debug(msg);
          getDriverReportService()?.report("ios_connect_error", null, {
            msg: err?.message ?? "unknown error",
            stage: "device",
            detail: "handleDeviceConnect_tunnel_error",
            udid: udid,
          });
          tunnel.destroy();
          statusSocket.currentWatchStatus = WatchStatus.StopWatching;
          this.reWatchIOSDevices();
        });

        // get iphone's name
        const payload_plist = plist.build({
          Request: "GetValue",
          key: "DeviceName",
        });
        const payload_buf = new Buffer(payload_plist);
        const header_buf = new Buffer(4);
        header_buf.fill(0);
        header_buf.writeUInt32BE(payload_buf.length, 0);

        tunnel.write(Buffer.concat([header_buf, payload_buf]));
      })
      .catch((err: Error) => {
        const msg =
          "handleDeviceConnect: getTunnel and then error:" + err?.message;
        defaultLogger.debug(msg);
        getDriverReportService()?.report("ios_connect_error", null, {
          msg: msg,
          stage: "device",
        });
        statusSocket.currentWatchStatus = WatchStatus.StopWatching;
        this.reWatchIOSDevices();
      });
  }

  private makeParse(onComplete: (result: any) => void = () => {}) {
    let len: number, msg: string;

    return function parse(data: any) {
      if (!len) {
        len = data.readUInt32BE(0);
        data = data.slice(4);
        msg = "";
        if (!data.length) return;
      }
      const body = data.slice(0, len);
      msg += body;
      len -= body.length;
      if (len === 0) {
        onComplete(plist.parse(msg));
      }
      data = data.slice(body.length);
      if (data.length) parse(data);
    };
  }

  async registerDevice(udid: string, title: string) {
    defaultLogger.debug("start to registerDevice: iOS:" + udid + " " + title);
    const device: iOSDevice | undefined = await this.createDevice(udid, title);
    if (!device) {
      return;
    }

    this.driver.registerDevice(device);
  }
}
