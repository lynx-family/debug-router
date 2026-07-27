// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

/**
 * Optional diagnostic context shared by Multiplexer protocol payloads.
 *
 * These fields are for troubleshooting only. They must not be used for
 * protocol negotiation or feature detection. Producers should omit
 * `debugInfo` unless diagnostic context was explicitly configured.
 */
export type MultiplexerDebugInfo = {
  protocolVersion?: number;
  clientVersion?: string;
  daemonVersion?: string;
  // PID of the process that generated this diagnostic context.
  processId?: number;
  // Unix timestamp in milliseconds when this diagnostic context was generated.
  timestamp?: number;
};
