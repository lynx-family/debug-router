// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import os from "os";
import path from "path";

export const DEBUG_ROUTER_CONNECTOR_DATA_DIR_NAME = ".DebugRouterConnector";
export const MULTIPLEXER_DATA_DIR_NAME = "multiplexer";

export const MULTIPLEXER_CONTROL_SOCKET_NAME = "control.sock";

export type MultiplexerPathOptions = {
  // Overrides the base DebugRouter connector data directory.
  rootDir?: string;
  // Overrides the full multiplexer data directory and takes precedence over rootDir.
  dataDir?: string;
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
