// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

extern const NSString *NOT_IMPLETEMTED_MESSAGE;
extern const int CODE_NOT_IMPLEMENTED;
extern const int CODE_HANDLE_FAILED;
extern const int CODE_HANDLE_SUCCESSFULLY;

@interface DebugRouterMessageHandleResult : NSObject {
  int code;
  const NSString *message;
}

@property(getter=data, strong) NSMutableDictionary<NSString *, id> *data;

// Error
- (id)initWithCode:(int)code message:(const NSString *)message;

// Success with data
- (id)init:(nullable NSMutableDictionary<NSString *, id> *)data;

// Default result:(Success without any data)
- (id)init;

- (NSString *)toJsonString;

- (NSMutableDictionary<NSString *, id> *)toDict;

- (NSMutableDictionary<NSString *, NSString *> *)toStringDict;

@end

NS_ASSUME_NONNULL_END
