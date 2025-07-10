// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterUtil.h"
#import "DebugRouterLog.h"

@implementation DebugRouterUtil
+ (NSData *)dictToJson:(NSMutableDictionary<NSString *, id> *)dict {
  if (dict == nil) {
    return nil;
  }
  NSError *error;
  NSData *jsonData = [NSJSONSerialization dataWithJSONObject:dict options:kNilOptions error:&error];
  if (jsonData == nil) {
    LLogError(@"DebugRouterUtil: toJsonString error: %@", [error localizedFailureReason]);
  }
  return jsonData;
}

+ (void)dispatchMainAsyncSafe:(nonnull void (^)(void))callback {
  if ([NSThread isMainThread]) {
    callback();
  } else {
    dispatch_async(dispatch_get_main_queue(), callback);
  }
}
@end
