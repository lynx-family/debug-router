// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import { getDriverReportService } from "../report/interface/DriverReportService";
import * as fslock from "../utils/file_lock";
import { lockDir } from "../utils/file_lock";
import { defaultLogger } from "../utils/logger";
import {
  DefaultMultiOpenCallback,
  MultiOpenCallback,
  MultiOpenStatus,
} from "./MultiOpenCallBack";


/**
 * Preserves the original LatestDriverProcess ownership behavior when
 * Multiplexer is disabled.
 */
export class LegacyMultiOpenGuard {
  private multiOpenCallback: MultiOpenCallback = new DefaultMultiOpenCallback();
  private monitoring: boolean = false;
  multiOpenMonitorTimer?: NodeJS.Timeout;
  currentStatus: MultiOpenStatus = MultiOpenStatus.unInit;
  private started = false;
  private readonly onDisableAllClients: () => void;

  constructor(DisableAllClients: () => void) {
    this.onDisableAllClients = DisableAllClients ?? (() => {});
  }

  setMultiOpenCallback(callback: MultiOpenCallback) {
    this.multiOpenCallback = callback;
  }

  prepareDriverDataDir() {
    fslock.clearLockFileWhenProcessExit();
    try {
      if (!fs.existsSync(fslock.driver_dir)) {
        fs.mkdirSync(fslock.driver_dir);
        return;
      }
    } catch (e: any) {
      getDriverReportService()?.report("multi_open_error", null, {
        error: `prepareDriverDataDir err: ${e?.message}`,
      });
    }
    fslock.clearLockFile();
  }

  startMonitorMultiOpen() {
    if (process.env.DriverCloseMultiOpen === "true") {
      defaultLogger.warn("DriverCloseMultiOpen === true");
      return;
    }
    defaultLogger.info("startMonitorMultiOpen");
    this.monitorLatestDriverProcessFileSafely();
    this.multiOpenMonitorTimer = setInterval(() => {
      this.monitorLatestDriverProcessFileSafely();
    }, 500);
  }

  // monitor LatestDriverProcessFile in connector data dir.
  // 1. if LatestDriverProcessFile doesn't exist or this.currentStatus === MultiOpenStatus.unInit
  // update current process-id to LatestDriverProcessFile

  // 2. if LatestDriverProcessFile's pid !== current process-id && this.currentStatus === MultiOpenStatus.attached
  // disableAllClients and call this.multiOpenCallback.statusChanged(MultiOpenStatus.unattached);
  monitorLatestDriverProcessFile() {
    if (this.monitoring) {
      defaultLogger.debug("has monitored, just return");
      return;
    }
    defaultLogger.debug("start monitor...");
    this.monitoring = true;
    fslock.lock((acquiredLock: boolean) => {
      if (!acquiredLock) {
        defaultLogger.debug("doesn't get lock");
        this.monitoring = false;
        return;
      }
      defaultLogger.debug("get lock");
      try {
        if (this.currentStatus === MultiOpenStatus.unInit) {
          this.updateLatestProcess();
        } else {
          const data: string = fs.readFileSync(
            `${fslock.driver_dir}/LatestDriverProcess`,
            "utf-8",
          );
          defaultLogger.debug("LastDriverProcessID:" + data);
          if (data !== `${process.pid}`) {
            if (this.currentStatus === MultiOpenStatus.attached) {
              this.onDisableAllClients();
              this.currentStatus = MultiOpenStatus.unattached;
              this.multiOpenCallback.statusChanged(MultiOpenStatus.unattached);
            } else {
              // TODO when unattached don't need monitor until activation again
              defaultLogger.debug("current connector has unattached");
            }
          } else {
            defaultLogger.debug("current connector has attached");
          }
        }
      } catch (err: any) {
        if (err?.message?.indexOf("ENOENT") !== -1) {
          this.updateLatestProcess();
        } else {
          defaultLogger.debug(err?.message);
          getDriverReportService()?.report("multi_open_error", null, {
            error: `readFileSync: ${err?.message}`,
          });
        }
      }
      fslock.unlock((err: Error | null) => {
        if (err === null) {
          defaultLogger.debug("unlock ok");
        } else if (err?.message?.indexOf("ENOENT") !== -1) {
          fslock.resetLockStatus();
          defaultLogger.debug("unlock ok");
        } else {
          getDriverReportService()?.report("multi_open_error", null, {
            error: `fslock.unlock error: ${err?.message}`,
          });
          defaultLogger.debug("unlock failed");
        }
        this.monitoring = false;
      });
    });
  }

  private updateLatestProcess() {
    if (!fs.existsSync(lockDir)) {
      defaultLogger.debug("updateLatestProcess: lockfile is removed!");
      return;
    }
    defaultLogger.info("MultiOpen: switch to attached");
    fs.writeFileSync(
      `${fslock.driver_dir}/LatestDriverProcess`,
      `${process.pid}`,
      "utf-8",
    );
    this.currentStatus = MultiOpenStatus.attached;
    this.multiOpenCallback.statusChanged(MultiOpenStatus.attached);
  }

  private monitorLatestDriverProcessFileSafely() {
    try {
      this.monitorLatestDriverProcessFile();
    } catch (err: any) {
      getDriverReportService()?.report("multi_open_error", null, {
        error: `monitorLatestDriverProcessFileSafely error: ${err?.message}`,
      });
    }
  }
}
