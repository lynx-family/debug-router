// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { IClientDescriptor } from "./client.model";

/**
 * Event of room sockets
 */
export enum SocketEvents {
  /**
   * Assign token to new connection
   */
  Initialize = "Initialize",

  /**
   * Register connection to room
   */
  Register = "Register",

  /**
   * Server registered response
   */
  Registered = "Registered",

  /**
   * Create new room
   */
  CreateRoom = "CreateRoom",

  /**
   * New room created
   */
  RoomCreated = "RoomCreated",

  /**
   * Join existed room
   */
  JoinRoom = "JoinRoom",

  /**
   * List all clients inside room
   */
  ListClients = "ListClients",

  /**
   * All clients inside room
   */
  ClientList = "ClientList",

  /**
   * Finished join
   */
  RoomJoined = "RoomJoined",

  /**
   * Unregister connection from room
   */
  LeaveRoom = "LeaveRoom",

  /**
   * Finished unregister
   */
  RoomLeaved = "RoomLeaved",

  /**
   * Close existed room
   */
  CloseRoom = "CloseRoom",

  /**
   * Existed room closed
   */
  RoomClosed = "RoomClosed",

  /**
   * Exception notice
   */
  Exception = "Exception",

  /**
   * Customized event for broadcast message
   */
  Customized = "Customized",

  /**
   * Ping server
   */
  Ping = "Ping",

  /**
   * Response of ping server
   */
  Pong = "Pong",
}

/**
 * Exception codes for socket
 */
export enum SocketExceptions {
  /**
   * Permission denied
   */
  PermissionDenied = "PermissionDenied",
  /**
   * Cannot find target resource
   */
  NotFound = "NotFound",
  /**
   * Action is useless
   */
  UselessAction = "UselessAction",
  /**
   * Command is not recognizable
   */
  UnknownCommand = "UnknownCommand",
  /**
   * RoomId is already exits
   */
  RoomIdAlreadyExists = "RoomIdAlreadyExists",
  /**
   * Cannot send message to self
   */
  CannotSendToSelf = "CannotSendToSelf",
}

/**
 * Structure for socket message content
 */
export interface ISocketMessage<T> {
  /**
   * Connection ID of message sender
   *
   * Will be empty when client send data to server or message is from server
   */
  from?: number;

  /**
   * Connection ID of message receiver
   *
   * Target client must be in the same room with the message sender, otherwise exception will be generated
   */
  to?: number;

  /**
   * Event type of the message. For customize events, make sure to use event number bigger than (and not equal) 255.
   */
  event: SocketEvents;

  /**
   * Data of the message
   */
  data: T;

  /**
   * HTTP access token
   */
  token?: string;

  /**
   * A client generated number to give unique sign to message, usually used by other clients to achieve
   * customized features, which means normally server will not consider or use it. However if message was
   * received from XHR, server will wait until any other message appears in same room with same mark
   * and use it as the response of XHR request.
   */
  mark?: number;
}

/**
 * Record collection of socket event
 * @ignore
 */
type SocketEventRecord<T extends SocketEvents, U, V extends Record<T, U>> = V;

/**
 * Data type of each socket event
 */
export type SocketEventMap = SocketEventRecord<
  SocketEvents,
  any,
  {
    [SocketEvents.Initialize]: number;
    [SocketEvents.Register]: IClientDescriptor;
    [SocketEvents.Registered]: IClientDescriptor;
    [SocketEvents.CreateRoom]: string | undefined;
    [SocketEvents.RoomCreated]: string;
    [SocketEvents.JoinRoom]: string;
    [SocketEvents.RoomJoined]: IClientDescriptor;
    [SocketEvents.LeaveRoom]: void;
    [SocketEvents.RoomLeaved]: IClientDescriptor;
    [SocketEvents.CloseRoom]: void;
    [SocketEvents.RoomClosed]: string;
    [SocketEvents.Exception]: string;
    [SocketEvents.ListClients]: void;
    [SocketEvents.ClientList]: IClientDescriptor[];
    [SocketEvents.Customized]: unknown;
    [SocketEvents.Ping]: void;
    [SocketEvents.Pong]: void;
  }
>;

/**
 * Structure for socket message content with event type
 */
export type ITypedSocketMessage<T extends SocketEvents> = ISocketMessage<
  SocketEventMap[T]
> & { event: T };
