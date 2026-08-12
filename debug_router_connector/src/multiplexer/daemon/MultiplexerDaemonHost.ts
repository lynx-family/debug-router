// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { MultiplexerDebugInfo } from "../protocol";
import type { PhysicalConnectorOption } from "../../physical/PhysicalConnector";

export type MultiplexerDaemonHostOption = {
  controlEndpoint: string;
  protocolVersion: number;
  debugInfo?: MultiplexerDebugInfo;
  physicalConnectorOption?: PhysicalConnectorOption;
};

export class MultiplexerDaemonHost {
  constructor(_option: MultiplexerDaemonHostOption) {}

  start(): void {}

  stop(): void {}

  setIdleTimeoutHandler(_handler: () => void | Promise<void>): void {}

  setShutdownHandler(_handler: () => void | Promise<void>): void {}
}
