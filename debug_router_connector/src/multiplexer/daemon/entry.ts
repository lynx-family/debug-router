// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { MULTIPLEXER_PROTOCOL_VERSION } from "../protocol";
import { defaultLogger } from "../../utils/logger";
import {
  DEFAULT_MULTIPLEXER_HEARTBEAT_INTERVAL,
  MultiplexerDaemon,
  MultiplexerDaemonHost,
  MultiplexerDaemonOption,
} from "./MultiplexerDaemon";

export type MultiplexerDaemonEntryOption = {
  discoveryPath: string;
  daemonLockPath: string;
  protocolVersion: number;
  controlPort: number;
  heartbeatInterval: number;
  daemonVersion?: string;
  capabilities?: string[];
};

type RawEntryArgs = Record<string, string | true>;

const OPTION_ALIASES: Record<string, keyof MultiplexerDaemonEntryOption> = {
  "discovery-path": "discoveryPath",
  discoveryPath: "discoveryPath",
  "daemon-lock-path": "daemonLockPath",
  daemonLockPath: "daemonLockPath",
  "protocol-version": "protocolVersion",
  protocolVersion: "protocolVersion",
  "control-port": "controlPort",
  controlPort: "controlPort",
  "heartbeat-interval": "heartbeatInterval",
  heartbeatInterval: "heartbeatInterval",
  "daemon-version": "daemonVersion",
  daemonVersion: "daemonVersion",
  capabilities: "capabilities",
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
  const host = createEntryHost(entryOption.controlPort);
  const daemonOption: MultiplexerDaemonOption = {
    discoveryPath: entryOption.discoveryPath,
    daemonLockPath: entryOption.daemonLockPath,
    protocolVersion: entryOption.protocolVersion,
    daemonVersion: entryOption.daemonVersion,
    capabilities: entryOption.capabilities,
    heartbeatInterval: entryOption.heartbeatInterval,
    host,
  };

  return new MultiplexerDaemon(daemonOption);
}

export function parseEntryOption(
  argv: string[],
): MultiplexerDaemonEntryOption {
  const rawArgs = parseRawArgs(argv);
  const discoveryPath = getRequiredString(rawArgs, "discoveryPath");
  const daemonLockPath = getRequiredString(rawArgs, "daemonLockPath");

  return {
    discoveryPath,
    daemonLockPath,
    protocolVersion: getOptionalNumber(
      rawArgs,
      "protocolVersion",
      MULTIPLEXER_PROTOCOL_VERSION,
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
}

function createEntryHost(controlPort: number): MultiplexerDaemonHost {
  return {
    start: () => {},
    stop: () => {},
    getControlPort: () => controlPort,
  };
}

function registerProcessCleanup(daemon: MultiplexerDaemon): void {
  let cleaning = false;

  const cleanup = async (exitCode: number) => {
    if (cleaning) {
      return;
    }

    cleaning = true;
    try {
      await daemon.stop();
    } catch (error: any) {
      defaultLogger.error(`Multiplexer daemon cleanup failed: ${error?.message}`);
      if (exitCode === 0) {
        process.exitCode = 1;
      }
    }
  };

  process.once("beforeExit", () => {
    void cleanup(process.exitCode ?? 0);
  });
  process.once("SIGINT", () => {
    void cleanup(130).finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void cleanup(143).finally(() => process.exit(143));
  });
  process.once("uncaughtException", (error) => {
    defaultLogger.error(`Multiplexer daemon uncaught exception: ${error.message}`);
    void cleanup(1).finally(() => process.exit(1));
  });
  process.once("unhandledRejection", (reason) => {
    defaultLogger.error(`Multiplexer daemon unhandled rejection: ${reason}`);
    void cleanup(1).finally(() => process.exit(1));
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

function parseCapabilities(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split(",")
    .map((capability) => capability.trim())
    .filter(Boolean);
}

if (require.main === module) {
  startMultiplexerDaemonEntry().catch((error: any) => {
    defaultLogger.error(`Multiplexer daemon failed to start: ${error?.message}`);
    process.exit(1);
  });
}
