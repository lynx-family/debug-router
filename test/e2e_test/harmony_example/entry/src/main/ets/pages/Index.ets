// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {
  DebugRouterStateListenerHarmony,
  DebugRouterSessionHandlerHarmony,
  DebugRouterMessageHandlerHarmony,
  DebugRouterGlobalHandlerHarmony,
  DebugRouterSlotDelegate,
} from '@lynx/debug_router';

import { DebugRouter, DebugRouterSlot } from '@lynx/debug_router';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0xff00;

class testStateListener implements DebugRouterStateListenerHarmony {
  public onOpen(connectionType: string): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testStateListener: onOpen');
  }

  public onClose(code: number, reason: string): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testStateListener: onClose');
  }
  public onMessage(message: string): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testStateListener: onMessage');
  }
  public onError(error: string): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testStateListener: onError');
  }
}

class testGlobalHandler implements DebugRouterGlobalHandlerHarmony {
  public onOpenCard(url: string): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testGlobalHandler: onOpenCard: ' + url);
  }

  public onMessage(message: string, type: string): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testGlobalHandler: onMessage. message: ' + message + ' type: ' + type);
  }
}

class testSessionHandler implements DebugRouterSessionHandlerHarmony {
  public onSessionCreate(session_id: number, url: string): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testSessionHandler: onSessionCreate. session_id: ' + session_id + ' url: ' + url);
  }

  public onSessionDestroy(session_id: number): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testSessionHandler: onSessionDestroy. session_id: ' + session_id);
  }

  public onMessage(message: string, type: string, session_id: number): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testSessionHandler: onMessage. message: ' + message + ' type: ' + type + ' session_id: ' + session_id);
  }
}

class testMessageHandler implements DebugRouterMessageHandlerHarmony {
  public handle(params: string): string {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testMessageHandler: handle. params: ' + params);
    return 'testHandleResult';
  }

  public getName(): string {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testMessageHandler: getName.');
    return 'testName';
  }
}

class testSlotDelegate implements DebugRouterSlotDelegate {
  public getTemplateUrl(): string {
    return 'test templateUrl'
  }

  public onMessage(message: string, type: string): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testSlotDelegate: onMessage.');
  }
}

@Entry
@Component
struct Index {
  aboutToAppear() {
    DebugRouter.createInstance();
    DebugRouter.setAppInfo('osType', 'Harmony')
    DebugRouter.setAppInfo('bundle', 'org.lynxjs.debugrouter.testapp')
    DebugRouter.setAppInfo('App', 'DebugRouter')
    DebugRouter.setAppInfo('debugRouterVersion', '0.0.1')

    // test DebugRouterStateListener
    DebugRouter.addStateListener(new testStateListener());

    // test DebugRouterGlobalHandler
    DebugRouter.addGlobalHandler(new testGlobalHandler());

    // test DebugRouterSessionHandler
    DebugRouter.addSessionHandler(new testSessionHandler());

    // test DebugRouterMessageHandler
    DebugRouter.addMessageHandler(new testMessageHandler());

    // tset add slot and sessionhandler
    const delegate = new testSlotDelegate();
    let slot: DebugRouterSlot = new DebugRouterSlot();
    slot.setDelegate(delegate);
    let sessionId: number = DebugRouter.plug(slot);
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: add a new slot get sessionId: ' + sessionId);
  }
  build() {
    Column() {
      Text('Hello world!')
        .fontSize(30)
    }
    .height('100%')
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }
}