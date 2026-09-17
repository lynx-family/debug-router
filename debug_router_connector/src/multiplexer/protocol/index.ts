// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export type {
  ControlRpcError,
  ControlRpcMethod,
  ControlRpcParams,
  ControlRpcRequest,
  ControlRpcResponse,
  ControlRpcResult,
  MultiplexerHealthRequest,
  MultiplexerHealthResponse,
  MultiplexerHandshakeErrorResponse,
  MultiplexerRegisterRequest,
  MultiplexerRegisterResponse,
  WebSocketServerInfo,
} from "./control";
export type { MultiplexerDebugInfo } from "./debuginfo";
export { MULTIPLEXER_PROTOCOL_VERSION } from "./control";
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
  isMultiplexerDebugInfo,
  isControlRpcMethod,
  isControlRpcParams,
  isControlRpcRequest,
  isControlRpcResponse,
  isDeviceSnapshot,
  isMultiplexerHealthRequest,
  isMultiplexerHealthResponse,
  isMultiplexerHandshakeErrorResponse,
  isMultiplexerRegisterRequest,
  isMultiplexerRegisterResponse,
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
