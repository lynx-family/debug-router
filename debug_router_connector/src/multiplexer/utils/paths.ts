// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import os from "os";
import path from "path";

export const DEBUG_ROUTER_CONNECTOR_DATA_DIR_NAME = ".DebugRouterConnector";
export const MULTIPLEXER_DATA_DIR_NAME = "multiplexer";
export const MULTIPLEXER_DISCOVERY_FILE_NAME = "daemon.json";
export const MULTIPLEXER_SPAWN_LOCK_NAME = "spawn.lock";
export const MULTIPLEXER_DAEMON_LOCK_NAME = "daemon.lock";

export type MultiplexerPathOptions = {
  rootDir?: string;
  dataDir?: string;
};

export type MultiplexerPaths = {
  rootDir: string;
  dataDir: string;
  discoveryPath: string;
  spawnLockPath: string;
  daemonLockPath: string;
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

export function getMultiplexerDiscoveryPath(
  options: MultiplexerPathOptions = {},
): string {
  return path.join(
    getMultiplexerDataDir(options),
    MULTIPLEXER_DISCOVERY_FILE_NAME,
  );
}

export function getMultiplexerSpawnLockPath(
  options: MultiplexerPathOptions = {},
): string {
  return path.join(getMultiplexerDataDir(options), MULTIPLEXER_SPAWN_LOCK_NAME);
}

export function getMultiplexerDaemonLockPath(
  options: MultiplexerPathOptions = {},
): string {
  return path.join(
    getMultiplexerDataDir(options),
    MULTIPLEXER_DAEMON_LOCK_NAME,
  );
}

export function createMultiplexerPaths(
  options: MultiplexerPathOptions = {},
): MultiplexerPaths {
  const rootDir = options.rootDir ?? getDefaultMultiplexerRootDir();
  const dataDir = getMultiplexerDataDir({ ...options, rootDir });

  return {
    rootDir,
    dataDir,
    discoveryPath: path.join(dataDir, MULTIPLEXER_DISCOVERY_FILE_NAME),
    spawnLockPath: path.join(dataDir, MULTIPLEXER_SPAWN_LOCK_NAME),
    daemonLockPath: path.join(dataDir, MULTIPLEXER_DAEMON_LOCK_NAME),
  };
}
