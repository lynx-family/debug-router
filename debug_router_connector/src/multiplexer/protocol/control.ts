// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { ClientSnapshot, DeviceSnapshot } from "./snapshot";
import type { RequireMessageType, ResponseMessageType } from "../../utils/type";
import type { MultiplexerDebugInfo } from "./debuginfo";

export type ControlRpcRequest<M extends ControlRpcMethod = ControlRpcMethod> = {
  kind: "rpc";
  id: number;
  method: M;
  params: ControlRpcParams[M];
  debugInfo?: MultiplexerDebugInfo;
};

export type ControlRpcResponse<M extends ControlRpcMethod = ControlRpcMethod> =
  | {
      kind: "rpc-response";
      id: number;
      ok: true;
      result: ControlRpcResult[M];
      debugInfo?: MultiplexerDebugInfo;
    }
  | {
      kind: "rpc-response";
      id: number;
      ok: false;
      error: ControlRpcError;
      debugInfo?: MultiplexerDebugInfo;
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
  | "connectUsbClients"
  | "startDeviceClientWatcher"
  | "stopDeviceClientWatcher"
  | "disconnectDevice"
  | "shutdownDaemon"
  | "startWSServer"
  | "startAllDeviceClientWatchers"
  | "stopAllDeviceClientWatchers"
  | "sendMessageWithReply"
  | "sendMessageWithoutReply"
  | "closeClient";

export type ControlRpcParams = {
  connectDevices: {
    timeout?: number;
    serial?: string | null;
    isAutoListenClients?: boolean;
  };
  connectUsbClients: {
    deviceId: string;
    timeout?: number;
    waitTimeout?: boolean;
    clientName?: string | null;
  };
  startDeviceClientWatcher: {
    deviceId: string;
  };
  stopDeviceClientWatcher: {
    deviceId: string;
  };
  disconnectDevice: {
    deviceId: string;
  };
  /**
   * Requests a graceful daemon shutdown, normally for replacement or explicit
   * Connector shutdown.
   */
  shutdownDaemon: {
    reason?: string;
  };
  startWSServer: {
    // This RPC has no parameters.
  };
  startAllDeviceClientWatchers: {
    // This RPC has no parameters.
  };
  stopAllDeviceClientWatchers: {
    // This RPC has no parameters.
  };
  /**
   * Sends a request-response message to one USB or WiFi Runtime and returns
   * the complete raw response envelope.
   */
  sendMessageWithReply: {
    clientId: number;
    message: RequireMessageType;
  };
  /**
   * Sends a fire-and-forget message to an App Runtime or WebSocket Driver.
   */
  sendMessageWithoutReply: {
    target: "app" | "web";
    clientId: number;
    message: unknown;
  };
  closeClient: {
    clientId: number;
  };
};

export type ControlRpcResult = {
  connectDevices: DeviceSnapshot[];
  connectUsbClients: ClientSnapshot[];
  startDeviceClientWatcher: {};
  stopDeviceClientWatcher: {};
  disconnectDevice: {};
  shutdownDaemon: {};
  startWSServer: WebSocketServerInfo;
  startAllDeviceClientWatchers: {};
  stopAllDeviceClientWatchers: {};
  sendMessageWithReply: ResponseMessageType;
  sendMessageWithoutReply: {};
  closeClient: {};

  // `{}` means the RPC has no business result data. Its successful response
  // still contains an explicit `result: {}` on the wire.
};
