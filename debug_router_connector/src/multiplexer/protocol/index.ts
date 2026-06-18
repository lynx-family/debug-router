// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export type {
  ControlMessageMeta,
  ControlRpcError,
  ControlRpcMethod,
  ControlRpcParams,
  ControlRpcRequest,
  ControlRpcResponse,
  ControlRpcResult,
  WebSocketServerInfo,
} from "./control";
export {
  MULTIPLEXER_CONTROL_PATH,
  MULTIPLEXER_HEALTH_PATH,
  MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION,
  MULTIPLEXER_PROTOCOL_VERSION,
} from "./discovery";
export type {
  MultiplexerDiscoveryInfo,
  MultiplexerHealthResponse,
} from "./discovery";
export type { ControlEvent, ControlEventEnvelope } from "./event";
export type {
  ClientSnapshot,
  DeviceSnapshot,
  Snapshot,
  WebSocketClientSnapshot,
} from "./snapshot";
export {
  isBoolean,
  isClientSnapshot,
  isControlEvent,
  isControlMessageMeta,
  isControlRpcMethod,
  isControlRpcRequest,
  isControlRpcResponse,
  isDeviceSnapshot,
  isMultiplexerDiscoveryInfo,
  isMultiplexerHealthResponse,
  isNumber,
  isNumberArray,
  isRecord,
  isSnapshot,
  isString,
  isStringArray,
  isWebSocketClientSnapshot,
  parseJsonObject,
  parseJsonValue,
} from "./validation";
