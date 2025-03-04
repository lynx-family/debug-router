// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

/// <reference lib="dom" />

import {
  IWebSocketClient,
  RemoteDebugDriver,
  IRemoteDebugServer4Driver,
  IRemoteDebugServerDriverOption,
} from "../server";

export const enum EWebsocketClientStatus {
  created,
  opened,
}

export class WSClientImpl implements IWebSocketClient {
  private readonly socketUrl: string;
  private ws!: WebSocket;
  private status: EWebsocketClientStatus = EWebsocketClientStatus.created;
  private openCallback?: () => void;
  private closeCallback?: () => void;
  private messageCallback?: (message: string) => void;
  public constructor(url: string) {
    this.socketUrl = url;
    this.Initialize();
  }
  private Initialize() {
    this.ws = new WebSocket(this.socketUrl);
    setTimeout(() => {
      if (this.status !== EWebsocketClientStatus.opened) {
        this.ws.close();
      }
    }, 2000);
    this.ws.addEventListener("open", () => {
      this.status = EWebsocketClientStatus.opened;
      if (this.openCallback) {
        this.openCallback();
      }
    });
    this.ws.addEventListener("message", (event) => {
      const data = event.data;
      if (this.messageCallback) {
        this.messageCallback(data.toString());
      } else {
        throw new Error(`dropped message ${data.toString()}`);
      }
    });
    this.ws.addEventListener("error", (err) => {
      if (this.closeCallback) {
        this.closeCallback();
      }
    });
    this.ws.addEventListener("close", () => {
      if (this.closeCallback) {
        this.closeCallback();
      }
    });
  }
  public postMessage(payload: string) {
    this.ws.send(payload);
  }
  public onMessage(cb: (message: string) => void): void {
    this.messageCallback = cb;
  }
  public onOpen(cb: () => void): void {
    if (this.status === EWebsocketClientStatus.created) {
      this.openCallback = cb;
    } else {
      cb();
    }
  }
  public close(): void {
    this.ws.close();
  }
  public onClose(cb: () => void): void {
    this.closeCallback = cb;
  }
}

export async function createRemoteDebugDriver(
  endpoint: string,
  room?: string
): Promise<IRemoteDebugServer4Driver> {
  const instance = new RemoteDebugDriver();
  await instance.start(
    {
      klass4WebsocketImpl: WSClientImpl,
      socketServer: endpoint,
      sharedHost: false,
    } as unknown as IRemoteDebugServerDriverOption,
    room
  );
  return instance;
}

export * from "../server";
