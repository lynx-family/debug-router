import { join } from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import Hdc from "./hdc/hdc";

import child_process, { ExecException } from "child_process";
import { defaultLogger } from "./logger";
let hdcPath: string | null = null;

export async function getHdcInstance(hdcOption: any) {
  const host = hdcOption?.host ?? "127.0.0.1";
  const port = hdcOption?.port ?? 8710;

  try {
    const hdcVersion = await exeCmd("hdc --version");
    defaultLogger.debug("You already have hdc tool installed");
    defaultLogger.debug("hdc tool info :" + hdcVersion);
    await exeCmd("hdc start");
    defaultLogger.debug("hdc tool start success");
  } catch (error) {
    const message = (error as Error).message;
    defaultLogger.debug(message);
  }

  const hdcClient =
    hdcPath === null
      ? Hdc.createClient({
          host,
          port,
        })
      : Hdc.createClient({
          host,
          port,
          bin:
            process.platform !== "win32"
              ? join(hdcPath!, "hdc")
              : join(hdcPath!, "hdc.exe"),
        });
  return hdcClient;
}

async function exeCmd(cmd: string) {
  // Keep relative files written by HDC (including during shutdown) out of the
  // caller's workspace. Preserve its environment: TMPDIR also locates HDC locks.
  const cwd = join(
    tmpdir(),
    `debug-router-connector-hdc-${process.getuid?.() ?? "default"}`,
  );
  await fs.mkdir(cwd, { recursive: true });
  return new Promise<string>((resolve, reject) => {
    child_process.exec(
      cmd,
      { cwd },
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
