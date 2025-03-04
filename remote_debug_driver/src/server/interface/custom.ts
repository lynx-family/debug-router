// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export enum ECustomDataType {
  ClientList = "ClientList",
  SessionList = "SessionList",
  CDP = "CDP",
  D2RStopAtEntry = "D2RStopAtEntry",
  R2DStopAtEntry = "R2DStopAtEntry",
  D2RStopLepusAtEntry = "D2RStopLepusAtEntry",
  R2DStopLepusAtEntry = "R2DStopLepusAtEntry",
  OpenCard = "OpenCard",
  CardGenerated = "CardGenerated",
  UsbConnect = "UsbConnect",
  UsbConnectAck = "UsbConnectAck",
  HMR = "HMR",
  RemoteCall = "RemoteCall",
}

export interface ICustomDataContent extends Record<ECustomDataType, unknown> {
  ClientList: (
    | { id: number; type: "Driver" }
    | {
        id: number;
        type: "runtime";
        info: Record<string, any>;
        reconnect: boolean;
      }
  )[];
  SessionList: {
    session_id: number;
    type: "" | "web" | "worker";
    url: string;
  }[];
  CDP: {
    session_id: number;
    client_id: number;
    message: string;
    path?: string;
    url?: string;
  };
  D2RStopAtEntry: { client_id: number; stop_at_entry: boolean };
  R2DStopAtEntry: boolean;
  D2RStopLepusAtEntry: { client_id: number; stop_at_entry: boolean };
  R2DStopLepusAtEntry: boolean;
  OpenCard:
    | { type: "url"; url: string }
    | { type: "base64"; base64: string }
    | { type: "buffer"; buffer: Buffer };
  CardGenerated: {
    targetSdkVersion?: string;
    entry: string;
    name?: string;
    address: string;
  }[];
  UsbConnect: { device: string; platform: string }[];
  UsbConnectAck: { device: string; platform: string };
  HMR: { session_id: number; client_id: number; message: string };
  RemoteCall: { session_id: number; client_id: number; message: string };
}

export interface ICustomDataWrapper<T extends ECustomDataType> {
  data: ICustomDataContent[T];
  sender?: number;
  type: T;
}

export function isTypedCustomData<T extends ECustomDataType>(
  payload: any,
  type: T
): payload is ICustomDataWrapper<T> {
  return payload && payload.type && payload.type === type;
}

export function createCustomData<T extends ECustomDataType>(
  type: T,
  data: ICustomDataContent[T]
): ICustomDataWrapper<T> {
  return {
    type,
    data,
  };
}
