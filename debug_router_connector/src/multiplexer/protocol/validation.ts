// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type {
  ControlMessageMeta,
  ControlRpcError,
  ControlRpcMethod,
  ControlRpcRequest,
  ControlRpcResponse,
} from "./control";
import type {
  MultiplexerDiscoveryInfo,
  MultiplexerHealthResponse,
} from "./discovery";
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
  "getDevices",
  "connectUsbClients",
  "startWatchClient",
  "stopWatchClient",
  "disconnectDevice",
  "reacquireLegacyOwnership",
  "startWSServer",
  "startWatchAllClients",
  "sendMessageToWeb",
  "sendMessageToApp",
  "sendCustomizedMessage",
  "sendRawMessage",
  "sendMessage",
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

export function isControlMessageMeta(
  value: unknown,
): value is ControlMessageMeta {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isOptional(value.protocolVersion, isNumber) &&
    isOptional(value.clientVersion, isString) &&
    isOptional(value.daemonVersion, isString) &&
    isOptional(value.capabilities, isStringArray)
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

export function isSnapshot(value: unknown): value is Snapshot {
  return (
    isRecord(value) &&
    isNumber(value.protocolVersion) &&
    isNumber(value.generatedAt) &&
    Array.isArray(value.devices) &&
    value.devices.every(isDeviceSnapshot) &&
    Array.isArray(value.clients) &&
    value.clients.every(isClientSnapshot) &&
    isOptional(value.daemonVersion, isString) &&
    isOptional(value.capabilities, isStringArray)
  );
}

export function isMultiplexerDiscoveryInfo(
  value: unknown,
): value is MultiplexerDiscoveryInfo {
  return (
    isRecord(value) &&
    isNumber(value.pid) &&
    isNumber(value.protocolVersion) &&
    isOptional(value.minSupportedProtocolVersion, isNumber) &&
    isNumber(value.controlPort) &&
    isNumber(value.heartbeat) &&
    isOptional(value.startedAt, isNumber) &&
    isOptional(value.daemonVersion, isString) &&
    isOptional(value.capabilities, isStringArray)
  );
}

export function isMultiplexerHealthResponse(
  value: unknown,
): value is MultiplexerHealthResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isNumber(value.pid) &&
    isNumber(value.protocolVersion) &&
    isOptional(value.minSupportedProtocolVersion, isNumber) &&
    isNumber(value.heartbeat) &&
    isOptional(value.daemonVersion, isString) &&
    isOptional(value.capabilities, isStringArray)
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
    !isOptional(value.meta, isControlMessageMeta)
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
    !isOptional(value.meta, isControlMessageMeta)
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
    !isOptional(value.meta, isControlMessageMeta)
  ) {
    return false;
  }

  switch (value.event) {
    case "snapshot":
      return isSnapshot(value.data);
    case "legacy-ownership-changed":
      return isLegacyOwnershipChangedEventData(value.data);
    case "device-connected":
      return isDeviceSnapshot(value.data);
    case "device-disconnected":
      return isRecord(value.data) && isString(value.data.serial);
    case "client-connected":
      return isClientSnapshot(value.data);
    case "client-disconnected":
      return isRecord(value.data) && isNumber(value.data.id);
    case "usb-client-message":
    case "ws-client-message":
    case "ws-web-message":
      return (
        isRecord(value.data) &&
        isNumber(value.data.id) &&
        isString(value.data.message)
      );
    case "websocket-app-client-connected":
    case "websocket-web-client-connected":
      return isWebSocketClientSnapshot(value.data);
    case "websocket-app-client-disconnected":
    case "websocket-web-client-disconnected":
      return isRecord(value.data) && isNumber(value.data.id);
    default:
      return false;
  }
}

function isControlRpcParams(
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
    case "getDevices":
      return (
        isOptional(params.timeout, isNumber) &&
        isOptionalStringOrNull(params.serial)
      );
    case "connectUsbClients":
      return (
        isString(params.deviceId) &&
        isOptional(params.timeout, isNumber) &&
        isOptional(params.waitTimeout, isBoolean) &&
        isOptionalStringOrNull(params.clientName)
      );
    case "startWatchClient":
    case "stopWatchClient":
    case "disconnectDevice":
      return isString(params.deviceId);
    case "reacquireLegacyOwnership":
      return true;
    case "startWSServer":
      return true;
    case "startWatchAllClients":
      return isOptional(params.force, isBoolean);
    case "sendMessageToWeb":
      return isString(params.message);
    case "sendMessageToApp":
      return (
        isNumber(params.id) &&
        isString(params.message) &&
        isOptional(params.fromWebClientId, isNumber)
      );
    case "sendCustomizedMessage":
      return (
        isNumber(params.clientId) &&
        isString(params.method) &&
        isOptional(params.params, isStringOrObject) &&
        isOptional(params.sessionId, isNumber) &&
        isOptional(params.type, isString)
      );
    case "sendRawMessage":
      return isNumber(params.clientId) && isRequireMessage(params.message);
    case "sendMessage":
      return isNumber(params.clientId) && hasOwn(params, "message");
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
    case "getDevices":
      return Array.isArray(result) && result.every(isDeviceSnapshot);
    case "connectUsbClients":
      return Array.isArray(result) && result.every(isClientSnapshot);
    case "sendCustomizedMessage":
      return isString(result);
    case "sendRawMessage":
      return isResponseMessage(result);
    case "startWSServer":
      return result === undefined || isWebSocketServerInfo(result);
    case "startWatchAllClients":
    case "startWatchClient":
    case "stopWatchClient":
    case "disconnectDevice":
    case "reacquireLegacyOwnership":
    case "sendMessageToWeb":
    case "sendMessageToApp":
    case "sendMessage":
    case "closeClient":
      return result === undefined;
    default:
      return false;
  }
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

function isStringOrObject(value: unknown): value is string | object {
  return isString(value) || (typeof value === "object" && value !== null);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
