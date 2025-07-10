// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterCommon.h"

@class MessageTransceiver;

@interface DebugRouterReport : NSObject
+ (void)report:(nonnull NSString *)tag withCategory:(nullable NSDictionary *)category;
+ (void)report:(nonnull NSString *)tag
    withCategory:(nullable NSDictionary *)category
      withMetric:(nullable NSDictionary *)metric;
@end
