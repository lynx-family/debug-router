// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <Foundation/Foundation.h>

#define DEFAULT_DEBUGROUTER_SERVICE @"debug_router_default_service"

static NSUInteger const kDebugRouterServiceReport = 1;

typedef NS_OPTIONS(NSUInteger, DebugRouterServiceScope) {
  DebugRouterServiceScopeDefault = 1 << 0,
  DebugRouterServiceScopeBiz = 1 << 1
};

@protocol DebugRouterServiceProtocol <NSObject>

@required
/// Service Scope type
+ (DebugRouterServiceScope)serviceScope;

/// The type of current service
+ (NSUInteger)serviceType;

/// The biz tag of current service.
+ (NSString *)serviceBizID;

@optional
+ (instancetype)sharedInstance;

@end
