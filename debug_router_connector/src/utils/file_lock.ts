// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import os from "os";
import { onExit } from "signal-exit";
import { getDriverReportService } from "../report/interface/DriverReportService";
import { defaultLogger } from "./logger";

export const driver_dir = os.homedir() + "/.DebugRouterConnector";
export const lockDir = driver_dir + "/lockfile";

let hasLock = false;

function mkdirSync(path: string, callback: (mkdirState: boolean) => void) {
  try {
    fs.mkdirSync(path);
    callback(true);
  } catch (e: any) {
    callback(false);
  }
}

function rmdirSync(path: string, callback: (err: Error | null) => void) {
  try {
    fs.rmSync(path, { recursive: true, force: true });
    callback(null);
  } catch (e: any) {
    callback(e);
  }
}
// define the method to get lock
export function lock(callback: (acquiredLock: boolean) => void) {
  if (hasLock) {
    // already own the lock
    callback(true);
    return;
  }
  mkdirSync(lockDir, (mkdirState: boolean) => {
    if (!mkdirState) {
      const warning_msg = "mkdir failed:" + lockDir;
      defaultLogger.debug(warning_msg);
      callback(false);
      getDriverReportService()?.report("fs_file_lock_warning", null, {
        error: warning_msg,
      });
    } else {
      hasLock = true; // Sets the flag of the created lock
      callback(true);
    }
  });
}

// define the method to free lock
export function unlock(afterUnlock: (err: Error | null) => void) {
  if (!hasLock) {
    afterUnlock(null); // No locks to release
  }
  rmdirSync(lockDir, (err: Error | null) => {
    if (err !== null) {
      const error_msg = "unlock: fs rm lockDir:" + err.message;
      defaultLogger.debug(error_msg);
      afterUnlock(err);
      getDriverReportService()?.report("fs_file_lock_error", null, {
        error: error_msg,
      });
    } else {
      hasLock = false;
      afterUnlock(null);
    }
  });
}

export function resetLockStatus() {
  hasLock = false;
}

export function clearLockFile() {
  try {
    fs.rmdirSync(lockDir);
  } catch (e: any) {
    const error_msg = e?.message ?? "";
    defaultLogger.debug(error_msg);
    if (error_msg.indexOf("ENOENT") === -1) {
      getDriverReportService()?.report("fs_file_lock_error", null, {
        error: error_msg,
      });
    }
  }
}

export function clearLockFileWhenProcessExit() {
  onExit((code, signal) => {
    defaultLogger.debug("process exit:" + code + " " + signal);
    if (hasLock) {
      clearLockFile();
    }
  });
}
