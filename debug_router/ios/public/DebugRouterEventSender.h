// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterMessageHandleResult.h"

NS_ASSUME_NONNULL_BEGIN

@interface DebugRouterEventSender : NSObject
+ (void)send:(NSString *)method with:(DebugRouterMessageHandleResult *)result;
@end

NS_ASSUME_NONNULL_END
