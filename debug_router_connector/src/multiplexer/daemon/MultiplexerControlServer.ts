// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import path from "path";
import { createServer, Server, Socket } from "net";
import {
  ControlRpcError,
  ControlRpcRequest,
  MultiplexerHandshakeErrorResponse,
  MultiplexerDebugInfo,
  MultiplexerHealthResponse,
  MultiplexerRegisterResponse,
  isMultiplexerHealthRequest,
  isMultiplexerRegisterRequest,
} from "../protocol";
import { ControlEvent } from "../protocol/event";
import { MultiplexerControlTransport } from "../transport/MultiplexerControlTransport";
import { MultiplexerControlConnection } from "./MultiplexerControlConnection";

export type MultiplexerControlHost = {
  isInUse: () => boolean;
  handleControlRpc: (
    controlId: number,
    message: ControlRpcRequest,
  ) => unknown | Promise<unknown>;
  handleControlConnected?: (controlId: number) => void | Promise<void>;
  handleControlDisconnected?: (controlId: number) => void | Promise<void>;
};

export type MultiplexerControlServerOption = {
  host: MultiplexerControlHost;
  controlEndpoint: string;
  protocolVersion: number;
  debugInfo?: MultiplexerDebugInfo;

  // only used for testing or embedding
  now?: () => number;
};

export class MultiplexerControlServer {
  readonly controlEndpoint: string;
  readonly connections: Map<number, MultiplexerControlConnection> = new Map();

  private readonly host: MultiplexerControlHost;
  private readonly option: MultiplexerControlServerOption;
  private readonly now: () => number;
  private readonly provisionalTransports = new Set<MultiplexerControlTransport>();
  private server: Server | null = null;
  private nextControlId = 1;

  constructor(option: MultiplexerControlServerOption) {
    this.option = option;
    this.host = option.host;
    this.controlEndpoint = option.controlEndpoint;
    this.now = option.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    if (process.platform !== "win32") {
      fs.mkdirSync(path.dirname(this.controlEndpoint), { recursive: true });
    }

    const server = createServer((socket) => this.handleSocket(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup();
        this.server = null;
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.controlEndpoint);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;

    const closePromises: Promise<void>[] = [];
    for (const transport of Array.from(this.provisionalTransports)) {
      closePromises.push(transport.end());
    }
    this.provisionalTransports.clear();
    for (const connection of Array.from(this.connections.values())) {
      closePromises.push(connection.close());
    }
    this.connections.clear();

    await Promise.all([...closePromises, closeNetServer(server)]);
    if (process.platform !== "win32") {
      removeSocketFile(this.controlEndpoint);
    }
  }

  private handleSocket(socket: Socket): void {
    const transport = new MultiplexerControlTransport(socket);
    this.provisionalTransports.add(transport);
    let receivedFirstMessage = false;

    const unsubscribeMessage = transport.onMessage((message) => {
      if (receivedFirstMessage) {
        return;
      }
      receivedFirstMessage = true;
      unsubscribeMessage();

      if (isMultiplexerHealthRequest(message)) {
        const debugInfo = this.createDebugInfo();
        const response: MultiplexerHealthResponse = {
          kind: "health-response",
          ok: true,
          protocolVersion: this.option.protocolVersion,
          isInUse: this.host.isInUse(),
          ...(debugInfo ? { debugInfo } : {}),
        };
        transport.send(response);
        void transport.end();
        return;
      }

      if (isMultiplexerRegisterRequest(message)) {
        const response: MultiplexerRegisterResponse = {
          kind: "register-response",
          ok: true,
        };
        try {
          transport.send(response);
        } catch (_error) {
          transport.destroy(
            _error instanceof Error ? _error : new Error(String(_error)),
          );
          return;
        }
        const connection = this.registerConnection(transport);
        void this.host.handleControlConnected?.(connection.controlId);
        return;
      }

      const response: MultiplexerHandshakeErrorResponse = {
        kind: "handshake-error-response",
        error: {
          code: "invalid-control-handshake",
          message:
            "First control message must be a valid health or register request",
        },
      };
      if (transport.writable) {
        transport.send(response);
        void transport.end();
      } else {
        transport.destroy();
      }
    });

    transport.onClose(() => {
      unsubscribeMessage();
      this.provisionalTransports.delete(transport);
    });
  }

  registerConnection(
    transport: MultiplexerControlTransport,
  ): MultiplexerControlConnection {
    this.provisionalTransports.delete(transport);
    const controlId = this.nextControlId++;
    const connection = new MultiplexerControlConnection({
      controlId,
      transport,
      onMessage: (id, message) => this.dispatchRpc(id, message),
      onClose: (id) => this.unregisterConnection(id),
      ...(this.option.debugInfo
        ? { createDebugInfo: () => this.createDebugInfo() }
        : {}),
    });

    this.connections.set(controlId, connection);
    return connection;
  }

  unregisterConnection(controlId: number): void {
    this.connections.delete(controlId);
    void this.host.handleControlDisconnected?.(controlId);
  }

  async dispatchRpc(
    controlId: number,
    message: ControlRpcRequest,
  ): Promise<void> {
    const connection = this.connections.get(controlId);
    if (!connection || connection.closed) {
      return;
    }

    try {
      const result = await this.host.handleControlRpc(controlId, message);
      connection.sendResponse(message.id, result);
    } catch (error) {
      connection.sendError(message.id, createRpcError(error));
    }
  }

  broadcast(event: ControlEvent): void {
    for (const connection of this.connections.values()) {
      connection.send(event);
    }
  }

  sendToControl(controlId: number, event: ControlEvent): void {
    this.connections.get(controlId)?.send(event);
  }

  private createDebugInfo(
    timestamp: number = this.now(),
  ): MultiplexerDebugInfo | undefined {
    if (!this.option.debugInfo) {
      return undefined;
    }

    return {
      ...this.option.debugInfo,
      protocolVersion: this.option.protocolVersion,
      processId: process.pid,
      timestamp,
    };
  }
}

function createRpcError(error: unknown): ControlRpcError {
  if (isControlRpcError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  return {
    code: "control-rpc-failed",
    message:
      error instanceof Error ? error.message : "Multiplexer control RPC failed",
  };
}

function isControlRpcError(error: unknown): error is ControlRpcError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as ControlRpcError).code === "string" &&
    typeof (error as ControlRpcError).message === "string"
  );
}

function closeNetServer(server: Server | null): Promise<void> {
  if (!server || !server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function removeSocketFile(endpoint: string): void {
  try {
    fs.rmSync(endpoint, { force: true });
  } catch (_error) {
    // Endpoint cleanup is best effort after the server has stopped.
  }
}
