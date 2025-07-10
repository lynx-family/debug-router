// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <Foundation/Foundation.h>

#if defined(__cplusplus)
#define DEBUGROUTER_EXTERN extern "C" __attribute__((visibility("default")))
#else
#define DEBUGROUTER_EXTERN extern __attribute__((visibility("default")))
#endif

#define LLog(...) _DebugRouterLog(DebugRouterLogLevelInfo, __VA_ARGS__)
#define LLogInfo(...) _DebugRouterLog(DebugRouterLogLevelInfo, __VA_ARGS__)
#define LLogWarn(...) _DebugRouterLog(DebugRouterLogLevelWarning, __VA_ARGS__)
#define LLogError(...) _DebugRouterLog(DebugRouterLogLevelError, __VA_ARGS__)
#define LLogFatal(...) _DebugRouterLog(DebugRouterLogLevelFatal, __VA_ARGS__)
#define LLogReport(...) _DebugRouterLog(DebugRouterLogLevelReport, __VA_ARGS__)

#define LErrInfo(errCode, ...) _DebugRouterErrorInfo(errCode, __VA_ARGS__)
#define LErrWarn(expression, errCode, ...) \
  _DebugRouterErrorWarning(expression, errCode, __VA_ARGS__)
#define LErrFatal(expression, errCode, ...) _DebugRouterErrorFatal(expression, errCode, __VA_ARGS__)

typedef NS_ENUM(NSInteger, DebugRouterLogLevel) {
  DebugRouterLogLevelInfo = 0,
  DebugRouterLogLevelWarning = 1,
  DebugRouterLogLevelError = 2,
  DebugRouterLogLevelFatal = 3,
  DebugRouterLogLevelReport = 5
};

typedef NS_OPTIONS(NSInteger, DebugRouterLogSource) { DebugRouterLogSourceNaitve = 1 << 0 };

typedef void (^DebugRouterLogFunction)(DebugRouterLogLevel level, NSString *message);

@interface DebugRouterLogObserver : NSObject

@property(nonatomic, copy) DebugRouterLogFunction logFunction;
@property(nonatomic, assign) DebugRouterLogLevel minLogLevel;
@property(nonatomic, assign) BOOL shouldFormatMessage;           // The default value is YES
@property(nonatomic, assign) DebugRouterLogSource acceptSource;  // The default value is ALL
@property(nonatomic, assign)
    NSInteger acceptRuntimeId;  // -1 means receiving all runtime logs. The default value is -1

- (instancetype)initWithLogFunction:(DebugRouterLogFunction)logFunction
                        minLogLevel:(DebugRouterLogLevel)minLogLevel;

@end

extern DebugRouterLogFunction DebugRouterDefaultLogFunction;

DEBUGROUTER_EXTERN void DebugRouterSetLogFunction(DebugRouterLogFunction logFunction)
    __attribute__((deprecated("Use DebugRouterAddLogObserver instead.")));
DEBUGROUTER_EXTERN DebugRouterLogFunction DebugRouterGetLogFunction(void);

DEBUGROUTER_EXTERN NSInteger DebugRouterAddLogObserver(DebugRouterLogFunction logFunction,
                                                       DebugRouterLogLevel minLogLevel);
DEBUGROUTER_EXTERN NSInteger DebugRouterAddLogObserverByModel(DebugRouterLogObserver *observer);
DEBUGROUTER_EXTERN DebugRouterLogObserver *DebugRouterGetLogObserver(NSInteger observerId);
DEBUGROUTER_EXTERN void DebugRouterRemoveLogObserver(NSInteger observerId);
DEBUGROUTER_EXTERN NSArray<DebugRouterLogObserver *> *DebugRouterGetLogObservers(void);

DEBUGROUTER_EXTERN void DebugRouterAddDebugLogObserver(void);

DEBUGROUTER_EXTERN void DebugRouterSetMinLogLevel(DebugRouterLogLevel minLogLevel)
    __attribute__((deprecated("Use DebugRouterAddLogObserver instead.")));
DEBUGROUTER_EXTERN DebugRouterLogLevel DebugRouterGetMinLogLevel(void);

#define _DebugRouterLog(log_level, ...) _DebugRouterLogInternal(log_level, __VA_ARGS__)
DEBUGROUTER_EXTERN void _DebugRouterLogInternal(DebugRouterLogLevel, NSString *, ...)
    NS_FORMAT_FUNCTION(2, 3);

#define _DebugRouterErrorInfo(errCode, ...) _DebugRouterErrorInfoInternal(errCode, __VA_ARGS__)
DEBUGROUTER_EXTERN void _DebugRouterErrorInfoInternal(NSInteger, NSString *, ...);

#define _DebugRouterErrorWarning(expression, errCode, ...) \
  _DebugRouterErrorWarningInternal(expression, errCode, __VA_ARGS__)
DEBUGROUTER_EXTERN void _DebugRouterErrorWarningInternal(bool, NSInteger, NSString *, ...);

#define _DebugRouterErrorFatal(expression, errCode, ...) \
  _DebugRouterErrorFatalInternal(expression, errCode, __VA_ARGS__)
DEBUGROUTER_EXTERN void _DebugRouterErrorFatalInternal(bool, NSInteger, NSString *, ...);

#pragma mark - Debug Log
#define DEBUGROUTER_DEBUG_LOG(TAG, FORMAT, ...)                                 \
  do {                                                                          \
    fprintf(stderr, #TAG ", %s, %s\n", [NSStringFromSelector(_cmd) UTF8String], \
            [[[NSString stringWithFormat:FORMAT, ##__VA_ARGS__]                 \
                stringByReplacingOccurrencesOfString:@"\n"                      \
                                          withString:@""] UTF8String]);         \
  } while (0);
