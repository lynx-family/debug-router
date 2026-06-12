// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export const MULTIPLEXER_PROTOCOL_VERSION = 1;
export const MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION = 1;
export const MULTIPLEXER_HEALTH_PATH = "/health";
export const MULTIPLEXER_CONTROL_PATH = "/debug-router-multiplexer/control";

export type MultiplexerDiscoveryInfo = {
  pid: number;
  protocolVersion: number;
  minSupportedProtocolVersion?: number;
  controlPort: number;
  heartbeat: number;
  startedAt?: number;
  daemonVersion?: string;
  capabilities?: string[];
};

export type MultiplexerHealthResponse = {
  ok: true;
  pid: number;
  protocolVersion: number;
  minSupportedProtocolVersion?: number;
  heartbeat: number;
  daemonVersion?: string;
  capabilities?: string[];
};
