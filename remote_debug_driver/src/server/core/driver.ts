// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {
  SocketEvents,
  decodeSocketMessage,
  IClientDescriptor,
  encodeSocketMessage,
  ITypedSocketMessage,
  isTypedSocketMessage,
} from "../../proxy";

import { v4 } from "uuid";
import {
  ERemoteDebugDriverEventNames,
  IRemoteDebugDriverEvent2Payload,
  IWebSocketClient,
  IRemoteDebugServer4Driver,
  IRemoteDebugServerDriverOption,
  IRemoteDebugDriverProxy,
  ERemoteDebugDriverExternalEvent,
} from "../interface";
import {
  isTypedCustomData,
  ECustomDataType,
  ICustomDataWrapper,
  createCustomData,
} from "../interface/custom";

const enum ERemoteDebugDriverStatus {
  waiting,
  connecting,
  connected,
  joined,
}

export class RemoteDebugDriver implements IRemoteDebugServer4Driver {
  private client?: IWebSocketClient;
  private status: ERemoteDebugDriverStatus = ERemoteDebugDriverStatus.waiting;
  private proxy?: IRemoteDebugDriverProxy;
  private roomId?: string;
  private socketServer?: string;
  private readonly eventHandlers: Map<
    ERemoteDebugDriverEventNames,
    Set<(payload: any) => void>
  > = new Map();
  private deviceId?: number;
  private readonly timer?: ReturnType<typeof setInterval>;
  private lastPingTime?: number;
  private clientType?: string;
  private clientInfo?: any;
  private floatWindowUrl?: string;
  private host?: string;
  private sharedHost?: boolean;
  private startPromiseResolve?: (value?: any) => void;
  private sessionListRecord?: Record<
    number | string,
    ICustomDataWrapper<ECustomDataType.SessionList>
  >;
  private token?: string;
  public start(
    option: IRemoteDebugServerDriverOption,
    roomId?: string,
    clientInfo?: any
  ) {
    this.proxy = option.proxy;
    this.roomId = roomId || v4();
    this.socketServer = option.socketServer;
    this.clientType = option.clientType ?? "Driver";
    this.clientInfo = clientInfo;
    this.floatWindowUrl = option.floatWindowUrl;
    this.host = option.host;
    this.sharedHost = option.sharedHost;

    return new Promise<any>((resolve) => {
      const klass = option.klass4WebsocketImpl;
      this.startPromiseResolve = resolve;
      if (this.sharedHost) {
        this.socketServer = `${this.socketServer}/${this.roomId}`;
      }
      this.client = new klass(this.socketServer ?? "");
      this.client.onMessage(this.onMessage.bind(this));
      this.client.onOpen(this.onOpen.bind(this));
      this.client.onClose(this.onClose.bind(this));
    });
  }
  public getToken(): string {
    return this.token ?? "";
  }
  public getRoomId(): string {
    return this.roomId ?? "";
  }
  public getDeviceId(): number {
    return this.deviceId ?? 0;
  }
  private sendPing() {
    this.lastPingTime = Date.now();
    this.client?.postMessage(
      encodeSocketMessage({
        event: SocketEvents.Ping,
        data: undefined,
      })
    );
  }
  private consumePong() {
    const pongTime = Date.now();
    const distance = pongTime - this.lastPingTime!;
    this.fireEvent(ERemoteDebugDriverExternalEvent.PingPongDelay, distance);
    setTimeout(() => {
      this.sendPing();
    }, 30000);
  }
  private onClose() {
    this.fireEvent(ERemoteDebugDriverExternalEvent.Close, undefined);
  }
  private getSessionList(
    sessionList: ICustomDataWrapper<ECustomDataType.SessionList>
  ) {
    if (!this.sessionListRecord) {
      this.sessionListRecord = {};
    }
    const hostId: number = sessionList.sender!;
    if (hostId) {
      this.sessionListRecord[hostId] = sessionList;
    }
  }
  public reloadSessionWithUrlForAllClient(url: string, path: string): boolean {
    return this.sendCustomMessageToSessions(
      ECustomDataType.CDP,
      JSON.stringify({
        method: "Page.reload",
      }),
      url,
      path
    );
  }
  public getDevtoolSiteUrl() {
    if (this.proxy && this.proxy.generateDevtoolUrlProxy) {
      return this.proxy.generateDevtoolUrlProxy(
        this.socketServer!,
        this.roomId!
      );
    }
    if (this.sharedHost) {
      return `${this.host}?room=${this.roomId}`;
    } else {
      return `${this.host}?ws=${this.socketServer}&room=${this.roomId}`;
    }
  }

  public getSocketServer() {
    return this.socketServer;
  }

  public getRemoteDebugAppSchema(protocol = "lynx", floatingWindow = true) {
    if (this.proxy && this.proxy.generateRemoteDebugProxy) {
      return this.proxy.generateRemoteDebugProxy(
        protocol,
        this.socketServer!,
        this.roomId!,
        this.floatWindowUrl!
      );
    }
    return (
      `${protocol}://remote_debug_lynx/enable?url=${this.socketServer}&room=${this.roomId}` +
      (floatingWindow ? `&float=${this.floatWindowUrl}` : "")
    );
  }
  public stop() {
    this.client?.close?.();
    return new Promise<any>((r) => r);
  }
  public on<T extends ERemoteDebugDriverEventNames>(
    name: T,
    callback: (payload: IRemoteDebugDriverEvent2Payload[T]) => void
  ) {
    if (this.eventHandlers.has(name)) {
      this.eventHandlers.get(name)?.add(callback);
    } else {
      this.eventHandlers.set(name, new Set([callback]));
    }
  }
  public off<T extends ERemoteDebugDriverEventNames>(
    name: T,
    callback: (payload: IRemoteDebugDriverEvent2Payload[T]) => void
  ) {
    if (this.eventHandlers.has(name)) {
      const callbackList = this.eventHandlers.get(name);
      if (callbackList) {
        callbackList.delete(callback);
      }
    }
  }
  private fireEvent<T extends ERemoteDebugDriverEventNames>(
    event: T,
    payload: IRemoteDebugDriverEvent2Payload[T]
  ) {
    const eventHandlers = this.eventHandlers;
    const handlers = eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((callback) => callback(payload));
    }
  }
  protected onConnected(payload: ITypedSocketMessage<SocketEvents.Initialize>) {
    const deviceId = payload.data; // useless
    this.deviceId = deviceId;
    const deviceData: IClientDescriptor = {
      id: deviceId,
      type: this.clientType,
    };
    if (this.clientType === "runtime") {
      //for usbDebug
      deviceData.info = this.clientInfo;
    }

    this.client?.postMessage(
      encodeSocketMessage({
        event: SocketEvents.Register,
        data: deviceData,
      })
    );
  }
  protected onRegistered(
    payload: ITypedSocketMessage<SocketEvents.Registered>
  ) {
    /**
     * create room
     */
    this.token = payload.token;
    if (!this.roomId) {
      this.client?.postMessage(
        encodeSocketMessage({
          event: SocketEvents.CreateRoom,
          data: undefined,
        })
      );
    } else {
      this.client?.postMessage(
        encodeSocketMessage({
          event: SocketEvents.JoinRoom,
          data: this.roomId,
        })
      );
    }
  }
  protected onOpen() {
    this.status = ERemoteDebugDriverStatus.connected;
    this.fireEvent(ERemoteDebugDriverExternalEvent.Connect, undefined);
  }
  public sendCustomMessage(
    customData: ICustomDataWrapper<any>,
    messageTo?: number
  ) {
    customData.sender = this.deviceId;
    this.client?.postMessage(
      encodeSocketMessage({
        event: SocketEvents.Customized,
        data: customData,
        to: messageTo
          ? messageTo
          : customData.data.client_id > 0
          ? customData.data.client_id
          : undefined,
      })
    );
  }
  private sendCustomMessageToSessions(
    type: ECustomDataType,
    message: string,
    url: string,
    path?: string
  ) {
    if (!this.sessionListRecord) {
      return false;
    }
    const client_ids = Object.keys(this.sessionListRecord).map(($) => +$);
    let founded = false;
    for (const client_id of client_ids) {
      const sessions: ICustomDataWrapper<ECustomDataType.SessionList> =
        this.sessionListRecord[client_id];
      if (sessions) {
        for (const session of sessions.data) {
          const encodedSessionUrl = encodeURIComponent(session.url);
          // Save the original template.js url for comparison
          const originTemplateJsUrl = encodeURIComponent(
            session.url.slice(0, session.url.indexOf("template.js") + 11)
          );
          if (
            session.url.includes(url) ||
            url.includes(session.url) ||
            url.includes(encodedSessionUrl) ||
            url.includes(originTemplateJsUrl)
          ) {
            founded = true;
            this.sendCustomMessage(
              createCustomData(type, {
                session_id: session.session_id,
                client_id,
                message: message,
                url,
                path,
              })
            );
          }
        }
      }
    }
    return founded;
  }
  public sendMessage(payload: any) {
    this.client?.postMessage(
      encodeSocketMessage({
        event: SocketEvents.Customized,
        data: payload,
      })
    );
  }
  private onMessage(message: string) {
    const payload = decodeSocketMessage(message);
    if (payload) {
      this.fireEvent(ERemoteDebugDriverExternalEvent.All, payload);
    }
    if (isTypedSocketMessage(payload, SocketEvents.Pong)) {
      this.consumePong();
      return;
    }
    if (isTypedSocketMessage(payload, SocketEvents.Initialize)) {
      this.onConnected(payload);
      return;
    }
    if (isTypedSocketMessage(payload, SocketEvents.Registered)) {
      this.onRegistered(payload);
      return;
    }
    if (isTypedSocketMessage(payload, SocketEvents.RoomJoined)) {
      this.roomId = payload.data.room;
      this.startPromiseResolve && this.startPromiseResolve();
      this.fireEvent(ERemoteDebugDriverExternalEvent.RoomJoined, payload.data);
      this.client?.postMessage(
        encodeSocketMessage({
          event: SocketEvents.ListClients,
          data: undefined,
        })
      );
      this.sendPing();
      return;
    }
    if (isTypedSocketMessage(payload, SocketEvents.RoomLeaved)) {
      const deleteClientId = `${payload?.data?.id}`;
      if (
        deleteClientId &&
        this.sessionListRecord &&
        Object.keys(this.sessionListRecord).includes(deleteClientId)
      ) {
        delete this.sessionListRecord[deleteClientId];
      }
      this.fireEvent(ERemoteDebugDriverExternalEvent.RoomLeaved, payload.data);
      this.client?.postMessage(
        encodeSocketMessage({
          event: SocketEvents.ListClients,
          data: undefined,
        })
      );
      return;
    }
    if (isTypedSocketMessage(payload, SocketEvents.ClientList)) {
      this.fireEvent(ERemoteDebugDriverExternalEvent.ClientList, payload.data);
      return;
    }
    if (isTypedSocketMessage(payload, SocketEvents.Customized)) {
      const customData = payload.data;
      if (isTypedCustomData(customData, ECustomDataType.SessionList)) {
        this.getSessionList(customData);

        this.fireEvent(ERemoteDebugDriverExternalEvent.SessionList, customData);
        return;
      }
      if (isTypedCustomData(customData, ECustomDataType.UsbConnect)) {
        this.fireEvent(ERemoteDebugDriverExternalEvent.UsbConnect, customData);
      }
      if (isTypedCustomData(customData, ECustomDataType.UsbConnectAck)) {
        this.fireEvent(
          ERemoteDebugDriverExternalEvent.UsbConnectAck,
          customData
        );
      }
      if (isTypedCustomData(customData, ECustomDataType.CDP)) {
        this.fireEvent(ERemoteDebugDriverExternalEvent.CDP, customData);
        return;
      }
      if (isTypedCustomData(customData, ECustomDataType.R2DStopAtEntry)) {
        this.fireEvent(
          ERemoteDebugDriverExternalEvent.R2DStopAtEntry,
          customData
        );
        return;
      }
      if (isTypedCustomData(customData, ECustomDataType.R2DStopLepusAtEntry)) {
        this.fireEvent(
          ERemoteDebugDriverExternalEvent.R2DStopLepusAtEntry,
          customData
        );
        return;
      }
      if (isTypedCustomData(customData, ECustomDataType.RemoteCall)) {
        this.fireEvent(ERemoteDebugDriverExternalEvent.RemoteCall, customData);
        return;
      }
      if (isTypedCustomData(customData, ECustomDataType.HMR)) {
        this.fireEvent(ERemoteDebugDriverExternalEvent.HMR, customData);
        return;
      }
      return;
    }
    if (isTypedSocketMessage(payload, SocketEvents.Exception)) {
      if (payload.data === "NotFound") {
        this.client?.postMessage(
          encodeSocketMessage({
            event: SocketEvents.CreateRoom,
            data: this.roomId ?? undefined,
          })
        );
      }
    }
  }
}
