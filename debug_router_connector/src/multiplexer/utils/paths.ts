// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import os from "os";
import path from "path";

export const DEBUG_ROUTER_CONNECTOR_DATA_DIR_NAME = ".DebugRouterConnector";
export const MULTIPLEXER_DATA_DIR_NAME = "multiplexer";

export const MULTIPLEXER_SPAWN_LOCK_NAME = "spawn.lock";
export const MULTIPLEXER_CONTROL_SOCKET_NAME = "control.sock";
export const MULTIPLEXER_DAEMON_PROCESS_NAME_SUFFIX = "muxDaemon";

export type MultiplexerPathOptions = {
  // Overrides the base DebugRouter connector data directory.
  rootDir?: string;
  // Overrides the full multiplexer data directory and takes precedence over rootDir.
  dataDir?: string;
};

export type MultiplexerPaths = {
  rootDir: string;
  dataDir: string;
  controlEndpoint: string;
  spawnLockPath: string;
  daemonProcessName: string;
};

export function getDefaultMultiplexerRootDir(): string {
  return path.join(os.homedir(), DEBUG_ROUTER_CONNECTOR_DATA_DIR_NAME);
}

export function getMultiplexerDataDir(
  options: MultiplexerPathOptions = {},
): string {
  if (options.dataDir) {
    return options.dataDir;
  }

  return path.join(
    options.rootDir ?? getDefaultMultiplexerRootDir(),
    MULTIPLEXER_DATA_DIR_NAME,
  );
}

export function getMultiplexerSpawnLockPath(
  options: MultiplexerPathOptions = {},
): string {
  return path.join(getMultiplexerDataDir(options), MULTIPLEXER_SPAWN_LOCK_NAME);
}

export function getMultiplexerControlEndpoint(
  options: MultiplexerPathOptions = {},
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\${getMultiplexerDataDir(options)}`;
  }

  return path.join(
    getMultiplexerDataDir(options),
    MULTIPLEXER_CONTROL_SOCKET_NAME,
  );
}

export function getMultiplexerDaemonProcessName(dataDir: string): string {
  const sanitizedDataDir = dataDir
    .replace(/\//g, "-")
    .replace(/[^A-Za-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
  return `${sanitizedDataDir}-${MULTIPLEXER_DAEMON_PROCESS_NAME_SUFFIX}`;
}

export function createMultiplexerPaths(
  options: MultiplexerPathOptions = {},
): MultiplexerPaths {
  const rootDir = options.rootDir ?? getDefaultMultiplexerRootDir();
  const dataDir = getMultiplexerDataDir({ ...options, rootDir });

  return {
    rootDir,
    dataDir,
    controlEndpoint: getMultiplexerControlEndpoint({ dataDir }),
    spawnLockPath: path.join(dataDir, MULTIPLEXER_SPAWN_LOCK_NAME),
    daemonProcessName: getMultiplexerDaemonProcessName(dataDir),
  };
}
