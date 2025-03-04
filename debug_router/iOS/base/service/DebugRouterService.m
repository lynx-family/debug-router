// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterService.h"
#import "DebugRouterLog.h"
#import "DebugRouterReportServiceProtocol.h"

#import <objc/runtime.h>

static NSArray<NSString *> *debugrouter_services = nil;
static NSString *const DEBUG_ROUTER_AUTO_REGISTER_SERVICE_PREFIX =
    @"__debug_router_auto_register_serivce__";

@interface DebugRouterServices ()

@property(atomic, strong) NSMutableDictionary<NSString *, Class> *protocolToClassMap;
@property(atomic, strong) NSMutableDictionary<NSString *, id> *protocolToInstanceMap;
@property(atomic, strong) NSRecursiveLock *recLock;
@property(atomic, strong) NSMutableSet<NSString *> *protocolClassCalledSet;

@end

@implementation DebugRouterServices

+ (void)load {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSMutableArray<NSString *> *autoRegisteredService = [NSMutableArray new];
    unsigned int methodCount = 0;
    Method *methods = class_copyMethodList(object_getClass([self class]), &methodCount);
    for (unsigned int i = 0; i < methodCount; i++) {
      Method method = methods[i];
      SEL selector = method_getName(method);
      if ([NSStringFromSelector(selector) hasPrefix:DEBUG_ROUTER_AUTO_REGISTER_SERVICE_PREFIX]) {
        IMP imp = method_getImplementation(method);
        NSString *className = ((NSString * (*)(id, SEL)) imp)(self, selector);
        if ([className isKindOfClass:[NSString class]] && className.length > 0) {
          [autoRegisteredService addObject:className];
          Class cls = NSClassFromString(className);
          // check is subclass of DebugRouterService?
          NSAssert([cls conformsToProtocol:@protocol(DebugRouterServiceProtocol)],
                   @"service class should conforms to DebugRouterServiceProtocol");
          [DebugRouterServices registerService:cls];
        }
      }
    }
    free(methods);
    debugrouter_services = [autoRegisteredService copy];
  });
}

+ (instancetype)sharedInstance {
  static dispatch_once_t onceToken;
  static DebugRouterServices *services;
  dispatch_once(&onceToken, ^{
    services = [[DebugRouterServices alloc] init];
  });
  return services;
}

+ (void)registerService:(Class)cls {
  if (cls == nil || ![cls conformsToProtocol:@protocol(DebugRouterServiceProtocol)]) {
    NSAssert(NO, @"%@ should conforms to %@, %s", NSStringFromClass(cls),
             NSStringFromProtocol(@protocol(DebugRouterServiceProtocol)), __func__);
    return;
  }
  Protocol *protocol = [self getProtocolByServiceType:[cls serviceType]];
  if (protocol != nil) {
    [[self sharedInstance] bindClass:cls toProtocol:protocol];
  } else {
    LLogWarn(@"Unknow debugrouter service type - %lu", [cls serviceType]);
  }
}

+ (Protocol *)getProtocolByServiceType:(NSUInteger)serviceType {
  switch (serviceType) {
    case kDebugRouterServiceReport:
      return @protocol(DebugRouterReportServiceProtocol);
    default:
      return nil;
  }
  return nil;
}

#pragma mark - Lifecycle
- (instancetype)init {
  if (self = [super init]) {
    _protocolToClassMap = [[NSMutableDictionary alloc] init];
    _protocolToInstanceMap = [[NSMutableDictionary alloc] init];
    _recLock = [[NSRecursiveLock alloc] init];
    _protocolClassCalledSet = [[NSMutableSet alloc] init];
  }
  return self;
}

#pragma mark - Public

+ (void)bindClass:(Class)cls toProtocol:(Protocol *)protocol {
  [[self sharedInstance] bindClass:cls toProtocol:protocol];
}

+ (id)getInstanceWithProtocol:(Protocol *)protocol bizID:bid {
  if (!protocol || protocol == nil) {
    return nil;
  }
  return [[self sharedInstance] getInstanceWithProtocol:protocol bizID:bid];
}

- (void)bindClass:(Class)cls toProtocol:(Protocol *)protocol {
  if (cls == nil || protocol == nil || ![cls conformsToProtocol:protocol]) {
    NSAssert(NO, @"%@ should conforms to %@, %s", NSStringFromClass(cls),
             NSStringFromProtocol(protocol), __func__);
    return;
  }
  if (![cls conformsToProtocol:@protocol(DebugRouterServiceProtocol)]) {
    NSAssert(NO, @"%@ should conforms to DebugRouterServiceProtocol, %s", NSStringFromClass(cls),
             __func__);
    return;
  }
  [self.recLock lock];
  // Get biz name from clz instance
  // key: protocolName__debugrouter_binder__${bizID}
  NSString *protocolName =
      [NSString stringWithFormat:@"%@__debugrouter_binder__%@", NSStringFromProtocol(protocol),
                                 [cls serviceBizID] ?: DEFAULT_DEBUGROUTER_SERVICE];
  if ([self.protocolToClassMap objectForKey:protocolName] == nil) {
    [self.protocolToClassMap setObject:cls forKey:protocolName];
  } else {
    NSAssert(NO, @"%@ and %@ are duplicated bindings, %s", NSStringFromClass(cls),
             NSStringFromProtocol(protocol), __func__);
  }
  [self.recLock unlock];
}

- (id)getInstanceWithProtocol:(Protocol *)protocol bizID:(NSString *)bizID {
  if (debugrouter_services == nil || debugrouter_services.count == 0) {
    return nil;
  }
  [self.recLock lock];
  // key: protocolName__debugrouter_binder__${bizID}
  NSString *finalBizID = bizID ?: DEFAULT_DEBUGROUTER_SERVICE;
  NSString *protocolName = [NSString
      stringWithFormat:@"%@__debugrouter_binder__%@", NSStringFromProtocol(protocol), finalBizID];
  id object = [self.protocolToInstanceMap objectForKey:protocolName];
  if (object == nil) {
    Class cls = [self.protocolToClassMap objectForKey:protocolName];
    if (cls != nil) {
      object =
          [self.protocolToInstanceMap objectForKey:protocolName] ?: [self getInstanceWithClass:cls];
      NSAssert(object, @"%@ no object", protocolName);
      if (object) {
        [self.protocolToInstanceMap setObject:object forKey:protocolName];
      }
    } else {
      // NSAssert(NO, @"%@ is not binded, %s", NSStringFromProtocol(protocol), __func__);
    }
  }
  [self.recLock unlock];
  return object;
}

- (id)getInstanceWithClass:(Class)cls {
  // UI types need to check the main thread
  id object = nil;
  if ([cls respondsToSelector:@selector(sharedInstance)]) {
    object = [cls sharedInstance];
  } else {
    object = [[cls alloc] init];
  }
  return object;
}

@end
