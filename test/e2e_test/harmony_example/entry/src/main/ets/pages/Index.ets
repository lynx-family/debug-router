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

class testTargetHandler implements DebugRouterSessionHandlerHarmony {
  public onSessionCreate(targetId: number, url: string): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testTargetHandler: onSessionCreate. targetId: ' + targetId + ' url: ' + url);
  }

  public onSessionDestroy(targetId: number): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testTargetHandler: onSessionDestroy. targetId: ' + targetId);
  }

  public onMessage(message: string, type: string, targetId: number): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testTargetHandler: onMessage. message: ' + message + ' type: ' + type + ' targetId: ' + targetId);
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

class testTargetDelegate implements DebugRouterSlotDelegate {
  public getTemplateUrl(): string {
    return 'test templateUrl'
  }

  public onMessage(message: string, type: string): void {
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testTargetDelegate: onMessage.');
  }
}

@Entry
@Component
struct Index {
  aboutToAppear() {
    DebugRouter.ensureInitialized();
    DebugRouter.enableAllSessions();
    DebugRouter.setAppInfo('bundle', 'org.lynxjs.debugrouter.testapp')
    DebugRouter.setAppInfo('App', 'DebugRouter')
    DebugRouter.setAppInfo('debugRouterVersion', '0.0.1')
    DebugRouter.setAppInfo(new Map([['testkey', 'testvalue']]));
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: testkey: ' + DebugRouter.getAppInfoByKey('testkey'));

    // test DebugRouterStateListener
    DebugRouter.addStateListener(new testStateListener());

    // test DebugRouterGlobalHandler
    DebugRouter.addGlobalHandler(new testGlobalHandler());

    // test DebugRouterSessionHandler
    DebugRouter.addSessionHandler(new testTargetHandler());

    // test DebugRouterMessageHandler
    DebugRouter.addMessageHandler(new testMessageHandler());

    // Test target registration and callbacks.
    const delegate = new testTargetDelegate();
    let target: DebugRouterSlot = new DebugRouterSlot();
    target.setDelegate(delegate);
    let targetId: number = DebugRouter.plug(target);
    hilog.info(DOMAIN, 'Index', '%{public}s', 'Index: add a new target get targetId: ' + targetId);
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
