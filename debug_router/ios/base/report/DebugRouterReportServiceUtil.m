// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <Foundation/Foundation.h>

#import "DebugRouterLog.h"
#import "DebugRouterReportServiceUtil.h"
#import "DebugRouterService.h"

@implementation DebugRouterMetaInfo
- (instancetype)init {
  self = [super init];
  if (self) {
    _debugrouterVersion = @"";
    _appProcessName = @"";
  }
  return self;
}
@end

@implementation DebugRouterReportServiceUtil
+ (id<DebugRouterReportServiceProtocol>)getReportServiceInstance {
  static id<DebugRouterReportServiceProtocol> instance = nil;
  static dispatch_once_t token;
  dispatch_once(&token, ^{
    id<DebugRouterReportServiceProtocol> reportService =
        DebugRouterService(DebugRouterReportServiceProtocol);
    Class serviceClass = (Class)[reportService class];
    if (serviceClass) {
      instance = [[serviceClass alloc] init];
    } else {
      LLogError(@"Class DebugRouterReportServiceImpl not found.");
    }
  });
  return instance;
}
@end
