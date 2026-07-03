// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {
  MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION,
  MULTIPLEXER_PROTOCOL_VERSION,
} from "../protocol";
import { defaultLogger } from "../../utils/logger";
import {
  DEFAULT_MULTIPLEXER_HEARTBEAT_INTERVAL,
  MultiplexerDaemon,
  MultiplexerDaemonHost,
  MultiplexerDaemonOption,
} from "./MultiplexerDaemon";
import type { PhysicalConnectorOption } from "../../physical/PhysicalConnector";
import { MultiplexerHost } from "./MultiplexerHost";

const ENTRY_CLEANUP_TIMEOUT = 3000;

export type MultiplexerDaemonEntryOption = {
  discoveryPath: string;
  daemonLockPath: string;
  protocolVersion: number;
  minSupportedProtocolVersion: number;
  controlPort: number;
  heartbeatInterval: number;
  daemonVersion?: string;
  capabilities?: string[];
  legacyDriverDir?: string;
  multiplexerDaemonIdleTimeout?: number;
  enableWebSocket?: boolean;
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

type RawEntryArgs = Partial<Record<EntryArgKey, string | true>>;

const OPTION_ALIASES: Record<string, EntryArgKey> = {
  "discovery-path": "discoveryPath",
  discoveryPath: "discoveryPath",
  "daemon-lock-path": "daemonLockPath",
  daemonLockPath: "daemonLockPath",
  "protocol-version": "protocolVersion",
  protocolVersion: "protocolVersion",
  "min-supported-protocol-version": "minSupportedProtocolVersion",
  minSupportedProtocolVersion: "minSupportedProtocolVersion",
  "control-port": "controlPort",
  controlPort: "controlPort",
  "heartbeat-interval": "heartbeatInterval",
  heartbeatInterval: "heartbeatInterval",
  "daemon-version": "daemonVersion",
  daemonVersion: "daemonVersion",
  capabilities: "capabilities",
  "legacy-driver-dir": "legacyDriverDir",
  legacyDriverDir: "legacyDriverDir",
  "multiplexer-daemon-idle-timeout": "multiplexerDaemonIdleTimeout",
  multiplexerDaemonIdleTimeout: "multiplexerDaemonIdleTimeout",
  "enable-websocket": "enableWebSocket",
  enableWebSocket: "enableWebSocket",
  "websocket-port": "websocketPort",
  websocketPort: "websocketPort",
  "websocket-room-id": "websocketRoomId",
  websocketRoomId: "websocketRoomId",
  "physical-connector-option": "physicalConnectorOption",
  physicalConnectorOption: "physicalConnectorOption",
};

export async function startMultiplexerDaemonEntry(
  argv: string[] = process.argv.slice(2),
): Promise<MultiplexerDaemon> {
  const entryOption = parseEntryOption(argv);
  const daemon = createMultiplexerDaemon(entryOption);

  registerProcessCleanup(daemon);
  await daemon.start();
  defaultLogger.info(
    `Multiplexer daemon started with discovery ${entryOption.discoveryPath}`,
  );

  return daemon;
}

export function createMultiplexerDaemon(
  entryOption: MultiplexerDaemonEntryOption,
): MultiplexerDaemon {
  const host = createEntryHost(entryOption);
  const exitAfterHostRequestedStop = (
    source: "idle" | "shutdown",
    stopError?: unknown,
  ) => {
    if (stopError) {
      defaultLogger.error(
        `Multiplexer daemon ${source} cleanup failed: ${
          (stopError as any)?.message
        }`,
      );
    }
    process.exit(stopError ? 1 : 0);
  };
  const daemonOption: MultiplexerDaemonOption = {
    discoveryPath: entryOption.discoveryPath,
    daemonLockPath: entryOption.daemonLockPath,
    protocolVersion: entryOption.protocolVersion,
    minSupportedProtocolVersion: entryOption.minSupportedProtocolVersion,
    daemonVersion: entryOption.daemonVersion,
    capabilities: entryOption.capabilities,
    heartbeatInterval: entryOption.heartbeatInterval,
    host,
    onIdleTimeout: (stopError) => {
      exitAfterHostRequestedStop("idle", stopError);
    },
    onShutdownRequest: (stopError) => {
      exitAfterHostRequestedStop("shutdown", stopError);
    },
  };
  if (entryOption.multiplexerDaemonIdleTimeout !== undefined) {
    daemonOption.hostOption = {
      multiplexerDaemonIdleTimeout: entryOption.multiplexerDaemonIdleTimeout,
    };
  }

  return new MultiplexerDaemon(daemonOption);
}

export function parseEntryOption(argv: string[]): MultiplexerDaemonEntryOption {
  const rawArgs = parseRawArgs(argv);
  const discoveryPath = getRequiredString(rawArgs, "discoveryPath");
  const daemonLockPath = getRequiredString(rawArgs, "daemonLockPath");
  const enableWebSocket = getOptionalBoolean(rawArgs, "enableWebSocket");
  const websocketOption = parseWebSocketOption(rawArgs);
  const physicalConnectorOption = parsePhysicalConnectorOption(rawArgs);

  const option: MultiplexerDaemonEntryOption = {
    discoveryPath,
    daemonLockPath,
    protocolVersion: getOptionalNumber(
      rawArgs,
      "protocolVersion",
      MULTIPLEXER_PROTOCOL_VERSION,
    ),
    minSupportedProtocolVersion: getOptionalNumber(
      rawArgs,
      "minSupportedProtocolVersion",
      MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION,
    ),
    controlPort: getOptionalNumber(rawArgs, "controlPort", 0),
    heartbeatInterval: getOptionalNumber(
      rawArgs,
      "heartbeatInterval",
      DEFAULT_MULTIPLEXER_HEARTBEAT_INTERVAL,
    ),
    daemonVersion: getOptionalString(rawArgs, "daemonVersion"),
    capabilities: parseCapabilities(getOptionalString(rawArgs, "capabilities")),
  };
  const legacyDriverDir = getOptionalString(rawArgs, "legacyDriverDir");
  if (legacyDriverDir !== undefined) {
    option.legacyDriverDir = legacyDriverDir;
  }
  const multiplexerDaemonIdleTimeout = getOptionalNumberOrUndefined(
    rawArgs,
    "multiplexerDaemonIdleTimeout",
  );
  if (multiplexerDaemonIdleTimeout !== undefined) {
    option.multiplexerDaemonIdleTimeout = multiplexerDaemonIdleTimeout;
  }
  if (enableWebSocket !== undefined) {
    option.enableWebSocket = enableWebSocket;
  }
  if (websocketOption !== undefined) {
    option.websocketOption = websocketOption;
  }
  if (physicalConnectorOption !== undefined) {
    option.physicalConnectorOption = physicalConnectorOption;
  }
  return option;
}

function createEntryHost(
  entryOption: MultiplexerDaemonEntryOption,
): MultiplexerDaemonHost {
  const hostOption = {
    controlPort: entryOption.controlPort,
    protocolVersion: entryOption.protocolVersion,
    minSupportedProtocolVersion: entryOption.minSupportedProtocolVersion,
    daemonVersion: entryOption.daemonVersion,
    capabilities: entryOption.capabilities,
  };
  if (entryOption.legacyDriverDir !== undefined) {
    Object.assign(hostOption, { legacyDriverDir: entryOption.legacyDriverDir });
  }
  if (entryOption.multiplexerDaemonIdleTimeout !== undefined) {
    Object.assign(hostOption, {
      multiplexerDaemonIdleTimeout: entryOption.multiplexerDaemonIdleTimeout,
    });
  }
  if (entryOption.enableWebSocket !== undefined) {
    Object.assign(hostOption, { enableWebSocket: entryOption.enableWebSocket });
  }
  if (entryOption.websocketOption !== undefined) {
    Object.assign(hostOption, { websocketOption: entryOption.websocketOption });
  }
  if (entryOption.physicalConnectorOption !== undefined) {
    Object.assign(hostOption, entryOption.physicalConnectorOption);
  }
  return new MultiplexerHost(hostOption);
}

function registerProcessCleanup(daemon: MultiplexerDaemon): void {
  let cleaning = false;

  const cleanup = async (exitCode: number, forceTimeout: boolean = false) => {
    if (cleaning) {
      return;
    }

    cleaning = true;
    try {
      const stopPromise = Promise.resolve(daemon.stop());
      await (forceTimeout
        ? withTimeout(stopPromise, ENTRY_CLEANUP_TIMEOUT)
        : stopPromise);
    } catch (error: any) {
      defaultLogger.error(
        `Multiplexer daemon cleanup failed: ${error?.message}`,
      );
      if (exitCode === 0) {
        process.exitCode = 1;
      }
    }
  };
  const cleanupAndExit = (exitCode: number) => {
    void cleanup(exitCode, true).finally(() => process.exit(exitCode));
  };

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

function withTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`Multiplexer daemon cleanup timed out after ${timeout}ms`),
      );
    }, timeout);
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseRawArgs(argv: string[]): RawEntryArgs {
  const rawArgs: RawEntryArgs = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected multiplexer daemon argument: ${arg}`);
    }

    const optionText = arg.slice(2);
    const equalsIndex = optionText.indexOf("=");
    const rawKey =
      equalsIndex >= 0 ? optionText.slice(0, equalsIndex) : optionText;
    const key = OPTION_ALIASES[rawKey];
    if (!key) {
      throw new Error(`Unknown multiplexer daemon option: ${rawKey}`);
    }

    if (equalsIndex >= 0) {
      rawArgs[key] = optionText.slice(equalsIndex + 1);
      continue;
    }

    const nextArg = argv[index + 1];
    if (!nextArg || nextArg.startsWith("--")) {
      rawArgs[key] = true;
      continue;
    }

    rawArgs[key] = nextArg;
    index++;
  }

  return rawArgs;
}

function getRequiredString(
  rawArgs: RawEntryArgs,
  key: keyof MultiplexerDaemonEntryOption,
): string {
  const value = rawArgs[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required multiplexer daemon option: ${key}`);
  }

  return value;
}

function getOptionalString(
  rawArgs: RawEntryArgs,
  key: keyof MultiplexerDaemonEntryOption,
): string | undefined {
  const value = rawArgs[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getOptionalNumber(
  rawArgs: RawEntryArgs,
  key: keyof MultiplexerDaemonEntryOption,
  defaultValue: number,
): number {
  const value = rawArgs[key];
  if (value === undefined) {
    return defaultValue;
  }

  const numberValue = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numberValue)) {
    throw new Error(`Invalid multiplexer daemon option ${key}: ${value}`);
  }

  return numberValue;
}

function getOptionalNumberOrUndefined(
  rawArgs: RawEntryArgs,
  key: keyof MultiplexerDaemonEntryOption,
): number | undefined {
  const value = rawArgs[key];
  if (value === undefined) {
    return undefined;
  }

  const numberValue = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw new Error(`Invalid multiplexer daemon option ${key}: ${value}`);
  }

  return numberValue;
}

function getOptionalBoolean(
  rawArgs: RawEntryArgs,
  key: keyof MultiplexerDaemonEntryOption,
): boolean | undefined {
  const value = rawArgs[key];
  if (value === undefined) {
    return undefined;
  }

  if (value === true) {
    return true;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`Invalid multiplexer daemon option ${key}: ${value}`);
}

function parseWebSocketOption(
  rawArgs: RawEntryArgs,
): MultiplexerDaemonEntryOption["websocketOption"] {
  const option: MultiplexerDaemonEntryOption["websocketOption"] = {};
  const port = rawArgs.websocketPort;
  if (port !== undefined) {
    const numberValue = typeof port === "string" ? Number(port) : Number.NaN;
    if (!Number.isFinite(numberValue)) {
      throw new Error(
        `Invalid multiplexer daemon option websocketPort: ${port}`,
      );
    }
    option.port = numberValue;
  }

  const roomId = rawArgs.websocketRoomId;
  if (typeof roomId === "string" && roomId.length > 0) {
    option.roomId = roomId;
  }

  return option.port === undefined && option.roomId === undefined
    ? undefined
    : option;
}

function parseCapabilities(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split(",")
    .map((capability) => capability.trim())
    .filter(Boolean);
}

function parsePhysicalConnectorOption(
  rawArgs: RawEntryArgs,
): PhysicalConnectorOption | undefined {
  const value = rawArgs.physicalConnectorOption;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Invalid multiplexer daemon option physicalConnectorOption: ${value}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: any) {
    throw new Error(
      `Invalid multiplexer daemon option physicalConnectorOption: ${error?.message}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Invalid multiplexer daemon option physicalConnectorOption: expected object",
    );
  }

  return parsed as PhysicalConnectorOption;
}

if (require.main === module) {
  startMultiplexerDaemonEntry().catch((error: any) => {
    defaultLogger.error(
      `Multiplexer daemon failed to start: ${error?.message}`,
    );
    process.exit(1);
  });
}
