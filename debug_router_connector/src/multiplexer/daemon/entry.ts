// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { MultiplexerDebugInfo } from "../protocol";
import { defaultLogger } from "../../utils/logger";
import type { PhysicalConnectorOption } from "../../physical/PhysicalConnector";
import { setDriverReportService } from "../../report/interface/DriverReportService";
import { DriverReportServiceImpl } from "../../report/interface/DriverReportServiceImpl";
import type { ConnectionTraceOptions } from "../../trace/ConnectionTraceRecorder";
import { setTimeout } from "timers/promises";
import { MultiplexerDaemonHost } from "./MultiplexerDaemonHost";
import type { MultiplexerDaemonHostOption } from "./MultiplexerDaemonHost";

const ENTRY_CLEANUP_TIMEOUT = 3000;

export type MultiplexerDaemonEntryOption = {
  controlEndpoint: string;
  protocolVersion: number;
  multiplexerDaemonIdleTimeout: number;
  debugInfo?: MultiplexerDebugInfo;
  legacyDriverDir?: string;
  enableWebSocket?: boolean;
  connectionTrace?: ConnectionTraceOptions;
  websocketOption?: {
    port?: number;
    roomId?: string;
  };
  physicalConnectorOption?: PhysicalConnectorOption;
};

type EntryArgKey =
  | keyof MultiplexerDaemonEntryOption
  | "websocketPort"
  | "websocketRoomId";

type RawEntryArgs = Partial<Record<EntryArgKey, string>>;

const OPTION_KEY_MAP: Record<string, EntryArgKey | undefined> = {
  "control-endpoint": "controlEndpoint",
  "protocol-version": "protocolVersion",
  "debug-info": "debugInfo",
  "legacy-driver-dir": "legacyDriverDir",
  "multiplexer-daemon-idle-timeout": "multiplexerDaemonIdleTimeout",
  "enable-websocket": "enableWebSocket",
  "connection-trace": "connectionTrace",
  "websocket-port": "websocketPort",
  "websocket-room-id": "websocketRoomId",
  "physical-connector-option": "physicalConnectorOption",
};

export async function startMultiplexerDaemonEntry(
  argv: string[] = process.argv.slice(2),
): Promise<MultiplexerDaemonHost> {
  const entryOption = parseEntryOption(argv);
  const host = createDaemonHost(entryOption);

  registerProcessCleanup(host);
  await host.start();
  defaultLogger.info(
    `Multiplexer daemon started with control endpoint ${entryOption.controlEndpoint}`,
  );

  return host;
}

export function parseEntryOption(argv: string[]): MultiplexerDaemonEntryOption {
  const rawArgs = parseRawArgs(argv);
  const option: MultiplexerDaemonEntryOption = {
    controlEndpoint: getRequiredArg(rawArgs, "controlEndpoint"),
    protocolVersion: Number(getRequiredArg(rawArgs, "protocolVersion")),
    multiplexerDaemonIdleTimeout: Number(
      getRequiredArg(rawArgs, "multiplexerDaemonIdleTimeout"),
    ),
  };
  if (rawArgs.debugInfo !== undefined) {
    option.debugInfo = JSON.parse(rawArgs.debugInfo) as MultiplexerDebugInfo;
  }
  if (rawArgs.legacyDriverDir !== undefined) {
    option.legacyDriverDir = rawArgs.legacyDriverDir;
  }
  if (rawArgs.enableWebSocket !== undefined) {
    option.enableWebSocket = rawArgs.enableWebSocket === "true";
  }
  if (rawArgs.connectionTrace !== undefined) {
    option.connectionTrace = JSON.parse(
      rawArgs.connectionTrace,
    ) as ConnectionTraceOptions;
  }
  if (
    rawArgs.websocketPort !== undefined ||
    rawArgs.websocketRoomId !== undefined
  ) {
    option.websocketOption = {
      ...(rawArgs.websocketPort !== undefined
        ? { port: Number(rawArgs.websocketPort) }
        : {}),
      ...(rawArgs.websocketRoomId !== undefined
        ? { roomId: rawArgs.websocketRoomId }
        : {}),
    };
  }
  if (rawArgs.physicalConnectorOption !== undefined) {
    option.physicalConnectorOption = JSON.parse(
      rawArgs.physicalConnectorOption,
    ) as PhysicalConnectorOption;
  }
  return option;
}

function createDaemonHost(
  entryOption: MultiplexerDaemonEntryOption,
): MultiplexerDaemonHost {
  const reportService = new DriverReportServiceImpl();
  setDriverReportService(reportService);
  const hostOption: MultiplexerDaemonHostOption = {
    controlEndpoint: entryOption.controlEndpoint,
    protocolVersion: entryOption.protocolVersion,
    multiplexerDaemonIdleTimeout: entryOption.multiplexerDaemonIdleTimeout,
    ...(entryOption.debugInfo ? { debugInfo: entryOption.debugInfo } : {}),
  };
  if (entryOption.legacyDriverDir !== undefined) {
    Object.assign(hostOption, { legacyDriverDir: entryOption.legacyDriverDir });
  }
  if (entryOption.enableWebSocket !== undefined) {
    Object.assign(hostOption, { enableWebSocket: entryOption.enableWebSocket });
  }
  if (entryOption.connectionTrace !== undefined) {
    Object.assign(hostOption, { connectionTrace: entryOption.connectionTrace });
  }
  if (entryOption.websocketOption !== undefined) {
    Object.assign(hostOption, { websocketOption: entryOption.websocketOption });
  }
  if (entryOption.physicalConnectorOption !== undefined) {
    hostOption.physicalConnectorOption = entryOption.physicalConnectorOption;
  }
  return new MultiplexerDaemonHost(hostOption);
}

function registerProcessCleanup(host: MultiplexerDaemonHost): void {
  let cleanupPromise: Promise<unknown> | undefined;

  const cleanup = (
    exitCode: number,
    forceTimeout: boolean = false,
    source?: "idle" | "shutdown",
  ): Promise<unknown> => {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    cleanupPromise = (async () => {
      try {
        const stopPromise = Promise.resolve(host.stop());
        if (forceTimeout) {
          await Promise.race([
            stopPromise,
            setTimeout(ENTRY_CLEANUP_TIMEOUT).then(() => {
              throw new Error(
                `Multiplexer daemon cleanup timed out after ${ENTRY_CLEANUP_TIMEOUT}ms`,
              );
            }),
          ]);
        } else {
          await stopPromise;
        }
        return undefined;
      } catch (error: any) {
        defaultLogger.error(
          source
            ? `Multiplexer daemon ${source} cleanup failed: ${error?.message}`
            : `Multiplexer daemon cleanup failed: ${error?.message}`,
        );
        if (exitCode === 0) {
          process.exitCode = 1;
        }
        return error;
      }
    })();
    return cleanupPromise;
  };
  const cleanupAfterHostRequest = async (source: "idle" | "shutdown") => {
    const stopError = await cleanup(0, false, source);
    process.exit(stopError ? 1 : 0);
  };
  const cleanupAndExit = (exitCode: number) => {
    void cleanup(exitCode, true).finally(() => process.exit(exitCode));
  };

  host.setIdleTimeoutHandler(() => cleanupAfterHostRequest("idle"));
  host.setShutdownHandler(() => cleanupAfterHostRequest("shutdown"));

  process.once("beforeExit", () => {
    void cleanup(process.exitCode ?? 0);
  });
  process.once("SIGINT", () => {
    cleanupAndExit(130);
  });
  process.once("SIGTERM", () => {
    cleanupAndExit(143);
  });
  process.once("uncaughtException", (error) => {
    defaultLogger.error(
      `Multiplexer daemon uncaught exception: ${error.message}`,
    );
    cleanupAndExit(1);
  });
  process.once("unhandledRejection", (reason) => {
    defaultLogger.error(`Multiplexer daemon unhandled rejection: ${reason}`);
    cleanupAndExit(1);
  });
}

function parseRawArgs(argv: string[]): RawEntryArgs {
  const rawArgs: RawEntryArgs = {};

  for (let index = 0; index < argv.length; index += 2) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected multiplexer daemon argument: ${arg}`);
    }

    const rawKey = arg.slice(2);
    const key = OPTION_KEY_MAP[rawKey];
    if (!key) {
      throw new Error(`Unknown multiplexer daemon option: ${rawKey}`);
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for multiplexer daemon option: ${rawKey}`);
    }
    rawArgs[key] = value;
  }

  return rawArgs;
}

function getRequiredArg(
  rawArgs: RawEntryArgs,
  key: keyof MultiplexerDaemonEntryOption,
): string {
  const value = rawArgs[key];
  if (value === undefined) {
    throw new Error(`Missing required multiplexer daemon option: ${key}`);
  }
  return value;
}

if (require.main === module) {
  startMultiplexerDaemonEntry().catch((error: any) => {
    defaultLogger.error(
      `Multiplexer daemon failed to start: ${error?.message}`,
    );
    process.exit(1);
  });
}
