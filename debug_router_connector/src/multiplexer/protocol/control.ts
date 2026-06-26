// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { ClientSnapshot, DeviceSnapshot } from "./snapshot";
import type { RequireMessageType, ResponseMessageType } from "../../utils/type";

export type ControlMessageMeta = {
  protocolVersion?: number;
  clientVersion?: string;
  daemonVersion?: string;
  capabilities?: string[];
};

export type ControlRpcRequest<M extends ControlRpcMethod = ControlRpcMethod> = {
  kind: "rpc";
  id: number;
  method: M;
  params: ControlRpcParams[M];
  meta?: ControlMessageMeta;
};

export type ControlRpcResponse<M extends ControlRpcMethod = ControlRpcMethod> =
  | {
      kind: "rpc-response";
      id: number;
      ok: true;
      result: ControlRpcResult[M];
      meta?: ControlMessageMeta;
    }
  | {
      kind: "rpc-response";
      id: number;
      ok: false;
      error: ControlRpcError;
      meta?: ControlMessageMeta;
    };

export type ControlRpcError = {
  code: string;
  message: string;
  details?: unknown;
};

export type WebSocketServerInfo = {
  port: number;
  host: string;
  roomId?: string;
};

export type ControlRpcMethod =
  | "connectDevices"
  | "getDevices"
  | "connectUsbClients"
  | "startWatchClient"
  | "stopWatchClient"
  | "disconnectDevice"
  | "reacquireLegacyOwnership"
  | "startWSServer"
  | "startWatchAllClients"
  | "sendMessageToWeb"
  | "sendMessageToApp"
  | "sendCustomizedMessage"
  | "sendRawMessage"
  | "sendMessage"
  | "closeClient";

export type ControlRpcParams = {
  connectDevices: {
    timeout?: number;
    serial?: string | null;
    isAutoListenClients?: boolean;
  };
  getDevices: {
    timeout?: number;
    serial?: string | null;
  };
  connectUsbClients: {
    deviceId: string;
    timeout?: number;
    waitTimeout?: boolean;
    clientName?: string | null;
  };
  startWatchClient: {
    deviceId: string;
  };
  stopWatchClient: {
    deviceId: string;
  };
  disconnectDevice: {
    deviceId: string;
  };
  reacquireLegacyOwnership: Record<string, never>;
  startWSServer: Record<string, never>;
  startWatchAllClients: {
    force?: boolean;
  };
  sendMessageToWeb: {
    message: string;
  };
  sendMessageToApp: {
    id: number;
    message: string;
    fromWebClientId?: number;
  };
  sendCustomizedMessage: {
    clientId: number;
    method: string;
    params?: object | string;
    sessionId?: number;
    type?: string;
  };
  sendRawMessage: {
    clientId: number;
    message: RequireMessageType;
  };
  sendMessage: {
    clientId: number;
    message: unknown;
  };
  closeClient: {
    clientId: number;
  };
};

export type ControlRpcResult = {
  connectDevices: DeviceSnapshot[];
  getDevices: DeviceSnapshot[];
  connectUsbClients: ClientSnapshot[];
  startWatchClient: void;
  stopWatchClient: void;
  disconnectDevice: void;
  reacquireLegacyOwnership: void;
  startWSServer: WebSocketServerInfo | undefined;
  startWatchAllClients: void;
  sendMessageToWeb: void;
  sendMessageToApp: void;
  sendCustomizedMessage: string;
  sendRawMessage: ResponseMessageType;
  sendMessage: void;
  closeClient: void;
};
