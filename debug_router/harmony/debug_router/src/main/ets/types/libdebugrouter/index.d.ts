// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export interface DebugRouterGlobalHandlerHarmony {
  onOpenCard: (url: string) => void;
  onMessage: (message: string, type: string) => void;
}

// Obsoleted legacy protocol: Session APIs operate on Targets.
export interface DebugRouterSessionHandlerHarmony {
  onSessionCreate: (target_id: number, url: string) => void;
  onSessionDestroy: (target_id: number) => void;
  onMessage: (message: string, type: string, target_id: number) => void;
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

// Obsoleted legacy protocol: public Target interface name.
export interface NativeSlotHarmony {
  onMessage: (message: string, type: string) => void;
}

export declare class DebugRouterHarmony {
  static createInstance: () => void;
  static addGlobalHandler: (handler: DebugRouterGlobalHandlerHarmony) => void;
  static removeGlobalHandler: (handler: DebugRouterGlobalHandlerHarmony) => boolean;
  // Obsoleted legacy protocol: Session APIs operate on Targets.
  static addSessionHandler: (handler: DebugRouterSessionHandlerHarmony) => void;
  static removeSessionHandler: (handler: DebugRouterSessionHandlerHarmony) => boolean;
  static addMessageHandler: (handler: DebugRouterMessageHandlerHarmony) => void;
  static removeMessageHandler: (handler: DebugRouterMessageHandlerHarmony) => boolean;
  static addStateListener: (listener: DebugRouterStateListenerHarmony) => void;

  static connectAsync: (url: string, room: string) => void;
  static disconnectAsync: () => void;
  static isConnected: () => boolean;

  static sendAsync: (message: string) => void;
  static sendDataAsync: (type: string, targetId: number, data: string) => void;

  static plug: (target: NativeSlotHarmony, url:string, type:string) => number;
  static pull: (targetId: number) => void;

  static isValidSchema: (schema: string) => boolean;
  static handleSchema: (schema: string) => boolean;

  static setAppInfo: (arg1: Record<string, string> | string, arg2?: string) => void;
  static getAppInfoByKey: (key:string) => string;
  
  // Obsoleted legacy protocol: Session APIs operate on Targets.
  static enableAllSessions: () => void;
  /** targetId must be > 0. Invalid values are ignored by native layer. */
  static enableSingleSession: (targetId: number) => void;
  static enableDebugChannel: () => void;
  static disableDebugChannel: () => void;
  static isDebugChannelEnabled: () => boolean;
}
 
