// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import type { DebugRouterGlobalHandlerHarmony, DebugRouterSessionHandlerHarmony, DebugRouterMessageHandlerHarmony, DebugRouterStateListenerHarmony } from 'libdebugrouter.so';
import { DebugRouterHarmony } from 'libdebugrouter.so';
import { DebugRouterSlot } from './DebugRouterSlot';
import { LynxView } from '@lynx/lynx/src/main/ets/tasm/LynxView';

export class DebugRouter {
  private static viewMap: Map<LynxView, number> = new Map<LynxView, number>();

  public static createInstance(): void {
    DebugRouterHarmony.createInstance();
  }

  public static getSessionIdByView(view: LynxView): number {
    let sessionId = DebugRouter.viewMap.get(view);
    return sessionId === undefined ? 0 : sessionId;
  }

  public static getViewBySessionId(sessionId: number): LynxView | null {
    let result: LynxView | null = null;
    DebugRouter.viewMap.forEach((id, view) => {
      if (id == sessionId) {
        result = view;
      }
    });
    return result;
  }

  public static setSessionIdOfView(view: LynxView, sessionId: number): void {
    DebugRouter.viewMap.set(view, sessionId);
  }

  public static removeView(view: LynxView): void {
    DebugRouter.viewMap.delete(view);
  }

  public static addGlobalHandler(handler: DebugRouterGlobalHandlerHarmony): void {
    DebugRouterHarmony.addGlobalHandler(handler);
  }

  public static removeGlobalHandler(handler: DebugRouterGlobalHandlerHarmony): boolean {
    return DebugRouterHarmony.removeGlobalHandler(handler);
  }

  public static addSessionHandler(handler: DebugRouterSessionHandlerHarmony): void {
    DebugRouterHarmony.addSessionHandler(handler);
  }

  public static removeSessionHandler(handler: DebugRouterSessionHandlerHarmony): boolean {
    return DebugRouterHarmony.removeSessionHandler(handler);
  }

  public static addMessageHandler(handler: DebugRouterMessageHandlerHarmony): void {
    DebugRouterHarmony.addMessageHandler(handler);
  }

  public static removeMessageHandler(handler: DebugRouterMessageHandlerHarmony): boolean {
    return DebugRouterHarmony.removeMessageHandler(handler);
  }

  public static addStateListener(listener: DebugRouterStateListenerHarmony): void {
    DebugRouterHarmony.addStateListener(listener);
  }

  public static connectAsync(url: string, room: string): void {
    DebugRouterHarmony.connectAsync(url, room);
  }

  public static disconnectAsync(): void {
    DebugRouterHarmony.disconnectAsync();
  }

  public static isConnected(): boolean {
    return DebugRouterHarmony.isConnected();
  }

  public static sendAsync(message: string): void {
    DebugRouterHarmony.sendAsync(message);
  }

  public static sendDataAsync(type: string, session: number, data: string): void {
    DebugRouterHarmony.sendDataAsync(type, session, data);
  }

  public static plug(slot: DebugRouterSlot): number {
    return DebugRouterHarmony.plug(slot, slot.getTemplateUrl(), slot.getType());
  }

  public static pull(sessionId: number): void {
    DebugRouterHarmony.pull(sessionId);
  }

  public static isValidSchema(schema: string): boolean {
    return DebugRouterHarmony.isValidSchema(schema);
  }

  public static handleSchema(schema: string): boolean {
    return DebugRouterHarmony.handleSchema(schema);
  }

  public static setAppInfo(arg1: Map<string, string> | string, arg2?: string): void {
    DebugRouterHarmony.setAppInfo(arg1, arg2);
  }

  public static getAppInfoBykey(key: string): string {
    return DebugRouterHarmony.getAppInfoByKey(key);
  }

  public static enableAllSessions(): void {
    DebugRouterHarmony.enableAllSessions();
  }

  public static enableSingleSession(sessionId: number): void {
    DebugRouterHarmony.enableSingleSession(sessionId);
  }
}