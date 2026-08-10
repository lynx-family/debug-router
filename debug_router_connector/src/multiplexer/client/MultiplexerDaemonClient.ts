// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { createConnection } from "net";
import { defaultLogger } from "../../utils/logger";
import {
  ControlEvent,
  ControlRpcError,
  ControlRpcMethod,
  ControlRpcParams,
  ControlRpcRequest,
  ControlRpcResponse,
  ControlRpcResult,
  MULTIPLEXER_PROTOCOL_VERSION,
  MultiplexerDebugInfo,
  MultiplexerRegisterRequest,
  Snapshot,
  isControlEvent,
  isControlRpcRequest,
  isControlRpcResponse,
  isMultiplexerHandshakeErrorResponse,
  isMultiplexerRegisterResponse,
  isRecord,
} from "../protocol";
import { MultiplexerControlTransport } from "../transport/MultiplexerControlTransport";
import type { MultiplexerDaemonManager } from "./MultiplexerDaemonManager";

export const DEFAULT_MULTIPLEXER_RPC_TIMEOUT = 5000;
const RPC_TIMEOUT_BUFFER_MS = 1000;
const UNKNOWN_CONTROL_MESSAGE_PREVIEW_LIMIT = 500;

export type MultiplexerDaemonClientOption = {
  daemonManager: MultiplexerDaemonManager;
  controlEndpoint: string;
  rpcTimeout?: number;
  debugInfo?: MultiplexerDebugInfo;

  // only used for tests or embedding
  now?: () => number;
};

type PendingRpc = {
  method: ControlRpcMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type MultiplexerDaemonConnectionState =
  | { state: "connected" }
  | { state: "disconnected"; error: Error };

export class MultiplexerDaemonClient {
  readonly pendingRpc: Map<number, PendingRpc> = new Map();
  private readonly daemonManager: MultiplexerDaemonManager;
  private readonly controlEndpoint: string;
  private readonly rpcTimeout: number;
  private readonly debugInfo?: MultiplexerDebugInfo;
  private readonly now: () => number;
  private eventListener?: (event: ControlEvent) => void;
  private connectionStateListener?: (
    state: MultiplexerDaemonConnectionState,
  ) => void;
  private controlTransport: MultiplexerControlTransport | null = null;
  private unsubscribeTransportMessage: (() => void) | undefined;
  private unsubscribeTransportClose: (() => void) | undefined;
  private nextRpcId = 1;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private registered = false;

  constructor(option: MultiplexerDaemonClientOption) {
    this.daemonManager = option.daemonManager;
    this.controlEndpoint = option.controlEndpoint;
    this.rpcTimeout = option.rpcTimeout ?? DEFAULT_MULTIPLEXER_RPC_TIMEOUT;
    this.debugInfo = option.debugInfo
      ? {
          protocolVersion:
            option.debugInfo.protocolVersion ?? MULTIPLEXER_PROTOCOL_VERSION,
          ...option.debugInfo,
        }
      : undefined;
    this.now = option.now ?? Date.now;
    this.daemonManager.setDaemonClient?.(this);
  }

  get ready(): boolean {
    return (
      this.registered &&
      !!this.controlTransport &&
      this.controlTransport.writable
    );
  }

  async connect(): Promise<void> {
    if (this.ready) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.closed = false;
    this.connecting = this.connectInternal(true).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async call<M extends ControlRpcMethod>(
    method: M,
    params: ControlRpcParams[M],
  ): Promise<ControlRpcResult[M]> {
    this.assertValidRpcParams(method, params);
    await this.connect();
    return this.callConnected(method, params);
  }

  async callOnDaemon<M extends ControlRpcMethod>(
    method: M,
    params: ControlRpcParams[M],
  ): Promise<ControlRpcResult[M]> {
    this.assertValidRpcParams(method, params);
    if (!this.ready) {
      await this.connectInternal(false);
    }
    return this.callConnected(method, params);
  }

  private callConnected<M extends ControlRpcMethod>(
    method: M,
    params: ControlRpcParams[M],
  ): Promise<ControlRpcResult[M]> {
    const transport = this.controlTransport;
    if (!transport || !this.ready) {
      throw new Error("Multiplexer control socket is not connected");
    }

    const id = this.createRpcId();
    const debugInfo = this.createDebugInfo();
    const request: ControlRpcRequest<M> = {
      kind: "rpc",
      id,
      method,
      params,
      ...(debugInfo ? { debugInfo } : {}),
    };

    return new Promise<ControlRpcResult[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(
          new Error(`Timed out waiting for multiplexer RPC ${method} response`),
        );
      }, this.getRpcTimeout(params));
      this.pendingRpc.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        transport.send(request);
      } catch (error) {
        const pending = this.pendingRpc.get(id);
        if (pending) {
          this.pendingRpc.delete(id);
          clearTimeout(pending.timer);
          pending.reject(asError(error));
        }
      }
    });
  }

  private assertValidRpcParams<M extends ControlRpcMethod>(
    method: M,
    params: ControlRpcParams[M],
  ): void {
    const debugInfo = this.createDebugInfo();
    const request: ControlRpcRequest<M> = {
      kind: "rpc",
      id: 0,
      method,
      params,
      ...(debugInfo ? { debugInfo } : {}),
    };
    if (!isControlRpcRequest(request)) {
      throw new Error(`Invalid multiplexer RPC ${method} params`);
    }
  }

  subscribe(listener: (event: ControlEvent) => void): () => void {
    this.eventListener = listener;
    return () => {
      this.eventListener = undefined;
    };
  }

  subscribeConnectionState(
    listener: (state: MultiplexerDaemonConnectionState) => void,
  ): () => void {
    this.connectionStateListener = listener;
    return () => {
      this.connectionStateListener = undefined;
    };
  }

  async forceStopDaemon(): Promise<void> {
    await this.daemonManager.stopDaemonOnConnectorRequest();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeSocket(new Error("Multiplexer remote client closed"));
    this.eventListener = undefined;
  }

  handleSnapshot(snapshot: Snapshot): void {
    this.handleHostEvent({ kind: "event", event: "snapshot", data: snapshot });
  }

  handleHostEvent(event: ControlEvent): void {
    this.eventListener?.(event);
  }

  rejectPending(error: Error): void {
    for (const [id, pending] of Array.from(this.pendingRpc.entries())) {
      this.pendingRpc.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private async connectInternal(ensureDaemon: boolean): Promise<void> {
    if (this.controlTransport) {
      await this.closeSocket(
        new Error("Replacing multiplexer control socket"),
        true,
        false,
      );
    }
    if (ensureDaemon) {
      await this.daemonManager.ensureDaemon();
    }

    const transport = new MultiplexerControlTransport(
      createConnection(this.controlEndpoint),
    );
    this.controlTransport = transport;
    this.registered = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanupHandshake = () => {
        unsubscribeConnect();
        unsubscribeMessage();
        unsubscribeClose();
      };
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupHandshake();
        if (this.controlTransport === transport) {
          this.controlTransport = null;
        }
        transport.destroy(error);
        reject(error);
      };
      const onConnect = () => {
        const debugInfo = this.createDebugInfo();
        const request: MultiplexerRegisterRequest = {
          kind: "register",
          ...(debugInfo ? { debugInfo } : {}),
        };
        try {
          transport.send(request);
        } catch (error) {
          fail(asError(error));
        }
      };
      const unsubscribeMessage = transport.onMessage((message) => {
        if (isMultiplexerHandshakeErrorResponse(message)) {
          fail(createRpcError(message.error));
          return;
        }
        if (!isMultiplexerRegisterResponse(message)) {
          fail(new Error("Invalid multiplexer register response"));
          return;
        }

        settled = true;
        cleanupHandshake();
        this.registered = true;
        this.unsubscribeTransportMessage = transport.onMessage(
          this.handleTransportMessage,
        );
        this.unsubscribeTransportClose = transport.onClose(
          this.handleTransportClose,
        );
        this.emitConnectionState({ state: "connected" });
        resolve();
      });
      const unsubscribeClose = transport.onClose((error) => {
        fail(
          error ??
            new Error("Multiplexer control socket closed before register"),
        );
      });

      const unsubscribeConnect = transport.onConnect(onConnect);
    });
  }

  private readonly handleTransportMessage = (value: unknown): void => {
    if (isControlRpcResponse(value)) {
      this.handleRpcResponse(value);
      return;
    }
    if (isControlEvent(value)) {
      this.handleHostEvent(value);
      return;
    }
    this.reportUnknownControlMessage(value);
  };

  private readonly handleTransportClose = (error?: Error): void => {
    void this.closeSocket(
      error ?? new Error("Multiplexer control socket closed"),
      false,
    );
  };

  private handleRpcResponse(response: ControlRpcResponse): void {
    const responseId = response.id;
    const pending = this.pendingRpc.get(responseId);
    if (!pending) {
      return;
    }
    if (!isControlRpcResponse(response, pending.method)) {
      this.pendingRpc.delete(responseId);
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`Invalid multiplexer RPC ${pending.method} response payload`),
      );
      return;
    }

    this.pendingRpc.delete(responseId);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(createRpcError(response.error));
    }
  }

  private async closeSocket(
    error: Error,
    closeUnderlyingSocket: boolean = true,
    clearConnecting: boolean = true,
  ): Promise<void> {
    const transport = this.controlTransport;
    this.controlTransport = null;
    this.registered = false;
    if (clearConnecting) {
      this.connecting = null;
    }
    this.unsubscribeTransportMessage?.();
    this.unsubscribeTransportClose?.();
    this.unsubscribeTransportMessage = undefined;
    this.unsubscribeTransportClose = undefined;
    this.rejectPending(error);

    if (!transport) {
      return;
    }
    this.emitConnectionState({ state: "disconnected", error });
    if (!closeUnderlyingSocket) {
      return;
    }
    await transport.end();
  }

  private emitConnectionState(state: MultiplexerDaemonConnectionState): void {
    this.connectionStateListener?.(state);
  }

  private createRpcId(): number {
    return this.nextRpcId++;
  }

  private getRpcTimeout(params: unknown): number {
    const operationTimeout = getOperationTimeout(params);
    return operationTimeout === undefined
      ? this.rpcTimeout
      : Math.max(this.rpcTimeout, operationTimeout + RPC_TIMEOUT_BUFFER_MS);
  }

  private createDebugInfo(): MultiplexerDebugInfo | undefined {
    if (!this.debugInfo) {
      return undefined;
    }
    return {
      ...this.debugInfo,
      processId: process.pid,
      timestamp: this.now(),
    };
  }

  private reportUnknownControlMessage(value: unknown): void {
    const messageText = safeStringify(value);
    const categories = {
      kind:
        isRecord(value) && typeof value.kind === "string"
          ? value.kind
          : undefined,
      event:
        isRecord(value) && typeof value.event === "string"
          ? value.event
          : undefined,
      id:
        isRecord(value) && typeof value.id === "number" ? value.id : undefined,
      messagePreview: truncateMessage(messageText),
    };
    defaultLogger.warn(
      `Unknown multiplexer control message: ${JSON.stringify(categories)}`,
    );
  }
}

function getOperationTimeout(params: unknown): number | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const timeout = params.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0
    ? timeout
    : undefined;
}

function createRpcError(error: ControlRpcError): Error {
  const rpcError = new Error(error.message);
  rpcError.name = error.code;
  return rpcError;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (_error) {
    return String(value);
  }
}

function truncateMessage(message: string): string {
  return message.length <= UNKNOWN_CONTROL_MESSAGE_PREVIEW_LIMIT
    ? message
    : `${message.slice(0, UNKNOWN_CONTROL_MESSAGE_PREVIEW_LIMIT)}...`;
}
