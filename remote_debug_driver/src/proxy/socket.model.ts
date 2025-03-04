// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { IncomingMessage } from "http";

/**
 * Common structures for socket connection
 */
export interface IAbstractSocketConnection {
  /**
   * Handle socket OnOpen event
   * @param event Event type
   * @param listener Event listener
   */
  on(event: "open", listener: (this: IAbstractSocketConnection) => void): this;

  /**
   * Handle socket onClose event
   * @param event Event type
   * @param listener Event listener
   */
  on(event: "close", listener: (this: IAbstractSocketConnection) => void): this;

  /**
   * Handle socket error
   * @param event Event type
   * @param listener Event listener
   */
  on(
    event: "error",
    listener: (this: IAbstractSocketConnection, error: any) => void
  ): this;

  /**
   * Handle socket message
   * @param event Event type
   * @param listener Event listener
   */
  on(
    event: "message",
    listener: (this: IAbstractSocketConnection, data: string) => void
  ): this;

  /**
   * Remove socket event listener
   * @param event Event type
   * @param listener Event listener
   */
  off(event: string, listener: (...args: any[]) => void): this;

  /**
   * Remove all listeners from given type
   * @param event Event type
   */
  removeAllListeners(event: string): this;

  /**
   * Send data via socket connection
   * @param data Data content
   */
  send(data: string): void;

  /**
   * Close socket connection
   * @param event Code and reason of close action
   */
  close(event?: { code?: number; data?: string }): void;
}

/**
 * Acceptable socket response data types
 */
export type SocketData = string | Buffer | ArrayBuffer | Buffer[];

/**
 * Common structures for socket server
 */
export interface IAbstractSocketServer {
  close(cb?: (err?: Error) => void): void;
  on(
    event: "connection",
    cb: (
      this: IAbstractSocketServer,
      socket: IAbstractSocketConnection,
      request: IncomingMessage
    ) => void
  ): this;
  on(
    event: "error",
    cb: (this: IAbstractSocketServer, error: Error) => void
  ): this;
  on(
    event: "close" | "listening",
    cb: (this: IAbstractSocketServer) => void
  ): this;
  off(
    event: "connection",
    cb: (
      this: IAbstractSocketServer,
      socket: IAbstractSocketConnection,
      request: IncomingMessage
    ) => void
  ): this;
  off(
    event: "error",
    cb: (this: IAbstractSocketServer, error: Error) => void
  ): this;
  off(
    event: "close" | "listening",
    cb: (this: IAbstractSocketServer) => void
  ): this;
}

/**
 * Logger interface
 */
export interface ICustomLogImpl {
  verbose(message: string, extra?: Record<string, any>): void;
  debug(message: string, extra?: Record<string, any>): void;
  info(message: string, extra?: Record<string, any>): void;
  warn(message: string, extra?: Record<string, any>): void;
  error(message: string, extra?: Record<string, any>): void;
  fatal(message: string, extra?: Record<string, any>): void;
}
export enum ServerLogLevel {
  verbose = 0,
  debug = 1,
  info = 2,
  warn = 3,
  error = 4,
  fatal = 5,
}
export interface ServerLoggerOptions {
  // log level being printed in terminal, default info
  printLogLevel?: ServerLogLevel;
  // log level being uploaded to storage server, default debug
  uploadLogLevel?: ServerLogLevel;
  // count of logs in a batch
  batchCount?: number;
  // total size of logs in a batch
  batchSize?: number;
  // flush delay of logs
  batchFlushDelay?: number;
}

/**
 * Event tracks interface
 */
export enum ServerEventTrackType {
  ClientConnect = "client_connect",
  ServerInitClient = "server_init_client",
  ClientRegister = "client_register",
  ClientRegisterFailed = "client_register_failed",
  ServerRegisteredClient = "server_registered_client",
  ClientConnectError = "client_connect_error",
  ClientConnectClose = "client_connect_close",
  ClientJoinRoom = "client_join_room",
  ClientJoinRoomFailed = "client_join_room_failed",
  ClientRoomJoined = "client_room_joined",
}
