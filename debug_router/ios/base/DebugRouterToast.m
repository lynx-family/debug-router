// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterToast.h"

@implementation DebugRouterToast

+ (void)showToast:(nullable NSString *)message withTime:(int)during_time {
  if (message == nil) {
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:nil
                                            message:message
                                     preferredStyle:UIAlertControllerStyleAlert];
    UIViewController *controller = [UIApplication sharedApplication].keyWindow.rootViewController;
    UIViewController *presentedController = controller.presentedViewController;
    while (presentedController && ![presentedController isBeingDismissed]) {
      controller = presentedController;
      presentedController = controller.presentedViewController;
    }
    [controller presentViewController:alert animated:YES completion:nil];
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, during_time * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
          [alert.presentingViewController dismissViewControllerAnimated:YES completion:nil];
        });
  });
}

@end
