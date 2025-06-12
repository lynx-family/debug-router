// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import child_process, { ExecException } from "child_process";
import { createWriteStream, ensureDir, remove, copy } from "fs-extra";
import { dirname, join } from "path";
import { defaultLogger } from "./logger";
import Axios from "axios";
import adb from "@devicefarmer/adbkit";

import { Stream } from "stream";
import * as unzip from "unzipper";
import fs from "fs";

let adbPath: string | null = null;

export async function getAdbInstance(adbOption: any) {
  const host = adbOption?.host ?? "127.0.0.1";
  const port = adbOption?.port ?? 5037;

  const validator = new AdbValidator();
  const isValid = await validator.validate();
  if (isValid) {
    defaultLogger.debug("You already have an adb tool");
  } else if (process.platform === "darwin") {
    validator.fix();
  } else {
    defaultLogger.debug(
      "Linux and Win are not supported yet, we'll support them later.",
    );
  }

  const adbClient =
    adbPath === null
      ? adb.createClient({
          host,
          port,
        })
      : adb.createClient({
          host,
          port,
          bin:
            process.platform !== "win32"
              ? join(adbPath!, "adb")
              : join(adbPath!, "adb.exe"),
        });
  return adbClient;
}

async function exeCmd(cmd: string) {
  return new Promise<string>((resolve, reject) => {
    child_process.exec(
      cmd,
      (error: ExecException | null, stdout: string, stderr: string) => {
        if (error == null) {
          resolve(stdout);
        } else {
          reject(new Error(`Command "${cmd}" failed with error: ${stderr}`));
        }
      },
    );
  });
}

export class AdbValidator {
  public async validate(): Promise<boolean> {
    try {
      const stdout = await exeCmd("adb --version");
      defaultLogger.debug("adb tool info :" + stdout);
      return true;
    } catch (error) {
      const message = (error as Error).message;
      defaultLogger.debug(message);
    }

    const homeDir = process.env["HOME"];
    const adb_tool_path = `${homeDir}/.DebugRouterConnector/adb-tool/adb`;
    if (fs.existsSync(dirname(adb_tool_path))) {
      defaultLogger.debug(adb_tool_path);
      const cmd = adb_tool_path + " --version";
      try {
        const stdout = await exeCmd(cmd);
        defaultLogger.debug("adb tool info :" + stdout);
        adbPath = `${homeDir}/.DebugRouterConnector/adb-tool/`;
        return true;
      } catch (error) {
        const message = (error as Error).message;
        defaultLogger.debug(message);
      }
    }
    return false;
  }

  public async fix(): Promise<boolean> {
    try {
      await this.tryInstallAdbTool();
      return true;
    } catch (err: any) {
      defaultLogger.debug(err);
    }
    return false;
  }

  private async tryInstallAdbTool(): Promise<void> {
    const adbAddress =
      "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip";

    const homeDir = process.env["HOME"];
    const path = `${homeDir}/.DebugRouterConnector/platform-tools.zip`;
    const tmpDir = join(dirname(path), "platform-tools");
    adbPath = join(dirname(path), "adb-tool");

    // only adb tool does not exist or adb tool broken will run this installation code
    await ensureDir(dirname(path));
    await ensureDir(adbPath);
    const stream = createWriteStream(path);
    ((await Axios.get(adbAddress, { responseType: "stream" }))
      .data as Stream).pipe(stream);
    await new Promise((resolve, reject) => {
      stream.on("finish", resolve);
      stream.on("error", reject);
    });

    // unzip by unzipper
    await fs
      .createReadStream(path)
      .pipe(unzip.Extract({ path: dirname(path) }))
      .on("error", (err: any) => {
        defaultLogger.debug(err);
      })
      .on("close", () => {
        defaultLogger.debug("Extraction complete");
      });

    await remove(path);
    await copy(`${tmpDir}/adb`, `${adbPath}/adb`);

    fs.chmodSync(`${adbPath}/adb`, 0o777);
    defaultLogger.debug("ADB tool installed successfully!");
  }
}
