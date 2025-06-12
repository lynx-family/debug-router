// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { BaseDevice } from "../device/BaseDevice";
import { UsbClient } from "../usb/Client";
import { WebSocketClient } from "../websocket/WebSocketConnection";
import { Client } from "../connector/Client";

export type ClientInfo = {
  app: string;
  sdkVersion: string;
  type: "CDP" | "Config";
  port: number;
};

export enum SocketEvent {
  Register = "Register",
  Customized = "Customized",
  Initialize = "Initialize",
  App = "App",
}

export enum CustomizedEventType {
  CDP = "CDP",
  OpenCard = "OpenCard",
  SetGlobalSwitch = "SetGlobalSwitch",
  GetGlobalSwitch = "GetGlobalSwitch",
  SessionList = "SessionList",
  App = "App",
}

export enum DeviceOS {
  Android = "Android",
  iOS = "iOS",
  Harmony = "Harmony",
  Mac = "Mac",
  Windows = "Windows",
  Linux = "Linux",
  Network = "Network",
}

export type DeviceInfo = {
  id: string;
  name: string;
  platform: string;
};

export type DeviceDescription = {
  readonly os: string;
  readonly title: string;
  readonly serial: string;
};

export type ClientQuery = {
  readonly app: string;
  readonly os: string; // get from connector
  readonly device: string; // get from connector
  readonly device_model: string; // get from (DebugRouter and connector)
  readonly device_id: string; // get from connector
  readonly sdk_version?: string;
  readonly raw_info?: any;
};

export type ClientDescription = {
  readonly port: number;
  readonly id: number;
  readonly query: ClientQuery;
};

export type CDPEventMessage = {
  id?: never;
  result?: never;
  error?: never;
  method: string;
  params: any;
};

export type DebugerRouterDriverEvents = {
  "device-connected": BaseDevice;
  "device-disconnected": BaseDevice;
  "client-connected": UsbClient;
  "client-disconnected": number;
  // usb-app
  "usb-client-message": {
    id: number;
    message: string;
  };
  // websocket-app
  "ws-client-message": {
    id: number;
    message: string;
  };
  // websocket-web
  "ws-web-message": {
    id: number;
    message: string;
  };
  "websocket-app-client-connected": WebSocketClient;
  "websocket-app-client-disconnected": number;
  "websocket-web-client-connected": WebSocketClient;
  "websocket-web-client-disconnected": number;
  "app-client-connected": Client;
  "app-client-disconnected": number;
};

export type ServerErrorType = {
  code: number;
  message: string;
};

export type RegisterResponseType = {
  event: SocketEvent.Register;
  data: {
    id: number;
    info: {
      app?: string;
      appVersion?: string;
      deviceModel?: string;
      network?: string;
      osVersion?: string;
      sdkVersion?: string;
    };
  };
};

export type SessionInfoType = {
  type: string;
  session_id: number;
  url: string;
};

export type SessionListType = {
  type: CustomizedEventType.SessionList;
  data: Array<SessionInfoType>;
  sender: number;
};

export type CDPResponseType = {
  type: string;
  data: {
    client_id: number;
    session_id: number;
    message: string;
  };
  sender: number;
};

export type OpenCardResponseType = {
  type: CustomizedEventType.OpenCard;
  data: {
    type: string;
    url: string;
  };
  sender: number;
};

export type CustomizeResponseType = {
  event: "Customized";
  data: CDPResponseType | SessionListType | OpenCardResponseType;
};

export type ResponseMessageType = CustomizeResponseType | RegisterResponseType;

export type InitializeMessageType = {
  event: "Initialize";
  data: number;
};

export type CustomizeMessageType = {
  event: "Customized";
  data: {
    type: string;
    data: {
      client_id: number;
      session_id: number;
      message: any;
    };
    sender: number;
  };
};

export type RequireMessageType = CustomizeMessageType | InitializeMessageType;

export type EventHandler = (...params: any[]) => void;
export type CDPEventHandler = (
  eventName: string,
  params: any,
  session_id: any,
) => void;

export function isTypedSocketMessage<T extends SocketEvent>(
  message: any | undefined,
  event: T,
): boolean {
  return message?.event === event;
}

export function isCustomizedEventType<T extends CustomizedEventType>(
  message: any | undefined,
  type: T,
): boolean {
  return message?.event === SocketEvent.Customized
    ? message?.data?.type === type
    : false;
}
