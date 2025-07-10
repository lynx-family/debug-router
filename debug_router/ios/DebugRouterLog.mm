// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterLog.h"
#include "debug_router/native/log/logging.h"

#define LOCKED(...)            \
  @synchronized(ObserverDic) { \
    __VA_ARGS__;               \
  }

@implementation DebugRouterLogObserver

- (instancetype)initWithLogFunction:(DebugRouterLogFunction)logFunction
                        minLogLevel:(DebugRouterLogLevel)minLogLevel {
  if (self = [super init]) {
    self.logFunction = logFunction;
    self.minLogLevel = minLogLevel;
    self.acceptSource = NSIntegerMax;
    self.acceptRuntimeId = -1;
    self.shouldFormatMessage = true;
  }
  return self;
}

@end

static NSInteger DefaultObserverId = -1;
static NSInteger CurrentId = 0;
static NSMutableDictionary *ObserverDic = [[NSMutableDictionary alloc] init];
const char *DebugRouterLogLevels[] = {
    "I", "W", "E", "F",
    "I",  // log
    "R"   // report
};

namespace debugrouter {
namespace logging {
class FunctionLogginDelegate : public LoggingDelegate {
 public:
  ~FunctionLogginDelegate() override {}
  void Log(LogMessage *msg) override {
    NSArray<DebugRouterLogObserver *> *observers = DebugRouterGetLogObservers();
    for (DebugRouterLogObserver *observer in observers) {
      DebugRouterLogFunction logFunction = observer.logFunction;
      DebugRouterLogLevel level = (DebugRouterLogLevel)msg->severity();
      BOOL log = logFunction != nil;
      if (!log || level < observer.minLogLevel ||
          (observer.acceptRuntimeId >= 0 && observer.acceptRuntimeId != msg->runtimeId())) {
        continue;
      }
      NSString *message = observer.shouldFormatMessage
                              ? [NSString stringWithUTF8String:msg->stream().str().c_str()]
                              : [[NSString stringWithUTF8String:msg->stream().str().c_str()]
                                    substringFromIndex:msg->messageStart()];
      if (message == nil) {
        return;
      }
      switch (msg->source()) {
        case LOG_SOURCE_NATIVE:
          if (observer.acceptSource & DebugRouterLogSourceNaitve) {
            logFunction(level, message);
          }
          break;
        default:
          break;
      }
    }
  }
};
}  // namespace logging
}  // namespace debugrouter

NSInteger DebugRouterAddLogObserver(DebugRouterLogFunction logFunction,
                                    DebugRouterLogLevel minLogLevel) {
  DebugRouterLogObserver *observer =
      [[DebugRouterLogObserver alloc] initWithLogFunction:logFunction minLogLevel:minLogLevel];
  return DebugRouterAddLogObserverByModel(observer);
}

NSInteger DebugRouterAddLogObserverByModel(DebugRouterLogObserver *observer) {
  NSInteger observerId = ++CurrentId;
  LOCKED([ObserverDic setObject:observer forKey:@(observerId)]);
  debugrouter::logging::SetLoggingDelegate(
      std::make_unique<debugrouter::logging::FunctionLogginDelegate>());
  return observerId;
}

DebugRouterLogObserver *DebugRouterGetLogObserver(NSInteger observerId) {
  LOCKED(return [ObserverDic objectForKey:@(observerId)]);
}
void DebugRouterRemoveLogObserver(NSInteger observerId) {
  LOCKED([ObserverDic removeObjectForKey:@(observerId)]);
}
NSArray<DebugRouterLogObserver *> *DebugRouterGetLogObservers() {
  LOCKED(return [ObserverDic allValues]);
}

void DebugRouterSetLogFunction(DebugRouterLogFunction logFunction) {
  DefaultObserverId = DebugRouterAddLogObserver(logFunction, DebugRouterLogLevelInfo);
}

DebugRouterLogFunction DebugRouterGetLogFunction(void) {
  DebugRouterLogObserver *observer = DebugRouterGetLogObserver(DefaultObserverId);
  if (!observer) {
    return DebugRouterDefaultLogFunction;
  }
  return observer.logFunction;
}

void DebugRouterAddDebugLogObserver() {
  DebugRouterLogFunction defaultLogFunction = ^(DebugRouterLogLevel level, NSString *message) {
    NSLog(@"%s/debugrouter: %@", DebugRouterLogLevels[level], message);
  };
  DebugRouterLogObserver *observer =
      [[DebugRouterLogObserver alloc] initWithLogFunction:defaultLogFunction
                                              minLogLevel:DebugRouterLogLevelInfo];
  DebugRouterAddLogObserverByModel(observer);
}

void DebugRouterSetMinLogLevel(DebugRouterLogLevel minLogLevel) {
  DebugRouterLogObserver *observer = DebugRouterGetLogObserver(DefaultObserverId);
  if (observer) {
    observer.minLogLevel = minLogLevel;
  }
  debugrouter::logging::SetMinLogLevel(static_cast<int>(minLogLevel));
}

DebugRouterLogLevel DebugRouterGetMinLogLevel(void) {
  DebugRouterLogObserver *observer = DebugRouterGetLogObserver(DefaultObserverId);
  if (observer) {
    return observer.minLogLevel;
  }
  return DebugRouterLogLevelInfo;
}

DebugRouterLogFunction DebugRouterDefaultLogFunction =
    ^(DebugRouterLogLevel level, NSString *message) {
      NSLog(@"%s/DebugRouter: %@", DebugRouterLogLevels[level], message);
    };

void _DebugRouterLogInternal(DebugRouterLogLevel level, NSString *format, ...) {
  NSArray<DebugRouterLogObserver *> *observers = DebugRouterGetLogObservers();
  for (DebugRouterLogObserver *observer in observers) {
    if (observer.acceptSource & DebugRouterLogSourceNaitve) {
      DebugRouterLogFunction logFunction = observer.logFunction;
      BOOL log = logFunction != nil;
      if (log && level >= observer.minLogLevel) {
        va_list args;
        va_start(args, format);
        NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
        va_end(args);
        if (logFunction) {
          logFunction(level, message);
        }
      }
    }
  }
}
