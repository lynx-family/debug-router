// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <Foundation/Foundation.h>
#import "MessageTransceiver.h"

NS_ASSUME_NONNULL_BEGIN

@interface WebSocketClient : MessageTransceiver

@property(nonatomic, readwrite, nullable) void *cronet_engine;

- (BOOL)connect:(NSString *)url;
- (void)disconnect;
- (void)reconnect;
- (void)send:(id)data;

@end

NS_ASSUME_NONNULL_END
