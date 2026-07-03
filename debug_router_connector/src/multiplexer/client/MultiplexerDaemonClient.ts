// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { WebSocket } from "ws";
import type { RawData } from "ws";
import { getDriverReportService } from "../../report/interface/DriverReportService";
import { defaultLogger } from "../../utils/logger";
import {
  ControlRpcError,
  ControlEvent,
  ControlMessageMeta,
  ControlRpcMethod,
  ControlRpcParams,
  ControlRpcRequest,
  ControlRpcResponse,
  ControlRpcResult,
  MULTIPLEXER_CONTROL_PATH,
  MULTIPLEXER_PROTOCOL_VERSION,
  MultiplexerDiscoveryInfo,
  Snapshot,
  isControlEvent,
  isControlRpcResponse,
  isRecord,
  parseJsonValue,
} from "../protocol";
import type { MultiplexerDaemonManager } from "./MultiplexerDaemonManager";

export const DEFAULT_MULTIPLEXER_RPC_TIMEOUT = 5000;
const RPC_TIMEOUT_BUFFER_MS = 1000;
const UNKNOWN_CONTROL_MESSAGE_PREVIEW_LIMIT = 500;

export type MultiplexerDaemonClientOption = {
  daemonManager: MultiplexerDaemonManager;
  controlPath?: string;
  rpcTimeout?: number;
  protocolVersion?: number;
  clientVersion?: string;
  capabilities?: string[];

  // only used for tests or embedding
  WebSocketCtor?: typeof WebSocket;
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
  readonly daemonManager: MultiplexerDaemonManager;
  readonly pendingRpc: Map<number, PendingRpc> = new Map();
  private readonly controlPath: string;
  private readonly rpcTimeout: number;
  private readonly protocolVersion: number;
  private readonly clientVersion?: string;
  private readonly capabilities?: string[];
  private readonly WebSocketCtor: typeof WebSocket;
  private eventListener?: (event: ControlEvent) => void;
  private readonly connectionListeners = new Set<
    (state: MultiplexerDaemonConnectionState) => void
  >();
  private controlSocket: WebSocket | null = null;
  private nextRpcId = 1;
  private connecting: Promise<void> | null = null;
  private closed = false;

  constructor(option: MultiplexerDaemonClientOption) {
    this.daemonManager = option.daemonManager;
    this.controlPath = option.controlPath ?? MULTIPLEXER_CONTROL_PATH;
    this.rpcTimeout = option.rpcTimeout ?? DEFAULT_MULTIPLEXER_RPC_TIMEOUT;
    this.protocolVersion =
      option.protocolVersion ?? MULTIPLEXER_PROTOCOL_VERSION;
    this.clientVersion = option.clientVersion;
    this.capabilities = option.capabilities;
    this.WebSocketCtor = option.WebSocketCtor ?? WebSocket;
    this.daemonManager.setDaemonClient?.(this);
  }

  get ready(): boolean {
    return this.isSocketOpen();
  }

  async connect(): Promise<void> {
    if (this.ready) {
      return;
    }

    if (this.connecting) {
      return this.connecting;
    }

    this.closed = false;
    this.connecting = this.connectInternal().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  async call<M extends ControlRpcMethod>(
    method: M,
    params: ControlRpcParams[M],
  ): Promise<ControlRpcResult[M]> {
    await this.connect();
    return this.callConnected(method, params);
  }

  async callOnDiscovery<M extends ControlRpcMethod>(
    discovery: MultiplexerDiscoveryInfo,
    method: M,
    params: ControlRpcParams[M],
  ): Promise<ControlRpcResult[M]> {
    await this.connectToDiscovery(discovery);
    return this.callConnected(method, params);
  }

  async connectToDiscovery(
    discovery: MultiplexerDiscoveryInfo,
  ): Promise<void> {
    this.closed = false;
    this.connecting = this.connectInternal(discovery).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private callConnected<M extends ControlRpcMethod>(
    method: M,
    params: ControlRpcParams[M],
  ): Promise<ControlRpcResult[M]> {
    const socket = this.controlSocket;
    if (!socket || !this.ready) {
      throw new Error("Multiplexer control socket is not connected");
    }

    const id = this.createRpcId();
    const request: ControlRpcRequest<M> = {
      kind: "rpc",
      id,
      method,
      params,
      meta: this.createMeta(),
    };

    return new Promise<ControlRpcResult[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(
          new Error(
            `Timed out waiting for multiplexer RPC ${method} response`,
          ),
        );
      }, this.getRpcTimeout(method, params));

      this.pendingRpc.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      socket.send(JSON.stringify(request), (error) => {
        if (!error) {
          return;
        }

        const pending = this.pendingRpc.get(id);
        if (!pending) {
          return;
        }

        this.pendingRpc.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  subscribe(listener: (event: ControlEvent) => void): () => void {
    this.eventListener = listener;
    return () => {
      if (this.eventListener === listener) {
        this.eventListener = undefined;
      }
    };
  }

  subscribeConnectionState(
    listener: (state: MultiplexerDaemonConnectionState) => void,
  ): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  async reconnect(): Promise<void> {
    await this.closeSocket(
      new Error("Multiplexer control socket reconnecting"),
    );
    await this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeSocket(new Error("Multiplexer remote client closed"));
    this.eventListener = undefined;
  }

  handleSnapshot(snapshot: Snapshot): void {
    this.handleHostEvent({
      kind: "event",
      event: "snapshot",
      data: snapshot,
    });
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

  private async connectInternal(
    discovery?: MultiplexerDiscoveryInfo,
  ): Promise<void> {
    if (this.controlSocket) {
      await this.closeSocket(
        new Error("Replacing multiplexer control socket"),
        true,
        false,
      );
    }

    const resolvedDiscovery =
      discovery ?? (await this.daemonManager.ensureDaemon());
    const socket = new this.WebSocketCtor(
      this.createControlUrl(resolvedDiscovery),
    );

    this.controlSocket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onCloseBeforeOpen);
      };
      const fail = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        if (this.controlSocket === socket) {
          this.controlSocket = null;
        }
        reject(error);
      };
      const onOpen = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        socket.on("message", this.handleSocketMessage);
        socket.on("close", this.handleSocketClose);
        socket.on("error", this.handleSocketError);
        this.emitConnectionState({ state: "connected" });
        resolve();
      };
      const onError = (error: Error) => {
        fail(error);
      };
      const onCloseBeforeOpen = () => {
        fail(new Error("Multiplexer control socket closed before open"));
      };

      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onCloseBeforeOpen);
    });
  }

  private handleSocketMessage = (data: RawData): void => {
    const messageText = rawDataToString(data);
    const value = parseJsonValue(messageText);

    if (isControlRpcResponse(value)) {
      this.handleRpcResponse(value);
      return;
    }

    if (isControlEvent(value)) {
      this.handleHostEvent(value);
      return;
    }

    this.reportUnknownControlMessage(value, messageText);
  };

  private handleSocketClose = (): void => {
    void this.closeSocket(
      new Error("Multiplexer control socket closed"),
      false,
    );
  };

  private handleSocketError = (error: Error): void => {
    void this.closeSocket(error);
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
        new Error(
          `Invalid multiplexer RPC ${pending.method} response payload`,
        ),
      );
      return;
    }

    const typedResponse = response as ControlRpcResponse;
    this.pendingRpc.delete(responseId);
    clearTimeout(pending.timer);

    if (typedResponse.ok) {
      pending.resolve(typedResponse.result);
      return;
    }

    pending.reject(createRpcError(typedResponse.error));
  }

  private async closeSocket(
    error: Error,
    closeUnderlyingSocket: boolean = true,
    clearConnecting: boolean = true,
  ): Promise<void> {
    const socket = this.controlSocket;
    this.controlSocket = null;
    if (clearConnecting) {
      this.connecting = null;
    }
    this.rejectPending(error);

    if (!socket) {
      return;
    }

    this.emitConnectionState({ state: "disconnected", error });

    socket.off("message", this.handleSocketMessage);
    socket.off("close", this.handleSocketClose);
    socket.off("error", this.handleSocketError);

    if (!closeUnderlyingSocket || socket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  }

  private emitConnectionState(state: MultiplexerDaemonConnectionState): void {
    for (const listener of Array.from(this.connectionListeners)) {
      listener(state);
    }
  }

  private isSocketOpen(): boolean {
    return this.controlSocket?.readyState === WebSocket.OPEN;
  }

  private createRpcId(): number {
    return this.nextRpcId++;
  }

  private getRpcTimeout<M extends ControlRpcMethod>(
    _method: M,
    params: ControlRpcParams[M],
  ): number {
    const operationTimeout = getOperationTimeout(params);
    if (operationTimeout === undefined) {
      return this.rpcTimeout;
    }

    return Math.max(this.rpcTimeout, operationTimeout + RPC_TIMEOUT_BUFFER_MS);
  }

  private createMeta(): ControlMessageMeta {
    return {
      protocolVersion: this.protocolVersion,
      clientVersion: this.clientVersion,
      capabilities: this.capabilities ? [...this.capabilities] : undefined,
    };
  }

  private createControlUrl(discovery: MultiplexerDiscoveryInfo): string {
    return `ws://127.0.0.1:${discovery.controlPort}${this.controlPath}`;
  }

  private reportUnknownControlMessage(value: unknown, messageText: string): void {
    const messageKind = isRecord(value) ? value.kind : undefined;
    const messageEvent = isRecord(value) ? value.event : undefined;
    const messageId = isRecord(value) ? value.id : undefined;
    const categories = {
      kind: typeof messageKind === "string" ? messageKind : undefined,
      event: typeof messageEvent === "string" ? messageEvent : undefined,
      id: typeof messageId === "number" ? messageId : undefined,
      parseResult: value === null ? "invalid-json" : typeof value,
      messagePreview: truncateMessage(messageText),
    };

    defaultLogger.warn(
      `Unknown multiplexer control message: ${JSON.stringify(categories)}`,
    );
    getDriverReportService()?.report(
      "multiplexer_unknown_control_message",
      null,
      categories,
    );
  }
}

function getOperationTimeout(params: unknown): number | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  const timeout = params.timeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0) {
    return undefined;
  }

  return timeout;
}

function createRpcError(error: ControlRpcError): Error {
  const rpcError = new Error(error.message);
  rpcError.name = error.code;
  return rpcError;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString();
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString();
  }

  return data.toString();
}

function truncateMessage(message: string): string {
  if (message.length <= UNKNOWN_CONTROL_MESSAGE_PREVIEW_LIMIT) {
    return message;
  }

  return `${message.slice(0, UNKNOWN_CONTROL_MESSAGE_PREVIEW_LIMIT)}...`;
}
