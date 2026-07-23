// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { ClientSnapshot, DeviceSnapshot } from "./snapshot";
import type { RequireMessageType, ResponseMessageType } from "../../utils/type";

// protocolVersion is used for version arbitration when connecting to the Multiplexer daemon.
// minSupportedProtocolVersion is used to check if the Multiplexer daemon supports the protocol version.
// daemonVersion and clientVersion is only injected for testing or debugging purposes and is not used in version arbitration.

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
  | "connectUsbClients"
  | "startWatchClient"
  | "stopWatchClient"
  | "disconnectDevice"
  | "shutdownDaemon"
  | "startWSServer"
  | "startWatchAllClients"
  | "stopWatchAllClients"
  | "sendRawMessage"
  | "sendMessage"
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
  startWatchClient: {
    deviceId: string;
  };
  stopWatchClient: {
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
  startWatchAllClients: {
    force?: boolean;
  };
  stopWatchAllClients: {
    // This RPC has no parameters.
  };
  /**
   * Sends a request-response message to one USB or WiFi Runtime and returns
   * the complete raw response envelope.
   */
  sendRawMessage: {
    clientId: number;
    message: RequireMessageType;
  };
  /**
   * Sends a fire-and-forget message to an App Runtime or WebSocket Driver.
   */
  sendMessage: {
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
  startWatchClient: void;
  stopWatchClient: void;
  disconnectDevice: void;
  shutdownDaemon: void;
  startWSServer: WebSocketServerInfo | undefined;
  startWatchAllClients: void;
  stopWatchAllClients: void;
  sendRawMessage: ResponseMessageType;
  sendMessage: void;
  closeClient: void;
};
