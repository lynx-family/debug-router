#!/usr/bin/env node

import { defaultLogger } from "../utils/logger";
import { main } from "./main";

defaultLogger.setOutput((level, ...message) => {
  process.stderr.write(
    `${JSON.stringify({ log: { level, message: message.join(" ") } })}\n`,
  );
});

const controller = new AbortController();
let signalExitCode: number | undefined;
process.once("SIGINT", () => {
  signalExitCode = 130;
  controller.abort();
});
process.once("SIGTERM", () => {
  signalExitCode = 143;
  controller.abort();
});

main(process.argv.slice(2), undefined, {
  stdout: process.stdout,
  stderr: process.stderr,
  signal: controller.signal,
  get signalExitCode() {
    return signalExitCode;
  },
}).then((code) => {
  process.exitCode = code;
});
