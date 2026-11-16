// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import util from '@ohos.util';
import deviceInfo from '@ohos.deviceInfo';
import type { DebugRouterGlobalHandlerHarmony, DebugRouterSessionHandlerHarmony, DebugRouterMessageHandlerHarmony, DebugRouterStateListenerHarmony } from 'libdebugrouter.so';
import { DebugRouterHarmony } from 'libdebugrouter.so';
import { DebugRouterSlot } from './DebugRouterSlot';
import BuildProfile from '../../../BuildProfile';

export class DebugRouter {
  // Keep DebugRouter independent of the concrete UI framework while retaining
  // object identity for view-to-targetId mapping.
  private static viewMap: Map<Object, number> = new Map<Object, number>();
  private static initialized: boolean = false;

  static {
    DebugRouter.ensureInitialized();
  }

  public static ensureInitialized(): void {
    if (DebugRouter.initialized) {
      return;
    }
    const uuid: string = util.generateRandomUUID(true);
    const productModel: string = deviceInfo.productModel;
    let displayVersion: string = deviceInfo.displayVersion;
    const modelIndex: number = displayVersion.indexOf(productModel);
    if (modelIndex !== -1) {
      displayVersion = displayVersion.slice(modelIndex + productModel.length);
    }
    DebugRouterHarmony.createInstance();
    DebugRouter.setAppInfo(new Map<string, string>([
      ['osType', 'Harmony'],
      ['osVersion', displayVersion],
      ['deviceModel', productModel],
      ['debugRouterVersion', BuildProfile.HAR_VERSION],
      ['debugRouterId', uuid]
    ]));
    DebugRouter.initialized = true;
  }

  public static createInstance(): void {
    DebugRouter.ensureInitialized();
  }

  // Obsoleted legacy protocol: Session APIs operate on Targets.
  public static getSessionIdByView(view: Object): number {
    let targetId = DebugRouter.viewMap.get(view);
    return targetId === undefined ? 0 : targetId;
  }

  public static getViewBySessionId(targetId: number): Object | null {
    let result: Object | null = null;
    DebugRouter.viewMap.forEach((id, view) => {
      if (id === targetId) {
        result = view;
      }
    });
    return result;
  }

  public static setSessionIdOfView(view: Object, targetId: number): void {
    DebugRouter.viewMap.set(view, targetId);
  }

  public static removeView(view: Object): void {
    DebugRouter.viewMap.delete(view);
  }

  public static addGlobalHandler(handler: DebugRouterGlobalHandlerHarmony): void {
    DebugRouterHarmony.addGlobalHandler(handler);
  }

  public static removeGlobalHandler(handler: DebugRouterGlobalHandlerHarmony): boolean {
    return DebugRouterHarmony.removeGlobalHandler(handler);
  }

  // Obsoleted legacy protocol: Session APIs operate on Targets.
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

  public static sendDataAsync(type: string, targetId: number, data: string): void {
    DebugRouterHarmony.sendDataAsync(type, targetId, data);
  }

  public static plug(target: DebugRouterSlot): number {
    return DebugRouterHarmony.plug(target, target.getTemplateUrl(), target.getType());
  }

  public static pull(targetId: number): void {
    DebugRouterHarmony.pull(targetId);
    DebugRouter.viewMap.forEach((id, view) => {
      if (id === targetId) {
        DebugRouter.viewMap.delete(view);
      }
    });
  }

  public static isValidSchema(schema: string): boolean {
    return DebugRouterHarmony.isValidSchema(schema);
  }

  public static handleSchema(schema: string): boolean {
    return DebugRouterHarmony.handleSchema(schema);
  }

  public static setAppInfo(arg1: Map<string, string> | string, arg2?: string): void {
    if (arg1 instanceof Map) {
      const obj: Record<string, string> = {};
      arg1.forEach((value, key) => {
        obj[key] = value;
      });
      DebugRouterHarmony.setAppInfo(obj);
    } else {
      DebugRouterHarmony.setAppInfo(arg1, arg2);
    }
  }

  public static getAppInfoByKey(key: string): string {
    return DebugRouterHarmony.getAppInfoByKey(key);
  }

  // Obsoleted legacy protocol: Session APIs operate on Targets.
  public static enableAllSessions(): void {
    DebugRouterHarmony.enableAllSessions();
  }

  // targetId must be > 0. Invalid values are ignored by native layer.
  public static enableSingleSession(targetId: number): void {
    DebugRouterHarmony.enableSingleSession(targetId);
  }

  public static enableDebugChannel(): void {
    DebugRouterHarmony.enableDebugChannel();
  }

  public static disableDebugChannel(): void {
    DebugRouterHarmony.disableDebugChannel();
  }

  public static isDebugChannelEnabled(): boolean {
    return DebugRouterHarmony.isDebugChannelEnabled();
  }
}
