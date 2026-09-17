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
const MULTIPLEXER_CONNECT_TIMEOUT = 1000;
const MULTIPLEXER_CONNECT_MAX_ATTEMPTS = 3;
const MULTIPLEXER_CONNECT_RETRY_DELAY = 100;
const RPC_TIMEOUT_BUFFER_MS = 1000;
const UNKNOWN_CONTROL_MESSAGE_PREVIEW_LIMIT = 500;

export type MultiplexerDaemonClientOption = {
  /**
   * daemonManager: Manages daemon startup and readiness before connecting.
   * controlEndpoint: Unix domain socket path or Windows named pipe for control connections.
   * rpcTimeout: Default RPC response timeout in milliseconds; defaults to 5000.
   * debugInfo: Optional diagnostic metadata attached to registration and RPC messages.
   */
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
  private closed = false;
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
    // Sends a function call to the Host for execution via RPC.
    this.assertValidRpcParams(method, params);

    /**
     * Set ensureDaemon to false only when sending a shutdown RPC.
     * Daemon startup may need to shut down an existing daemon; ensuring the daemon
     * again for that RPC would re-enter the startup flow and cause infinite recursion.
     */
    if (ensureDaemon) {
      await this.connect();
    } else {
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
    // Connects to the daemon if not already connected.
    if (this.status === "connected") {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (this.closed) {
      throw new Error("Multiplexer remote client closed");
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
    if (this.closed) {
      throw new Error("Multiplexer remote client closed");
    }
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
      /**
       * Reject the RPC and remove its pending entry if no response arrives in time.
       * Use getRpcTimeout to determine the wait time: 5000ms by default,
       * extended when the RPC params specify a longer timeout.
       */
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

      if (!transport.send(request)) {
        const pending = this.pendingRpc.get(id);
        if (pending) {
          this.pendingRpc.delete(id);
          clearTimeout(pending.timer);
          pending.reject(
            new Error(`Failed to send multiplexer RPC ${method} request`),
          );
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
    if (this.status === "connected") {
      return;
    }

    try {
      // Retry transient failures and recoverable internal errors.
      for (
        let attempt = 0;
        attempt < MULTIPLEXER_CONNECT_MAX_ATTEMPTS;
        attempt++
      ) {
        // Close any existing control connection before creating a new one.
        if (this.controlTransport) {
          await this.closeSocket(
            new Error("Replacing multiplexer control socket"),
          );
        }
        if (this.closed) {
          throw new Error("Multiplexer remote client closed");
        }
        this.status = "connecting";

        // Start or reuse the daemon before registration.
        // Retry if ensureDaemon returns false; stop retrying if it throws an error.
        if (ensureDaemon) {
          if (!(await this.daemonManager.ensureDaemon())) {
            continue;
          }
        }
        try {
          await this.registerTransport();
          return;
        } catch (error) {
          defaultLogger.warn(
            error instanceof Error ? error.message : String(error),
          );
        }

        await new Promise((resolve) =>
          setTimeout(resolve, MULTIPLEXER_CONNECT_RETRY_DELAY),
        );
      }
      throw new Error(
        "Failed to connect to multiplexer daemon after multiple attempts",
      );
    } catch (error) {
      this.status = "disconnected";
      throw error;
    }
  }

  private async registerTransport(): Promise<void> {
    // Opens a control connection and registers with the daemon.
    if (this.closed) {
      throw new Error("Multiplexer remote client closed");
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

    // Wait for the control connection to complete the registration handshake.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanupHandshake = () => {
        clearTimeout(timer);
        unsubscribeConnect();
        unsubscribeMessage();
        unsubscribeClose();
      };

      // Clean up the connection when registration fails.
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

      // Send the register handshake message when the socket connects.
      const onConnect = () => {
        const debugInfo = this.createDebugInfo();
        const request: MultiplexerRegisterRequest = {
          kind: "register",
          ...(debugInfo ? { debugInfo } : {}),
        };
        if (!transport.send(request) && !transport.closed) {
          fail(new Error("Failed to send multiplexer register request"));
        }
      };

      // Validate the register response, then switch to normal message handling.
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

      // Set a timeout for the register response.
      const timer = setTimeout(() => {
        fail(new Error("Timed out waiting for multiplexer register response"));
      }, MULTIPLEXER_CONNECT_TIMEOUT);

      const unsubscribeConnect = transport.onConnect(onConnect);
    });
  }

  private readonly handleTransportClose = (error?: Error): void => {
    void this.closeSocket(
      error ?? new Error("Multiplexer control socket closed"),
    );
  };

  private readonly handleTransportMessage = (value: unknown): void => {
    // Dispatch incoming messages to RPC response or Host event handlers.
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
    // Ignore responses for requests that have already timed out or been cleared.
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
    this.closed = true;
    this.connectPromise = null;
    await this.closeSocket(new Error("Multiplexer remote client closed"));
    this.eventListener = undefined;
    this.connectionEventListener = undefined;
  }

  private async closeSocket(error: Error): Promise<void> {
    // Reset connection state, remove listeners, reject pending RPCs,
    // and close the control transport.
    const transport = this.controlTransport;
    this.controlTransport = null;
    this.status = "disconnected";
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
