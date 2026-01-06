// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export interface DebugRouterGlobalHandlerHarmony {
  onOpenCard: (url: string) => void;
  onMessage: (message: string, type: string) => void;
}

export interface DebugRouterSessionHandlerHarmony {
  onSessionCreate: (session_id: number, url: string) => void;
  onSessionDestroy: (session_id: number) => void;
  onMessage: (message: string, type: string, session_id: number) => void;
}

export interface DebugRouterMessageHandlerHarmony {
  handle: (params: string) => string;
  getName: () => string;
}

export interface DebugRouterStateListenerHarmony {
  onOpen: (connectionType: string) => void;
  onClose: (code: number, reason: string) => void;
  onMessage: (message: string) => void;
  onError: (error: string) => void;
}

export interface NativeSlotHarmony {
  onMessage: (message: string, type: string, session_id: number) => void;
}

export declare class DebugRouterHarmony {
  static createInstance: () => void;
  static addGlobalHandler: (handler: DebugRouterGlobalHandlerHarmony) => void;
  static removeGlobalHandler: (handler: DebugRouterGlobalHandlerHarmony) => boolean;
  static addSessionHandler: (handler: DebugRouterSessionHandlerHarmony) => void;
  static removeSessionHandler: (handler: DebugRouterSessionHandlerHarmony) => boolean;
  static addMessageHandler: (handler: DebugRouterMessageHandlerHarmony) => void;
  static removeMessageHandler: (handler: DebugRouterMessageHandlerHarmony) => boolean;
  static addStateListener: (listener: DebugRouterStateListenerHarmony) => void;

  static connectAsync: (url: string, room: string) => void;
  static disconnectAsync: () => void;
  static isConnected: () => boolean;

  static sendAsync: (message: string) => void;
  static sendDataAsync: (type: string, session: number, data: string) => void;

  static plug: (slot: NativeSlotHarmony, url:string, type:string) => number;
  static pull: (sessionId: number) => void;

  static isValidSchema: (schema: string) => boolean;
  static handleSchema: (schema: string) => boolean;

  static setAppInfo: (arg1: Map<string, string> | string, arg2?: string) => void;
  static getAppInfoByKey: (key:string) => string;
  
  static enableAllSessions: () => void;
  static enableSingleSession: (sessionId: number) => void;
}
 
