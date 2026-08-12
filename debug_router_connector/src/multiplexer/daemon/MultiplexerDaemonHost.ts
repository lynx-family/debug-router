// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { MultiplexerDebugInfo } from "../protocol";
import type {
  PhysicalConnector,
  PhysicalConnectorOption,
} from "../../physical/PhysicalConnector";
import type { ConnectionTraceOptions } from "../../trace/ConnectionTraceRecorder";

export type MultiplexerDaemonHostOption = {
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
  memoizedNotificationTtlMs?: number;

  // only used for tests or embedding
  physicalConnector?: PhysicalConnector;
  now?: () => number;
};

export class MultiplexerDaemonHost {
  constructor(_option: MultiplexerDaemonHostOption) {}

  start(): void {}

  stop(): void {}

  setIdleTimeoutHandler(_handler: () => void | Promise<void>): void {}

  setShutdownHandler(_handler: () => void | Promise<void>): void {}
}
