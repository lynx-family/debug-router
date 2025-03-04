// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class MessageTransceiver;
@protocol MessageTransceiverDelegate <NSObject>

@required
- (void)onOpen:(MessageTransceiver *)transceiver;
- (void)onClosed:(MessageTransceiver *)transceiver
        withCode:(NSInteger)code
      withReason:(NSString *)reason;
- (void)onFailure:(MessageTransceiver *)transceiver withError:(NSString *)error;
- (void)onMessage:(id)message fromTransceiver:(MessageTransceiver *)transceiver;

@end

@interface MessageTransceiver : NSObject

@property(nonatomic, readwrite, nullable, strong) id<MessageTransceiverDelegate> delegate_;

- (BOOL)connect:(NSString *)url;
- (void)disconnect;
- (void)reconnect;
- (void)send:(id)data;
- (void)handleReceivedMessage:(id)message;
@end

NS_ASSUME_NONNULL_END
