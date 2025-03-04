// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterCommon.h"

@class MessageTransceiver;

@interface DebugRouterReport : NSObject
+ (void)report:(nonnull NSString *)tag withCategory:(nullable NSDictionary *)category;
+ (void)reportConnect:(nonnull NSString *)url toRoom:(nonnull NSString *)room;
+ (void)reportReConnect:(nonnull NSString *)url
                 toRoom:(nonnull NSString *)room
          ofConnectType:(NSInteger)type;
+ (void)reportChangeRoomServer:(nonnull NSString *)url toRoom:(nonnull NSString *)room;
+ (void)reportHandleScema:(nonnull NSString *)url;
+ (void)reportOnOpen:(nonnull MessageTransceiver *)transceiver;
+ (void)reportOnClose:(nonnull MessageTransceiver *)transceiver
             withCode:(NSInteger)code
           withReason:(nonnull NSString *)reason;
+ (void)reportOnCloseWarnning:(nonnull MessageTransceiver *)currentTransceiver
              whenTransceiver:(nonnull MessageTransceiver *)transceiver
                    whenState:(NSInteger)state;
+ (void)reportOnErrorWarnning:(nonnull MessageTransceiver *)currentTransceiver
              whenTransceiver:(nonnull MessageTransceiver *)transceiver
                    whenState:(NSInteger)state;
+ (void)reportOnMessageWarnning:(nonnull MessageTransceiver *)currentTransceiver
                whenTransceiver:(nonnull MessageTransceiver *)transceiver
                    whenMessage:(nonnull NSString *)message;
+ (void)reportOnError:(nonnull NSString *)errorInfo
        onTransceiver:(nonnull MessageTransceiver *)transceiver;
+ (void)reportSendMessage:(nonnull NSString *)msg;
+ (void)reportReceiveMessage:(nonnull NSString *)msg;
+ (void)reportProcessError:(nonnull NSString *)error;
+ (void)reportNewSocketClient:(nonnull NSString *)address;
+ (void)reportNewUSBClient:(nonnull NSString *)address;
+ (void)reportUSBServerInitOK:(NSInteger)port;
// User-initiated connection's OnOpen
+ (void)reportFirstConnectOnOpen;
// non-user-initiated connection's OnOpen
+ (void)reportNonFirstConnectOnOpen;
+ (void)reportHostCannotAccess:(nonnull NSString *)host
                      WithPort:(nonnull NSString *)port
                       WithUrl:(nonnull NSString *)url;
+ (void)reportDurTime:(nonnull MessageTransceiver *)transceiver
         withDuration:(NSInteger)duration
           withReason:(nonnull NSString *)reason;
+ (void)reportDurTimeError:(nonnull MessageTransceiver *)transceiver
                withReason:(nonnull NSString *)reason;
@end
