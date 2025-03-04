// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterMessageHandleResult.h"
#import "DebugRouterLog.h"
#import "DebugRouterUtil.h"

const NSString *NOT_IMPLETEMTED_MESSAGE = @"not implemented";
const int CODE_NOT_IMPLEMENTED = -2;
const int CODE_HANDLE_FAILED = -1;
const int CODE_HANDLE_SUCCESSFULLY = 0;

@implementation DebugRouterMessageHandleResult

- (id)initWithCode:(int)code message:(const NSString *)message {
  self = [super init];
  if (self != nil) {
    self.data = [[NSMutableDictionary alloc] init];
    self->code = code;
    self->message = message;
  }
  return self;
}
- (id)init:(nullable NSMutableDictionary<NSString *, id> *)data {
  self = [super init];
  if (self != nil) {
    self.data = [[NSMutableDictionary alloc] init];
    code = 0;
    message = @"";
    if (data != nil && data.count > 0) {
      [self.data addEntriesFromDictionary:data];
    }
  }
  return self;
}
- (id)init {
  return [self init:nil];
}

- (NSString *)toJsonString {
  NSMutableDictionary<NSString *, id> *dict =
      (NSMutableDictionary<NSString *, id> *)[self toStringDict];
  NSData *jsonData = [DebugRouterUtil dictToJson:dict];

  NSString *result = @"{}";
  if (jsonData == nil) {
    LLogError(@"toJsonString: jsonData == nil");
    return result;
  }
  NSString *jsonStr = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
  if (jsonStr == nil) {
    LLogError(@"toJsonString: encoding error");
  } else {
    result = jsonStr;
  }
  return result;
}

- (NSMutableDictionary<NSString *, id> *)toDict {
  NSMutableDictionary<NSString *, id> *dict = [[NSMutableDictionary alloc] init];
  [dict setObject:[NSNumber numberWithInt:code] forKey:@"code"];
  [dict setObject:message forKey:@"message"];
  [dict addEntriesFromDictionary:self.data];
  return dict;
}

- (NSMutableDictionary<NSString *, NSString *> *)toStringDict {
  NSMutableDictionary<NSString *, id> *dict = [self toDict];
  NSMutableDictionary<NSString *, NSString *> *stringDict = [[NSMutableDictionary alloc] init];
  for (NSString *key in dict) {
    NSString *objStr = [NSString stringWithFormat:@"%@", [dict objectForKey:key]];
    [stringDict setObject:objStr forKey:key];
  }
  return stringDict;
}
@end
