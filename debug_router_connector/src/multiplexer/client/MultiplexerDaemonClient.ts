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
  isControlEvent,
  isControlRpcParams,
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

export type MultiplexerDaemonConnectionEvent =
  | { state: "connected" }
  | { state: "disconnected"; error: Error };

type MultiplexerDaemonClientStatus =
  | "disconnected"
  | "connecting"
  | "connected";

export class MultiplexerDaemonClient {
  readonly pendingRpc: Map<number, PendingRpc> = new Map();
  private readonly daemonManager: MultiplexerDaemonManager;
  private readonly controlEndpoint: string;
  private readonly rpcTimeout: number;
  private readonly debugInfo?: MultiplexerDebugInfo;
  private readonly now: () => number;
  private eventListener?: (event: ControlEvent) => void;
  private connectionEventListener?: (
    event: MultiplexerDaemonConnectionEvent,
  ) => void;
  private controlTransport: MultiplexerControlTransport | null = null;
  private unsubscribeTransportMessage: (() => void) | undefined;
  private unsubscribeTransportClose: (() => void) | undefined;
  private nextRpcId = 1;
  private connectPromise: Promise<void> | null = null;
  private status: MultiplexerDaemonClientStatus = "disconnected";

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
    this.daemonManager.setDaemonClient(this);
  }

  async call<M extends ControlRpcMethod>(
    method: M,
    params: ControlRpcParams[M],
    ensureDaemon: boolean = true,
  ): Promise<ControlRpcResult[M]> {
    this.assertValidRpcParams(method, params);
    if (ensureDaemon) {
      await this.connect();
    } else if (this.status !== "connected") {
      await this.connectInternal(false);
    }
    return this.sendRpc(method, params);
  }

  private assertValidRpcParams<M extends ControlRpcMethod>(
    method: M,
    params: ControlRpcParams[M],
  ): void {
    if (!isControlRpcParams(method, params)) {
      throw new Error(`Invalid multiplexer RPC ${method} params`);
    }
  }

  async connect(): Promise<void> {
    if (this.status === "connected") {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectInternal(true).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private sendRpc<M extends ControlRpcMethod>(
    method: M,
    params: ControlRpcParams[M],
  ): Promise<ControlRpcResult[M]> {
    if (this.status !== "connected") {
      throw new Error("Multiplexer control socket is not connected");
    }
    const transport = this.controlTransport!;

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

  subscribe(listener: (event: ControlEvent) => void): () => void {
    this.eventListener = listener;
    return () => {
      this.eventListener = undefined;
    };
  }

  subscribeConnectionEvent(
    listener: (event: MultiplexerDaemonConnectionEvent) => void,
  ): () => void {
    this.connectionEventListener = listener;
    return () => {
      this.connectionEventListener = undefined;
    };
  }

  private emitConnectionEvent(event: MultiplexerDaemonConnectionEvent): void {
    this.connectionEventListener?.(event);
  }

  async forceStopDaemon(): Promise<void> {
    await this.daemonManager.stopDaemonForDebugging();
  }

  rejectAllPendingRpc(error: Error): void {
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
        false,
      );
    }
    this.status = "connecting";
    if (ensureDaemon) {
      try {
        await this.daemonManager.ensureDaemon();
      } catch (error) {
        this.status = "disconnected";
        throw error;
      }
    }

    let transport: MultiplexerControlTransport;
    try {
      transport = new MultiplexerControlTransport(
        createConnection(this.controlEndpoint),
      );
    } catch (error) {
      this.status = "disconnected";
      throw error;
    }
    this.controlTransport = transport;

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
        this.status = "disconnected";
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
        this.unsubscribeTransportMessage = transport.onMessage(
          this.handleTransportMessage,
        );
        this.unsubscribeTransportClose = transport.onClose(
          this.handleTransportClose,
        );
        this.status = "connected";
        this.emitConnectionEvent({ state: "connected" });
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

  private readonly handleTransportClose = (error?: Error): void => {
    void this.closeSocket(
      error ?? new Error("Multiplexer control socket closed"),
      false,
    );
  };

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

  handleHostEvent(event: ControlEvent): void {
    this.eventListener?.(event);
  }

  async close(): Promise<void> {
    await this.closeSocket(new Error("Multiplexer remote client closed"));
    this.eventListener = undefined;
    this.connectionEventListener = undefined;
  }

  private async closeSocket(
    error: Error,
    clearConnecting: boolean = true,
  ): Promise<void> {
    const transport = this.controlTransport;
    this.controlTransport = null;
    this.status = "disconnected";
    if (clearConnecting) {
      this.connectPromise = null;
    }
    this.unsubscribeTransportMessage?.();
    this.unsubscribeTransportClose?.();
    this.unsubscribeTransportMessage = undefined;
    this.unsubscribeTransportClose = undefined;
    this.rejectAllPendingRpc(error);

    if (!transport) {
      return;
    }
    this.emitConnectionEvent({ state: "disconnected", error });
    await transport.end();
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
    let messageText: string;
    try {
      messageText = JSON.stringify(value) ?? String(value);
    } catch (_error) {
      messageText = String(value);
    }
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
      messagePreview:
        messageText.length <= UNKNOWN_CONTROL_MESSAGE_PREVIEW_LIMIT
          ? messageText
          : `${messageText.slice(0, UNKNOWN_CONTROL_MESSAGE_PREVIEW_LIMIT)}...`,
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
