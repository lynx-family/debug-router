import Target from "../../utils/hdc/Target";
import Client from "../../utils/hdc/client";
import HarmonyDevice from "./HarmonyDevice";
import { getHdcInstance } from "../../utils/hdc.validator";
import { WatchStatus } from "../../device/WatchStatus";
import { DebugRouterConnector } from "../../connector";
import { DeviceManager } from "../DeviceManager";
import { defaultLogger } from "../../utils/logger";
import { getDriverReportService } from "../../report/interface/DriverReportService";

export default class HarmonyDeviceManager extends DeviceManager {
  private currentWatchStatus: WatchStatus = WatchStatus.StopWatching;
  private retryCount: number = 0;
  private readonly hdcOptions: any;
  private hdcClient: Client | null = null;

  constructor(driver: DebugRouterConnector, options: any) {
    super(driver);
    this.hdcOptions = options;
  }

  private async createDevice(
    hdcClient: Client,
    target: Target,
  ): Promise<HarmonyDevice | undefined> {
    return new Promise(async (resolve, reject) => {
      try {
        const device: HarmonyDevice = new HarmonyDevice(
          this.driver,
          target.connectKey,
          "Harmony",
          hdcClient,
        );
        await device.forwards();
        resolve(device);
      } catch (e: any) {
        const msg =
          "createDevice: harmony: error" + target.connectKey + " " + e?.message;
        defaultLogger.debug(msg);
        getDriverReportService()?.report("harmony_create_device_error", null, {
          msg: msg,
          stage: "create",
        });
        resolve(undefined);
      }
    });
  }

  private async registerDevice(hdcClient: Client, target: Target) {
    defaultLogger.debug(
      "start to create harmony device:" + JSON.stringify(target),
    );
    const harmonyDevice = await this.createDevice(hdcClient, target);
    if (!harmonyDevice) {
      getDriverReportService()?.report("harmony_register_device_error", null, {
        msg: "harmonyDevice does not exist",
      });
      return;
    }
    this.driver.registerDevice(harmonyDevice);
  }

  async watchDevices(killHdc: boolean = false) {
    if (!this.hdcClient) {
      this.hdcClient = await getHdcInstance(this.hdcOptions);
      if (!this.hdcClient) {
        defaultLogger.debug("getHdcInstance error");
        getDriverReportService()?.report("harmony_watch_device_error", null, {
          msg: "getHdcInstance error",
          stage: "device",
          detail: "getHdcInstance",
        });
        return;
      }
    }

    if (this.currentWatchStatus !== WatchStatus.StopWatching) {
      return;
    }
    this.currentWatchStatus = WatchStatus.PrepareToWatch;

    if (killHdc && this.retryCount > 3) {
      try {
        await this.hdcClient.kill();
      } catch (e: any) {
        defaultLogger.debug("hdcClient kill error");
        getDriverReportService()?.report("harmony_watch_device_error", null, {
          msg: "hdcClient kill error",
        });
      }
      this.retryCount = 0;
    }

    try {
      this.hdcClient
        .trackTargets()
        .then((tracker) => {
          tracker.on("error", async (err: Error) => {
            this.currentWatchStatus = WatchStatus.StopWatching;
            const msg = "tracker error:" + err?.message;
            defaultLogger.debug(msg);
            this.unregisterAllHarmonyTarget();
            this.reWatchHarmonyDevices();
          });

          tracker.on("add", (target: Target) => {
            this.currentWatchStatus = WatchStatus.Watching;
            this.retryCount = 0;
            defaultLogger.debug("tracker add:" + JSON.stringify(target));
            if (target.connStatus === "Connected") {
              this.registerDevice(this.hdcClient as Client, target);
            }
          });

          tracker.on("change", (newTarget: Target, oldTarget: Target) => {
            this.currentWatchStatus = WatchStatus.Watching;
            this.retryCount = 0;
            defaultLogger.debug(
              "tracker old Target:" + JSON.stringify(oldTarget),
            );
            defaultLogger.debug(
              "tracker change to:" + JSON.stringify(newTarget),
            );
            if (newTarget.connStatus === "Connected") {
              this.registerDevice(this.hdcClient as Client, newTarget);
            } else {
              if (this.driver.devices.has(newTarget.connectKey)) {
                this.driver.unregisterDevice(newTarget.connectKey);
              }
            }
          });

          tracker.on("remove", (target: Target) => {
            this.currentWatchStatus = WatchStatus.Watching;
            this.retryCount = 0;
            defaultLogger.debug("tracker remove:" + JSON.stringify(target));
            if (this.driver.devices.has(target.connType)) {
              this.driver.unregisterDevice(target.connType);
            }
          });
        })
        .catch(async (err: any) => {
          this.currentWatchStatus = WatchStatus.StopWatching;
          const msg = "trackDevices catch:" + err?.message;
          defaultLogger.debug(msg);
          getDriverReportService()?.report("harmony_watch_device_error", null, {
            msg: msg,
            stage: "device",
            detail: "trackDevices_catch",
          });
          this.unregisterAllHarmonyTarget();
          this.reWatchHarmonyDevices();
        });
    } catch (e: any) {
      // TODO ineffectively branch
      this.currentWatchStatus = WatchStatus.StopWatching;
      const msg = "watchHarmonyDevices error:" + e?.message;
      defaultLogger.debug(msg);
      getDriverReportService()?.report("harmony_watch_device_error", null, {
        msg: msg,
        stage: "device",
        detail: "watchHarmonyDevices_catch",
      });
      this.unregisterAllHarmonyTarget();
      this.reWatchHarmonyDevices();
    }
  }

  private reWatchHarmonyDevices() {
    this.retryCount++;
    setTimeout(() => {
      this.watchDevices(true);
    }, 300);
  }

  private unregisterAllHarmonyTarget() {
    const harmonyDevices = Array.from(this.driver.devices.values()).filter(
      (d) => d instanceof HarmonyDevice,
    );
    harmonyDevices.forEach((device) => {
      this.driver.unregisterDevice(device.serial);
    });
  }
}
