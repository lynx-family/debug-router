// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterEventSender.h"
#import "DebugRouter.h"
#import "DebugRouterLog.h"
#import "DebugRouterUtil.h"

@implementation DebugRouterEventSender
+ (void)send:(NSString *)method with:(DebugRouterMessageHandleResult *)result {
  NSString *jsonString = @"{}";
  if (method != nil) {
    NSMutableDictionary<NSString *, id> *dict = [[NSMutableDictionary alloc] init];
    [dict setObject:method forKey:@"method"];
    [dict setObject:[result toStringDict] forKey:@"params"];
    NSData *jsonData = [DebugRouterUtil dictToJson:dict];

    if (jsonData != nil) {
      jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    }
  }
  LLogInfo(@"MessageHandler: DebugRouterEventSender send:%@", jsonString);
  DebugRouter *router = [DebugRouter instance];
  [router sendDataAsync:jsonString WithType:@"CDP" ForSession:-1];
}
@end
