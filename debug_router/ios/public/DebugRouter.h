// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <TargetConditionals.h>
#import <UIKit/UIKit.h>

#import "DebugRouterCommon.h"
#import "DebugRouterMessageHandler.h"
#import "DebugRouterSessionHandler.h"

typedef enum : NSUInteger { ConnectionTypeWebSocket, ConnectionTypeUSB, Unknown } ConnectionType;

@protocol DebugRouterStateListener <NSObject>

@required
- (void)onOpen:(ConnectionType)type;
- (void)onClose:(NSInteger)code withReason:(nonnull NSString *)reason;
- (void)onError:(nonnull NSString *)error;

@end

@class DebugRouterSlot;
@protocol DebugRouterGlobalHandler;
@protocol DebugRouterSessionHandler;

@interface DebugRouter : NSObject

@property(readonly, nonnull) NSString *room_id;
@property(readonly, nonnull) NSString *server_url;
@property(readonly) int usb_port;
@property(readonly) ConnectionState connection_state;

@property(nonatomic, readwrite, nonnull, strong) NSMutableDictionary *app_info
    __attribute__((deprecated("will remove")));
// Obsoleted legacy protocol: public Target collection name.
@property(nonatomic, readwrite, nonnull, strong) NSMutableDictionary *slots
    __attribute__((deprecated("will remove")));
@property(nonatomic, readwrite, nonnull, strong) NSMutableArray *global_handlers
    __attribute__((deprecated("will remove")));

+ (nonnull DebugRouter *)instance;
#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
+ (BOOL)setUSBStartPort:(int)startPort;
#endif

- (void)disconnect;
- (void)connect:(nonnull NSString *)url ToRoom:(nonnull NSString *)room;

- (void)send:(nonnull NSString *)message;
// Obsoleted legacy protocol: Session APIs operate on Targets.
- (void)sendData:(nonnull NSString *)data
        WithType:(nonnull NSString *)type
      ForSession:(int)target_id;
- (void)sendData:(nonnull NSString *)data
        WithType:(nonnull NSString *)type
      ForSession:(int)target_id
        WithMark:(int)mark
    __attribute__((deprecated("mark is not used, use sendData:WithType:ForSession instead")));
;
- (void)sendObject:(nonnull NSDictionary *)data
          WithType:(nonnull NSString *)type
        ForSession:(int)target_id;
- (void)sendObject:(nonnull NSDictionary *)data
          WithType:(nonnull NSString *)type
        ForSession:(int)target_id
          WithMark:(int)mark
    __attribute__((deprecated("mark is not used, use sendObject:WithType:ForSession instead")));
- (void)sendAsync:(nonnull NSString *)message;
- (void)sendDataAsync:(nonnull NSString *)data
             WithType:(nonnull NSString *)type
           ForSession:(int)target_id;
- (void)sendDataAsync:(nonnull NSString *)data
             WithType:(nonnull NSString *)type
           ForSession:(int)target_id
             WithMark:(int)mark
    __attribute__((deprecated("mark is not used, use sendDataAsync:WithType:ForSession instead")));
- (void)sendObjectAsync:(nonnull NSDictionary *)data
               WithType:(nonnull NSString *)type
             ForSession:(int)target_id;
- (void)sendObjectAsync:(nonnull NSDictionary *)data
               WithType:(nonnull NSString *)type
             ForSession:(int)target_id
               WithMark:(int)mark __attribute__((deprecated(
                            "mark is not used, use sendObjectAsync:WithType:ForSession instead")));

- (int)plug:(nonnull DebugRouterSlot *)target;
- (void)pull:(int)targetId;
- (void)setAppInfo:(nonnull NSString *)key withValue:(nonnull NSString *)value;

- (void)addGlobalHandler:(nonnull id<DebugRouterGlobalHandler>)handler;
- (BOOL)removeGlobalHandler:(nonnull id<DebugRouterGlobalHandler>)handler;
- (void)addMessageHandler:(nonnull id<DebugRouterMessageHandler>)handler;
- (BOOL)removeMessageHandler:(nonnull id<DebugRouterMessageHandler>)handler;
// Obsoleted legacy protocol: Session APIs operate on Targets.
- (void)addSessionHandler:(nonnull id<DebugRouterSessionHandler>)handler;
- (BOOL)removeSessionHandler:(nonnull id<DebugRouterSessionHandler>)handler;

- (BOOL)isValidSchema:(nonnull NSString *)schema;
- (BOOL)handleSchema:(nonnull NSString *)schema;
- (void)addStateListener:(nonnull id<DebugRouterStateListener>)listener;

- (void)setConfig:(BOOL)value forKey:(nonnull NSString *)key;
- (BOOL)getConfig:(nonnull NSString *)configKey withDefaultValue:(BOOL)defaultValue;

// Obsoleted legacy protocol: Session APIs operate on Targets.
- (int)getSessionIdByView:(nonnull UIView *)view;
- (nullable UIView *)getViewBySessionId:(int)targetId;

- (void)setSessionId:(int)targetId ofView:(nonnull UIView *)view;

- (nonnull NSString *)getAppInfoByKey:(nonnull NSString *)key;

// Obsoleted legacy protocol: Session APIs operate on Targets.
- (void)enableAllSessions;
// targetId must be > 0. Invalid values are ignored.
- (void)enableSingleSession:(int)targetId;
- (void)enableDebugChannel;
- (void)disableDebugChannel;
- (BOOL)isDebugChannelEnabled;

@end
