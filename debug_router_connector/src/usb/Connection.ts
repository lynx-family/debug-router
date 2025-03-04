// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import EventEmitter from "events";
import {
  CDPEventHandler,
  EventHandler,
  RequireMessageType,
  ResponseMessageType,
} from "../utils/type";

export interface PendingRequestResolvers {
  resolve: (data: ResponseMessageType) => void;
  reject: (err: Error) => void;
}

export abstract class Connection {
  private readonly events = new EventEmitter();
  protected pendingRequests: Map<string, PendingRequestResolvers> = new Map();
  abstract close(): void;
  abstract send(data: any): void;
  abstract sendExpectResponse(
    data: RequireMessageType,
  ): Promise<ResponseMessageType>;

  handleClientEvent(event: string, params: any, session_id: any) {
    this.events.emit(event, params, session_id);
    this.events.emit("all-cdp-message", event, params, session_id);
  }

  handleSessionList(sessionList: any) {
    this.events.emit("SessionList", sessionList);
  }

  on(event: string, callback: EventHandler) {
    this.events.on(event, callback);
  }

  onAllEvents(callback: CDPEventHandler) {
    this.events.on("all-cdp-message", callback);
  }

  off(event: string, callback: EventHandler) {
    this.events.off(event, callback);
  }

  offAllEvents(callback: CDPEventHandler) {
    this.events.off("all-cdp-message", callback);
  }

  once(event: string, callback: EventHandler) {
    this.events.once(event, callback);
  }

  matchPendingRequest(id: string): PendingRequestResolvers {
    const callbacks = this.pendingRequests.get(id);

    if (!callbacks) {
      // @ts-ignore
      return;
    }

    this.pendingRequests.delete(id);
    // @ts-ignore
    return callbacks;
  }
}
