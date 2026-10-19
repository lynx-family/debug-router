import Target from "../../utils/hdc/Target";
import Client from "../../utils/hdc/client";
import HarmonyDevice from "./HarmonyDevice";
import { getHdcInstance } from "../../utils/hdc.validator";
import { WatchStatus } from "../../device/WatchStatus";
import Tracker from "../../utils/hdc/tracker";
import { PhysicalConnector } from "../../physical";
import { DeviceManager } from "../DeviceManager";
import { defaultLogger } from "../../utils/logger";
import { getDriverReportService } from "../../report/interface/DriverReportService";

export default class HarmonyDeviceManager extends DeviceManager {
  get host(): string {
    // Match the default host in getHdcInstance (src/utils/hdc.validator.ts).
    return this.hdcOptions?.host ?? "127.0.0.1";
  }

  get port(): number {
    // Match the default port in getHdcInstance (src/utils/hdc.validator.ts).
    return this.hdcOptions?.port ?? 8710;
  }

  private currentWatchStatus: WatchStatus = WatchStatus.StopWatching;
  private retryCount: number = 0;
  private tracker: Tracker | null = null;
  private readonly hdcOptions: any;
  private hdcClient: Client | null = null;

  constructor(driver: PhysicalConnector, options: any) {
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
          this.hdcOptions?.host ?? "127.0.0.1",
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
    this.registerManagedDevice(harmonyDevice);
  }

  protected stopWatching(): void {
    this.currentWatchStatus = WatchStatus.StopWatching;
    this.tracker?.end();
    this.tracker = null;
  }

  async watchDevices(killHdc: boolean = false) {
    if (this.closed) return;
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

    if (this.closed) return;
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

    if (this.closed) return;
    this.tracker?.end();
    this.tracker = null;
    try {
      this.hdcClient
        .trackTargets()
        .then((tracker) => {
          if (this.closed) {
            tracker.on("error", () => {});
            tracker.end();
            return;
          }
          this.tracker = tracker;
          tracker.on("error", async (err: Error) => {
            if (this.closed) return;
            this.currentWatchStatus = WatchStatus.StopWatching;
            const msg = "tracker error:" + err?.message;
            defaultLogger.debug(msg);
            this.unregisterAllHarmonyTarget();
            this.reWatchHarmonyDevices();
          });

          tracker.on("add", (target: Target) => {
            if (this.closed) return;
            this.currentWatchStatus = WatchStatus.Watching;
            this.retryCount = 0;
            defaultLogger.debug("tracker add:" + JSON.stringify(target));
            if (target.connStatus === "Connected") {
              const serial = target.connectKey || target.connType;
              if (!this.driver.devices.has(serial)) {
                this.driver.traceRecorder?.recordDevicePlug(serial, {
                  os: "Harmony",
                  event: "add",
                });
              }
              this.registerDevice(this.hdcClient as Client, target);
            }
          });

          tracker.on("change", (newTarget: Target, oldTarget: Target) => {
            if (this.closed) return;
            this.currentWatchStatus = WatchStatus.Watching;
            this.retryCount = 0;
            defaultLogger.debug(
              "tracker old Target:" + JSON.stringify(oldTarget),
            );
            defaultLogger.debug(
              "tracker change to:" + JSON.stringify(newTarget),
            );
            if (newTarget.connStatus === "Connected") {
              const serial = newTarget.connectKey;
              if (!this.driver.devices.has(serial)) {
                this.driver.traceRecorder?.recordDevicePlug(serial, {
                  os: "Harmony",
                  event: "change",
                });
              }
              this.registerDevice(this.hdcClient as Client, newTarget);
            } else {
              if (this.driver.devices.has(newTarget.connectKey)) {
                this.driver.traceRecorder?.recordDeviceUnplug(
                  newTarget.connectKey,
                  {
                    os: "Harmony",
                    event: "change",
                  },
                );
                this.unregisterManagedDevice(newTarget.connectKey);
              }
            }
          });

          tracker.on("remove", (target: Target) => {
            if (this.closed) return;
            this.currentWatchStatus = WatchStatus.Watching;
            this.retryCount = 0;
            defaultLogger.debug("tracker remove:" + JSON.stringify(target));
            if (this.driver.devices.has(target.connectKey)) {
              this.driver.traceRecorder?.recordDeviceUnplug(target.connectKey, {
                os: "Harmony",
                event: "remove",
              });
              this.unregisterManagedDevice(target.connectKey);
            }
          });
        })
        .catch(async (err: any) => {
          if (this.closed) return;
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
    this.scheduleWatchRetry(() => {
      void this.watchDevices(true);
    });
  }

  private unregisterAllHarmonyTarget() {
    this.unregisterManagedDevices();
  }
}
