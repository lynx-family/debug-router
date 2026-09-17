// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type {
  ControlRpcError,
  ControlRpcMethod,
  ControlRpcRequest,
  ControlRpcResponse,
  MultiplexerHandshakeErrorResponse,
  MultiplexerHealthRequest,
  MultiplexerHealthResponse,
  MultiplexerRegisterRequest,
  MultiplexerRegisterResponse,
} from "./control";
import type { MultiplexerDebugInfo } from "./debuginfo";
import type { ControlEvent } from "./event";
import type {
  ClientSnapshot,
  DeviceSnapshot,
  Snapshot,
  WebSocketClientSnapshot,
} from "./snapshot";

type JsonRecord = Record<string, unknown>;

const CONTROL_RPC_METHODS: ControlRpcMethod[] = [
  "connectDevices",
  "connectUsbClients",
  "startDeviceClientWatcher",
  "stopDeviceClientWatcher",
  "disconnectDevice",
  "shutdownDaemon",
  "startWSServer",
  "startAllDeviceClientWatchers",
  "stopAllDeviceClientWatchers",
  "sendMessageWithReply",
  "sendMessageWithoutReply",
  "closeClient",
];

export function parseJsonValue(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

export function parseJsonObject(text: string): JsonRecord | null {
  const value = parseJsonValue(text);
  return isRecord(value) ? value : null;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNumber);
}

export function isControlRpcMethod(value: unknown): value is ControlRpcMethod {
  return (
    isString(value) && CONTROL_RPC_METHODS.includes(value as ControlRpcMethod)
  );
}

export function isMultiplexerDebugInfo(
  value: unknown,
): value is MultiplexerDebugInfo {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isOptional(value.protocolVersion, isNumber) &&
    isOptional(value.clientVersion, isString) &&
    isOptional(value.daemonVersion, isString) &&
    isOptional(value.processId, isNumber) &&
    isOptional(value.timestamp, isNumber)
  );
}

export function isDeviceSnapshot(value: unknown): value is DeviceSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.os) &&
    isString(value.title) &&
    isString(value.serial) &&
    isOptional(value.ports, isNumberArray) &&
    isOptional(value.host, isString)
  );
}

export function isClientSnapshot(value: unknown): value is ClientSnapshot {
  if (!isRecord(value) || !isNumber(value.port) || !isNumber(value.id)) {
    return false;
  }

  const query = value.query;
  return (
    isRecord(query) &&
    isString(query.app) &&
    isString(query.os) &&
    isString(query.device) &&
    isString(query.device_model) &&
    isString(query.device_id) &&
    isOptional(query.sdk_version, isString)
  );
}

export function isWebSocketClientSnapshot(
  value: unknown,
): value is WebSocketClientSnapshot {
  return (
    isRecord(value) &&
    isNumber(value.id) &&
    isString(value.app) &&
    isString(value.debugRouterVersion) &&
    isString(value.deviceModel) &&
    value.network === "WiFi" &&
    isString(value.osVersion) &&
    isString(value.sdkVersion) &&
    isString(value.type) &&
    hasOwn(value, "raw_info")
  );
}

function isWebSocketClientSnapshotArray(
  value: unknown,
): value is WebSocketClientSnapshot[] {
  return Array.isArray(value) && value.every(isWebSocketClientSnapshot);
}

export function isSnapshot(value: unknown): value is Snapshot {
  return (
    isRecord(value) &&
    isNumber(value.protocolVersion) &&
    isNumber(value.generatedAt) &&
    Array.isArray(value.devices) &&
    value.devices.every(isDeviceSnapshot) &&
    Array.isArray(value.clients) &&
    value.clients.every(isClientSnapshot) &&
    isOptional(value.websocketAppClients, isWebSocketClientSnapshotArray) &&
    isOptional(value.websocketWebClients, isWebSocketClientSnapshotArray) &&
    isOptional(value.debugInfo, isMultiplexerDebugInfo)
  );
}

export function isMultiplexerHealthRequest(
  value: unknown,
): value is MultiplexerHealthRequest {
  return (
    isRecord(value) &&
    value.kind === "health" &&
    isOptional(value.debugInfo, isMultiplexerDebugInfo)
  );
}

export function isMultiplexerHealthResponse(
  value: unknown,
): value is MultiplexerHealthResponse {
  return (
    isRecord(value) &&
    value.kind === "health-response" &&
    value.ok === true &&
    isNumber(value.protocolVersion) &&
    isBoolean(value.isInUse) &&
    isOptional(value.debugInfo, isMultiplexerDebugInfo)
  );
}

export function isMultiplexerHandshakeErrorResponse(
  value: unknown,
): value is MultiplexerHandshakeErrorResponse {
  return (
    isRecord(value) &&
    value.kind === "handshake-error-response" &&
    isControlRpcError(value.error)
  );
}

export function isMultiplexerRegisterRequest(
  value: unknown,
): value is MultiplexerRegisterRequest {
  return (
    isRecord(value) &&
    value.kind === "register" &&
    isOptional(value.debugInfo, isMultiplexerDebugInfo)
  );
}

export function isMultiplexerRegisterResponse(
  value: unknown,
): value is MultiplexerRegisterResponse {
  return (
    isRecord(value) && value.kind === "register-response" && value.ok === true
  );
}

export function isControlRpcRequest(
  value: unknown,
): value is ControlRpcRequest {
  if (
    !isRecord(value) ||
    value.kind !== "rpc" ||
    !isNumber(value.id) ||
    !isControlRpcMethod(value.method) ||
    !isOptional(value.debugInfo, isMultiplexerDebugInfo)
  ) {
    return false;
  }

  return isControlRpcParams(value.method, value.params);
}

export function isControlRpcResponse(
  value: unknown,
  method?: ControlRpcMethod,
): value is ControlRpcResponse {
  if (
    !isRecord(value) ||
    value.kind !== "rpc-response" ||
    !isNumber(value.id) ||
    !isBoolean(value.ok) ||
    !isOptional(value.debugInfo, isMultiplexerDebugInfo)
  ) {
    return false;
  }

  if (value.ok) {
    return isControlRpcResult(method, value.result);
  }

  return isControlRpcError(value.error);
}

export function isControlEvent(value: unknown): value is ControlEvent {
  if (
    !isRecord(value) ||
    value.kind !== "event" ||
    !isString(value.event) ||
    !isOptional(value.debugInfo, isMultiplexerDebugInfo)
  ) {
    return false;
  }

  switch (value.event) {
    case "snapshot":
      return isSnapshot(value.data);
    case "legacy-ownership-changed":
      return isLegacyOwnershipChangedEventData(value.data);
    case "client-message":
      return (
        isRecord(value.data) &&
        (value.data.source === "usb-runtime" ||
          value.data.source === "websocket-runtime" ||
          value.data.source === "websocket-driver") &&
        isNumber(value.data.id) &&
        isString(value.data.message)
      );
    default:
      return false;
  }
}

export function isControlRpcParams(
  method: ControlRpcMethod,
  params: unknown,
): boolean {
  if (!isRecord(params)) {
    return false;
  }

  switch (method) {
    case "connectDevices":
      return (
        isOptional(params.timeout, isNumber) &&
        isOptionalStringOrNull(params.serial) &&
        isOptional(params.isAutoListenClients, isBoolean)
      );
    case "connectUsbClients":
      return (
        isString(params.deviceId) &&
        isOptional(params.timeout, isNumber) &&
        isOptional(params.waitTimeout, isBoolean) &&
        isOptionalStringOrNull(params.clientName)
      );
    case "startDeviceClientWatcher":
    case "stopDeviceClientWatcher":
      return (
        isString(params.deviceId) &&
        params.deviceId.length > 0 &&
        Object.keys(params).length === 1
      );
    case "disconnectDevice":
      return isString(params.deviceId);
    case "shutdownDaemon":
      return isOptional(params.reason, isString);
    case "startWSServer":
      return Object.keys(params).length === 0;
    case "startAllDeviceClientWatchers":
      return Object.keys(params).length === 0;
    case "stopAllDeviceClientWatchers":
      return Object.keys(params).length === 0;
    case "sendMessageWithReply":
      return isNumber(params.clientId) && isRequireMessage(params.message);
    case "sendMessageWithoutReply":
      return (
        (params.target === "app" || params.target === "web") &&
        isNumber(params.clientId) &&
        !(params.target === "app" && params.clientId === -1) &&
        hasOwn(params, "message")
      );
    case "closeClient":
      return isNumber(params.clientId);
    default:
      return false;
  }
}

function isControlRpcResult(
  method: ControlRpcMethod | undefined,
  result: unknown,
): boolean {
  if (!method) {
    return true;
  }

  switch (method) {
    case "connectDevices":
      return Array.isArray(result) && result.every(isDeviceSnapshot);
    case "connectUsbClients":
      return Array.isArray(result) && result.every(isClientSnapshot);
    case "sendMessageWithReply":
      return isResponseMessage(result);
    case "startWSServer":
      return isWebSocketServerInfo(result);
    case "startDeviceClientWatcher":
    case "stopDeviceClientWatcher":
    case "startAllDeviceClientWatchers":
    case "stopAllDeviceClientWatchers":
    case "disconnectDevice":
    case "shutdownDaemon":
    case "sendMessageWithoutReply":
    case "closeClient":
      return isEmptyRecord(result);
    default:
      return false;
  }
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isLegacyOwnershipChangedEventData(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.status === "attached" || value.status === "unattached") &&
    isNumber(value.ownerPid) &&
    isOptional(value.previousOwnerPid, isNumber) &&
    (value.reason === "daemon-started" ||
      value.reason === "legacy-preempted" ||
      value.reason === "reacquire-requested" ||
      value.reason === "stale-owner" ||
      value.reason === "invalid-owner")
  );
}

function isWebSocketServerInfo(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.port) &&
    isString(value.host) &&
    isOptional(value.roomId, isString)
  );
}

function isControlRpcError(value: unknown): value is ControlRpcError {
  return isRecord(value) && isString(value.code) && isString(value.message);
}

function isRequireMessage(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.event)) {
    return false;
  }

  if (value.event === "Initialize") {
    return isNumber(value.data);
  }

  if (value.event !== "Customized" || !isRecord(value.data)) {
    return false;
  }

  const data = value.data;
  const payload = data.data;
  return (
    isString(data.type) &&
    isRecord(payload) &&
    isNumber(payload.client_id) &&
    isNumber(payload.session_id) &&
    hasOwn(payload, "message") &&
    isNumber(data.sender)
  );
}

function isResponseMessage(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.event)) {
    return false;
  }

  if (value.event === "Register") {
    const data = value.data;
    return (
      isRecord(data) &&
      isNumber(data.id) &&
      isRecord(data.info) &&
      isOptional(data.info.app, isString) &&
      isOptional(data.info.appVersion, isString) &&
      isOptional(data.info.deviceModel, isString) &&
      isOptional(data.info.network, isString) &&
      isOptional(data.info.osVersion, isString) &&
      isOptional(data.info.sdkVersion, isString)
    );
  }

  return value.event === "Customized" && hasOwn(value, "data");
}

function isOptional<T>(
  value: unknown,
  guard: (value: unknown) => value is T,
): value is T | undefined {
  return value === undefined || guard(value);
}

function isOptionalStringOrNull(value: unknown): boolean {
  return value === undefined || value === null || isString(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
