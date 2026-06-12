// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  ControlRpcError,
  ControlRpcRequest,
  MULTIPLEXER_CONTROL_PATH,
  MULTIPLEXER_HEALTH_PATH,
  MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION,
  MULTIPLEXER_PROTOCOL_VERSION,
  MultiplexerHealthResponse,
} from "../protocol";
import { ControlEvent } from "../protocol/event";
import { MultiplexerControlConnection } from "./MultiplexerControlConnection";

export const DEFAULT_MULTIPLEXER_HEALTH_PATH = MULTIPLEXER_HEALTH_PATH;
export const DEFAULT_MULTIPLEXER_CONTROL_PATH = MULTIPLEXER_CONTROL_PATH;

export type MultiplexerControlHost = {
  handleControlRpc: (
    controlId: number,
    message: ControlRpcRequest,
  ) => unknown | Promise<unknown>;
  handleControlConnected?: (controlId: number) => void | Promise<void>;
  handleControlDisconnected?: (controlId: number) => void | Promise<void>;
};

export type MultiplexerControlServerOption = {
  host: MultiplexerControlHost;
  controlPort?: number;
  healthPath?: string;
  controlPath?: string;
  protocolVersion?: number;
  minSupportedProtocolVersion?: number;
  daemonVersion?: string;
  capabilities?: string[];

  // only used for testing or embedding
  now?: () => number;
};

export class MultiplexerControlServer {
  readonly healthPath: string;
  readonly controlPath: string;
  readonly connections: Map<number, MultiplexerControlConnection> = new Map();

  private readonly host: MultiplexerControlHost;
  private readonly option: MultiplexerControlServerOption;
  private readonly now: () => number;
  private server: Server | null = null;
  private websocketServer: WebSocketServer | null = null;
  private controlPortValue = 0;
  private nextControlId = 1;

  constructor(option: MultiplexerControlServerOption) {
    this.option = option;
    this.host = option.host;
    this.healthPath = option.healthPath ?? DEFAULT_MULTIPLEXER_HEALTH_PATH;
    this.controlPath = option.controlPath ?? DEFAULT_MULTIPLEXER_CONTROL_PATH;
    this.controlPortValue = option.controlPort ?? 0;
    this.now = option.now ?? Date.now;
  }

  get controlPort(): number {
    return this.controlPortValue;
  }

  async start(port: number = this.controlPortValue): Promise<void> {
    if (this.server) {
      return;
    }

    const websocketServer = new WebSocketServer({ noServer: true });
    const server = createServer((request, response) => {
      if (this.matchesPath(request, this.healthPath)) {
        this.handleHealth(request, response);
        return;
      }

      this.writeJson(response, 404, {
        ok: false,
        error: "not-found",
      });
    });

    server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });

    this.server = server;
    this.websocketServer = websocketServer;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup();
        this.server = null;
        this.websocketServer = null;
        reject(error);
      };
      const onListening = () => {
        cleanup();
        this.controlPortValue = this.resolveListeningPort(server);
        resolve();
      };
      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    const websocketServer = this.websocketServer;

    this.server = null;
    this.websocketServer = null;
    this.controlPortValue = this.option.controlPort ?? 0;

    for (const connection of Array.from(this.connections.values())) {
      connection.close();
    }
    this.connections.clear();

    await Promise.all([
      closeWebSocketServer(websocketServer),
      closeHttpServer(server),
    ]);
  }

  handleHealth(_request: IncomingMessage, response: ServerResponse): void {
    const payload: MultiplexerHealthResponse = {
      ok: true,
      pid: process.pid,
      protocolVersion:
        this.option.protocolVersion ?? MULTIPLEXER_PROTOCOL_VERSION,
      minSupportedProtocolVersion: this.option.minSupportedProtocolVersion ??
        MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION,
      heartbeat: this.now(),
      daemonVersion: this.option.daemonVersion,
      capabilities: this.option.capabilities
        ? [...this.option.capabilities]
        : undefined,
    };

    this.writeJson(response, 200, payload);
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer = Buffer.alloc(0),
  ): void {
    if (!this.websocketServer || !this.matchesPath(request, this.controlPath)) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      this.registerConnection(websocket);
    });
  }

  registerConnection(socket: WebSocket): MultiplexerControlConnection {
    const controlId = this.nextControlId++;
    const connection = new MultiplexerControlConnection({
      controlId,
      socket,
      onMessage: (id, message) => this.dispatchRpc(id, message),
      onClose: (id) => this.unregisterConnection(id),
    });

    this.connections.set(controlId, connection);
    void this.host.handleControlConnected?.(controlId);
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

  private matchesPath(request: IncomingMessage, path: string): boolean {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    return url.pathname === path;
  }

  private resolveListeningPort(server: Server): number {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve multiplexer control server port");
    }

    return (address as AddressInfo).port;
  }

  private writeJson(
    response: ServerResponse,
    statusCode: number,
    payload: unknown,
  ): void {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }
}

function createRpcError(error: unknown): ControlRpcError {
  if (isControlRpcError(error)) {
    return error;
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

function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  message: string,
): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` + "Connection: close\r\n" + "\r\n",
  );
  socket.destroy();
}

function closeHttpServer(server: Server | null): Promise<void> {
  if (!server || !server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function closeWebSocketServer(
  websocketServer: WebSocketServer | null,
): Promise<void> {
  if (!websocketServer) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    websocketServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
