// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterReport.h"
#import "DebugRouterLog.h"

#import <DebugRouterReportServiceUtil.h>
#import <Foundation/Foundation.h>

@implementation DebugRouterReport

+ (void)report:(nonnull NSString *)tag
    withCategory:(nullable NSDictionary *)category
      withMetric:(nullable NSDictionary *)metric {
  id reportServiceInstance = [DebugRouterReportServiceUtil getReportServiceInstance];
  if (reportServiceInstance) {
    tag = [NSString stringWithFormat:@"New%@", tag];
    [reportServiceInstance report:tag withCategory:category withMetric:metric withExtra:nil];
  } else {
    LLogInfo(@"Fail to report because report service cannot be found.");
  }
}

+ (void)report:(nonnull NSString *)tag withCategory:(nullable NSDictionary *)category {
  [self report:tag withCategory:category withMetric:nil];
}

+ (void)report:(nonnull NSString *)tag {
  [self report:tag withCategory:nil withMetric:nil];
}

@end
