// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { IRemoteDebugDriverProxy } from "./proxy-point";
import { Klass4WebsocketClient } from "./ws-client";
import {
  IClientDescriptor,
  SocketEvents,
  ITypedSocketMessage,
  ISocketMessage,
} from "../../proxy";
import { ICustomDataWrapper, ECustomDataType } from "./custom";

export interface IRemoteDebugServerDriverOption {
  proxy?: IRemoteDebugDriverProxy;
  floatWindowUrl: string;
  host: string;
  sharedHost: boolean;
  socketServer: string;
  klass4WebsocketImpl: Klass4WebsocketClient;
  clientType?: string;
}

export enum ERemoteDebugDriverExternalEvent {
  RoomJoined = "RoomJoined",
  RoomLeaved = "RoomLeaved",
  Close = "Close",
  Connect = "Connect",
  ClientList = "ClientList",
  SessionList = "SessionList",
  CDP = "CDP",
  PingPongDelay = "PingPongDelay",
  R2DStopAtEntry = "R2DStopAtEntry",
  R2DStopLepusAtEntry = "R2DStopLepusAtEntry",
  RemoteCall = "RemoteCall",
  UsbConnect = "UsbConnect",
  UsbConnectAck = "UsbConnectAck",
  HMR = "HMR",
  All = "All",
}

export enum ERemoteDebugDriverInternalEvent {
  I = "I",
}

export interface IRemoteDebugDriverEvent2Payload {
  [ERemoteDebugDriverExternalEvent.RoomJoined]: ITypedSocketMessage<SocketEvents.RoomJoined>["data"];
  [ERemoteDebugDriverExternalEvent.RoomLeaved]: ITypedSocketMessage<SocketEvents.RoomLeaved>["data"];
  [ERemoteDebugDriverExternalEvent.Close]: void;
  [ERemoteDebugDriverExternalEvent.Connect]: void;
  [ERemoteDebugDriverInternalEvent.I]: void;
  [ERemoteDebugDriverExternalEvent.ClientList]: IClientDescriptor[];
  [ERemoteDebugDriverExternalEvent.SessionList]: ICustomDataWrapper<ECustomDataType.SessionList>;
  [ERemoteDebugDriverExternalEvent.CDP]: ICustomDataWrapper<ECustomDataType.CDP>;
  [ERemoteDebugDriverExternalEvent.PingPongDelay]: number;
  [ERemoteDebugDriverExternalEvent.R2DStopAtEntry]: ICustomDataWrapper<ECustomDataType.R2DStopAtEntry>;
  [ERemoteDebugDriverExternalEvent.R2DStopLepusAtEntry]: ICustomDataWrapper<ECustomDataType.R2DStopLepusAtEntry>;
  [ERemoteDebugDriverExternalEvent.RemoteCall]: ICustomDataWrapper<ECustomDataType.RemoteCall>;
  [ERemoteDebugDriverExternalEvent.UsbConnect]: ICustomDataWrapper<ECustomDataType.UsbConnect>;
  [ERemoteDebugDriverExternalEvent.UsbConnectAck]: ICustomDataWrapper<ECustomDataType.UsbConnectAck>;
  [ERemoteDebugDriverExternalEvent.HMR]: ICustomDataWrapper<ECustomDataType.HMR>;
  [ERemoteDebugDriverExternalEvent.All]: ISocketMessage<unknown>;
}

// this is for type check
export type ERemoteDebugDriverEventNames =
  | ERemoteDebugDriverExternalEvent
  | ERemoteDebugDriverInternalEvent;
type ERemoteDebugDriverEventNamesFromPayload =
  keyof IRemoteDebugDriverEvent2Payload;
const a: ERemoteDebugDriverEventNames =
  {} as any as ERemoteDebugDriverEventNamesFromPayload;
const b: ERemoteDebugDriverEventNamesFromPayload =
  {} as any as ERemoteDebugDriverEventNames;

export interface IRemoteDebugServer4Driver {
  start(option: IRemoteDebugServerDriverOption, roomId?: string): Promise<void>;
  getRemoteDebugAppSchema(prefix?: string, floatingWindow?: boolean): string;
  getSocketServer(): string | undefined;
  getDevtoolSiteUrl(): string;
  getRoomId(): string;
  stop(): Promise<void>;
  on<T extends ERemoteDebugDriverEventNames>(
    name: T,
    callback: (payload: IRemoteDebugDriverEvent2Payload[T]) => void
  ): void;
  off<T extends ERemoteDebugDriverEventNames>(
    name: T,
    callback: (payload: IRemoteDebugDriverEvent2Payload[T]) => void
  ): void;
  sendCustomMessage(customData: ICustomDataWrapper<any>): void;
}
