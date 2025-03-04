// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <Foundation/Foundation.h>
#import "DebugRouterServiceProtocol.h"

@interface DebugRouterMetaInfo : NSObject
@property(nonnull) NSString *debugrouterVersion;
@property(nonnull) NSString *appProcessName;
@end

@protocol DebugRouterReportServiceProtocol <DebugRouterServiceProtocol>

- (void)initService:(nonnull DebugRouterMetaInfo *)metaInfo;
- (void)report:(nonnull NSString *)eventName
    withCategory:(nullable NSDictionary *)category
      withMetric:(nullable NSDictionary *)metric
       withExtra:(nullable NSDictionary *)extra;
@end
