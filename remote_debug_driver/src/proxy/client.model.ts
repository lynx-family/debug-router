// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { IAbstractSocketConnection } from "./socket.model";
import type { ISocketMessage } from "./message.model";

/**
 * Options for HTTP message server
 */
export interface IHttpServerOptions {
  /**
   * Server route
   */
  route?: string;

  /**
   * Request timeout number
   */
  timeout?: number;
}

/**
 * Full information of one connection
 */
export interface IConnection {
  /**
   * Descriptor of connection
   */
  readonly descriptor: IClientDescriptor;

  /**
   * Instance of connection
   */
  readonly connection: IAbstractSocketConnection;

  /**
   * Message handler of connection
   * @param data Message data
   */
  messageHandlers: Set<(data: string | ISocketMessage<any>) => void>;

  /**
   * Error handler of connection
   * @param error Error content
   */
  errorHandlers: Set<(error: Error) => void>;
}

/**
 * Information for connection request
 */
export interface IRequestInfo {
  /**
   * ${ip}:${port}
   */
  remoteAddr: string;
  /**
   * info injected by client
   */
  did: string;
  appId: string;
  osType: string;
}

/**
 * Information for client connection
 */
export interface IClientDescriptor extends Record<string, any> {
  /**
   * ID of the client
   */
  id: number;

  /**
   * Room ID of the client that currently joined, should not be sent in registration phase.
   */
  room?: string;

  /**
   * HTTP access token
   */
  token?: string;

  /**
   * IP address of the client
   */
  ipAddress?: string;

  /**
   * Extra info injected by client
   */
  info?: Record<string, any>;

  /**
   * Type of client: Driver | runtime | CLI | ...
   */
  type?: string;
}

/**
 * Client record
 */
export interface IClient {
  /**
   * Client descriptor
   */
  readonly descriptor: IClientDescriptor;

  /**
   * Client socket connection
   */
  readonly connection: IAbstractSocketConnection;
}
