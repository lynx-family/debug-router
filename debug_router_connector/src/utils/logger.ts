// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const chalk = require("chalk");

export type LogLevel = "error" | "warn" | "info" | "silent" | "debug" | "trace";

const LogLevels: Record<LogLevel, number> = {
  error: 0,
  silent: 1,
  trace: 2,
  warn: 3,
  info: 4,
  debug: 5,
};

interface LoggerOptions {
  level?: LogLevel;
}

function dateFormat(fmt = "yyyy-MM-dd hh:mm:ss", date = new Date()) {
  const o: Record<string, number> = {
    "M+": date.getMonth() + 1, // month
    "d+": date.getDate(), // day
    "h+": date.getHours(), // hour
    "m+": date.getMinutes(), // min
    "s+": date.getSeconds(), // sec
    "q+": Math.floor((date.getMonth() + 3) / 3), // quarter
    S: date.getMilliseconds(), // millsec
  };
  if (/(y+)/.test(fmt))
    fmt = fmt.replace(
      RegExp.$1,
      (date.getFullYear() + "").substr(4 - RegExp.$1.length),
    );
  for (var k in o)
    if (new RegExp("(" + k + ")").test(fmt))
      fmt = fmt.replace(
        RegExp.$1,
        (RegExp.$1.length == 1
          ? o[k]
          : ("00" + o[k]).substr(("" + o[k]).length)) as string,
      );
  return fmt;
}

export default class Logger {
  /**
   * current log level, default value is 'info'.
   */
  level: LogLevel;
  timesMap: Map<string, any>;
  private output: (level: LogLevel, ...message: string[]) => void;

  constructor(opts: LoggerOptions = { level: "info" }) {
    this.level = opts.level || "info";
    this.timesMap = new Map();
    this.output = this.defaultOutput;
  }

  setOutput(output: (level: LogLevel, ...message: string[]) => void) {
    this.output = output;
  }

  private defaultOutput(level: LogLevel, ...message: string[]) {
    if (LogLevels[this.level] < LogLevels[level]) {
      return;
    }
    console.log(chalk.green(`[${dateFormat()}]`), ...message);
  }

  setLevel(level: LogLevel) {
    const types = ["error", "warn", "info", "silent", "debug", "trace"];
    if (!types.includes(level)) {
      this.error(`logLevel's value should be one of ${types}`);
    }
    this.level = level;
  }

  /**
   * print info level's log
   */
  info(msg: string) {
    this.output("info", chalk.bold.blue("INFO"), msg);
  }

  /**
   * print warn level's log
   */
  warn(msg: string) {
    this.output("warn", chalk.bold.yellow("WARN"), msg);
  }

  /**
   * print error level's log
   */
  error(msg: string) {
    this.output("error", chalk.bold.red("ERROR"), msg);
  }

  /**
   *  print debug level's log
   */
  debug(...info: any[]) {
    this.output("debug", chalk.bold.bgYellowBright("DEBUG"), ...info);
  }

  // ---------

  time(label: string) {
    this.timesMap.set(label, process.hrtime.bigint());
  }

  timeEnd(label: string) {
    const pervTime = this.timesMap.get(label);
    if (!pervTime) {
      throw Error(`No such label ${label}`);
    }
    const nowTime = process.hrtime.bigint();
    const duration = (nowTime - pervTime) / BigInt("1000000");
    this.timesMap.delete(label);
    this.info(`${label}: ${duration}ms`);
  }
}

export function createLogger(options: LoggerOptions) {
  return new Logger(options);
}

/**
 * export default logger instance.
 */
const defaultLogger = new Logger({ level: "info" });

if (process.env.DriverEnv === "dev") {
  console.log("use local develop env");
  defaultLogger.setLevel("debug");
}

export { defaultLogger };
