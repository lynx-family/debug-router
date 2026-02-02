// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import os from "os";
import { getDriverReportService } from "../report/interface/DriverReportService";
import { defaultLogger } from "./logger";

// try to import signal-exit, if failed, use native implementation
let onExit: any = null;
try {
  const signalExitModule = require("signal-exit");
  // different versions of signal-exit export different ways
  onExit =
    typeof signalExitModule === "function"
      ? signalExitModule
      : signalExitModule.onExit || signalExitModule.default || null;
} catch (e) {
  defaultLogger.debug("signal-exit import failed, using native implementation");
  onExit = null;
}

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
  // clear the lock file when process exit
  const cleanup = (code?: any, signal?: any) => {
    defaultLogger.debug("process exit:" + code + " " + signal);
    if (hasLock) {
      clearLockFile();
    }
  };

  // if signal-exit is available and is a function, use it
  if (onExit && typeof onExit === "function") {
    try {
      onExit(cleanup);
      return;
    } catch (e) {
      defaultLogger.debug(
        "signal-exit usage failed, falling back to native implementation",
      );
    }
  }

  // backup the native implementation
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGQUIT", cleanup);
  process.on("uncaughtException", cleanup);
  process.on("unhandledRejection", cleanup);
}
