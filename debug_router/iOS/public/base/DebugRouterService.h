// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <Foundation/Foundation.h>
#import "DebugRouterDefines.h"
#import "DebugRouterServiceProtocol.h"

NS_ASSUME_NONNULL_BEGIN

/*
 * You can use @DebugRouterServiceRegister to specify a DebugRouterService will be
 * registered into DebugRouterServices instance automatically. This annotation
 * should only be used for DebugRouterServices subclasses, and before the
 * @implementation code fragment in the .m file. e.g.: DebugRouterXXService
 * is a subclass of DebugRouterServices, in DebugRouterXXService.m
 * // ...import headers...
 * @DebugRouterServiceRegister(DebugRouterXXService)
 * @implmentation DebugRouterXXService
 * //...
 * @end
 */

#ifndef DebugRouterServiceRegister
#define DebugRouterServiceRegister(clsName)                                                \
  interface DebugRouterServices(clsName) @end @implementation DebugRouterServices(clsName) \
  +(NSString *)DEBUGROUTER_CONCAT(                                                         \
      __debug_router_auto_register_serivce__,                                              \
      DEBUGROUTER_CONCAT(clsName, DEBUGROUTER_CONCAT(__LINE__, __COUNTER__))) {            \
    return @ #clsName;                                                                     \
  }                                                                                        \
  @end
#endif

/**
 * Bind protocol and class, e.g., DebugRouter_SERVICE_BIND (DebugRouterXXService,
 * DebugRouterXXProtocol)
 */
#define DebugRouterServiceBind(cls, pro) \
  ([DebugRouterServices bindClass:cls toProtocol:@protocol(pro)])

/**
 * Get the default object that implements the specified protocol, e.g.,
 * DebugRouter_SERVICE(DebugRouterXXProtocol) -> id<DebugRouterXXProtocol>
 */
#define DebugRouterService(pro)                                          \
  ((id<pro>)([DebugRouterServices getInstanceWithProtocol:@protocol(pro) \
                                                    bizID:DEFAULT_DEBUGROUTER_SERVICE]))

/**
 * Get the object that implements the specified protocol, e.g.,
 * DebugRouter_SERVICE(DebugRouterXXProtocol, default) -> id<DebugRouterXXProtocol>
 */
#define DebugRouterServiceBID(pro, bid) \
  ((id<pro>)([DebugRouterServices getInstanceWithProtocol:@protocol(pro) bizID:bid]))

@interface DebugRouterServices : NSObject

/**
 * Register default service
 * @param cls Protocol implementation class, which implements sharedInstance and is a singleton.
 */
+ (void)registerService:(Class)cls;

/**
 * Get implementation through protocol
 * @param protocol The protocol, which implements sharedInstance and returns a singleton
 * @param bizID Business ID
 * @return An instance of the protocol implementation class; returns null if the protocol has not
 * been bound
 */
+ (id)getInstanceWithProtocol:(Protocol *)protocol bizID:(NSString *__nullable)bizID;

@end

NS_ASSUME_NONNULL_END
