// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

// @ts-ignore
import { Client as ADBClient, Device } from "@devicefarmer/adbkit";
import { DebugRouterConnector } from "../../connector";
import { DeviceManager } from "../DeviceManager";
import AndroidDevice from "./AndroidDevice";
import { defaultLogger } from "../../utils/logger";
import { getDriverReportService } from "../../report/interface/DriverReportService";
import { WatchStatus } from "../WatchStatus";
import { getAdbInstance } from "../../utils/adb.validator";

export class AndroidDeviceManager extends DeviceManager {
  private currentWatchStatus: WatchStatus = WatchStatus.StopWatching;
  private retryCount: number = 0;
  private readonly adbOptions: any;
  private adbClient: ADBClient | null = null;
  constructor(driver: DebugRouterConnector, options: any) {
    super(driver);
    this.adbOptions = options;
  }

  private createDevice(
    adbClient: ADBClient,
    device: Device,
  ): Promise<AndroidDevice | undefined> {
    return new Promise(async (resolve, reject) => {
      try {
        const deviceClient = adbClient.getDevice(device.id);
        const props = await deviceClient.getProperties();
        const name = props["ro.product.model"];
        const androidLikeDevice = new AndroidDevice(
          this.driver,
          device.id,
          name,
          adbClient,
        );
        await androidLikeDevice.forwards();
        resolve(androidLikeDevice);
      } catch (e: any) {
        const msg = "create device error:" + e?.message;
        defaultLogger.warn(msg);
        getDriverReportService()?.report("android_connect_warn", null, {
          msg: msg,
          stage: "device",
        });
        const message = `${e.message ?? e}`;
        const isAuthorizationError = message.includes("device unauthorized");
        if (isAuthorizationError) {
          defaultLogger.debug("device unauthorized");
        }
        resolve(undefined); // not ready yet, we will find it in the next tick
      }
    });
  }

  private reWatchAndroidDevices() {
    this.retryCount++;
    setTimeout(() => {
      this.watchDevices(true);
    }, 300);
  }

  private unregisterAllAndroidDevice() {
    const androidDevices = Array.from(this.driver.devices.values()).filter(
      (d) => d instanceof AndroidDevice,
    );
    androidDevices.forEach((d) => {
      this.driver.unregisterDevice(d.serial);
    });
  }

  async watchDevices(killAdb: boolean = false) {
    if (!this.adbClient) {
      this.adbClient = await getAdbInstance(this.adbOptions);
      if (!this.adbClient) {
        defaultLogger.debug("getAdbInstance error");
        getDriverReportService()?.report("android_connect_error", null, {
          msg: "getAdbInstance error",
          stage: "device",
          detail: "getAdbInstance",
        });
        return;
      }
    }
    if (this.currentWatchStatus !== WatchStatus.StopWatching) {
      return;
    }
    this.currentWatchStatus = WatchStatus.PrepareToWatch;

    if (killAdb && this.retryCount > 3) {
      try {
        await this.adbClient.kill();
      } catch (e: any) {
        defaultLogger.debug(e?.message ?? "kill adb: unknown error");
        getDriverReportService()?.report("android_watch_device_error", null, {
          msg: "adbClient kill error",
        });
      }
      this.retryCount = 0;
    }

    try {
      this.adbClient
        .trackDevices()

        // @ts-ignore
        .then((tracker) => {
          tracker.on("error", async (err: Error) => {
            this.currentWatchStatus = WatchStatus.StopWatching;
            const msg = "tracker error:" + err?.message;
            getDriverReportService()?.report("android_connect_error", null, {
              msg: msg,
              stage: "device",
              detail: "track_on_error",
            });
            defaultLogger.debug(msg);
            this.unregisterAllAndroidDevice();
            this.reWatchAndroidDevices();
          });

          tracker.on("add", async (device: Device) => {
            this.currentWatchStatus = WatchStatus.Watching;
            this.retryCount = 0;
            defaultLogger.debug("tracker add:" + JSON.stringify(device));
            getDriverReportService()?.report("add_android_device", null, {
              device_type: device.type,
              serial: device.id,
            });
            if (device.type === "device") {
              this.registerDevice(this.adbClient as ADBClient, device);
            }
          });

          tracker.on("change", async (device: Device) => {
            this.currentWatchStatus = WatchStatus.Watching;
            this.retryCount = 0;
            defaultLogger.debug("tracker change:" + JSON.stringify(device));
            getDriverReportService()?.report("change_android_device", null, {
              device_type: device.type,
              serial: device.id,
            });
            if (device.type === "device") {
              this.registerDevice(this.adbClient as ADBClient, device);
            } else {
              if (this.driver.devices.has(device.id)) {
                this.driver.unregisterDevice(device.id);
              }
            }
          });

          tracker.on("remove", (device: Device) => {
            this.currentWatchStatus = WatchStatus.Watching;
            this.retryCount = 0;
            defaultLogger.debug("tracker remove:" + JSON.stringify(device));
            getDriverReportService()?.report("rm_android_device", null, {
              device_type: device.type,
              serial: device.id,
            });
            if (this.driver.devices.has(device.id)) {
              this.driver.unregisterDevice(device.id);
            }
          });
        })
        .catch(async (err: any) => {
          this.currentWatchStatus = WatchStatus.StopWatching;
          const msg = "trackDevices catch:" + err?.message;
          getDriverReportService()?.report("android_connect_error", null, {
            msg: msg,
            stage: "device",
            detail: "trackDevices_catch",
          });
          defaultLogger.debug(msg);
          this.unregisterAllAndroidDevice();
          this.reWatchAndroidDevices();
        });
    } catch (e: any) {
      // TODO ineffectively branch
      this.currentWatchStatus = WatchStatus.StopWatching;
      const msg = "watchAndroidDevices error:" + e?.message;
      defaultLogger.debug(msg);
      getDriverReportService()?.report("android_connect_error", null, {
        msg: msg,
        stage: "device",
        detail: "watchAndroidDevices_catch",
      });
      this.unregisterAllAndroidDevice();
      this.reWatchAndroidDevices();
    }
  }

  private async registerDevice(adbClient: ADBClient, deviceData: Device) {
    defaultLogger.debug(
      "start to create android device:" + JSON.stringify(deviceData),
    );
    const androidDevice = await this.createDevice(adbClient, deviceData);
    if (!androidDevice) {
      getDriverReportService()?.report("android_register_device_error", null, {
        msg: "androidDevice does not exist",
      });
      return;
    }
    this.driver.registerDevice(androidDevice);
  }
}
