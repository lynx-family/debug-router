// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterSlot.h"
#import "DebugRouter.h"

#include <unordered_map>
#include "debug_router/native/processor/message_assembler.h"
#include "json/reader.h"

@implementation DebugRouterSlot {
  BOOL plugged_;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    self.session_id = 0;
    plugged_ = NO;
    self.type = @"";
  }
  return self;
}

- (int)plug {
  [self pull];
  self.session_id = [[DebugRouter instance] plug:self];
  plugged_ = YES;
  return self.session_id;
}

- (void)pull {
  if (plugged_) {
    [[DebugRouter instance] pull:self.session_id];
    plugged_ = NO;
  }
}

- (void)send:(NSString *)message {
  [[DebugRouter instance] send:message];
}

- (void)sendData:(NSString *)data WithType:(NSString *)type {
  [[DebugRouter instance] sendData:data WithType:type ForSession:self.session_id];
}

- (void)sendData:(NSString *)data WithType:(NSString *)type WithMark:(int)mark {
  [[DebugRouter instance] sendData:data WithType:type ForSession:self.session_id WithMark:mark];
}

- (void)sendAsync:(NSString *)message {
  [[DebugRouter instance] sendAsync:message];
}
- (void)sendDataAsync:(NSString *)data WithType:(NSString *)type {
  [[DebugRouter instance] sendDataAsync:data WithType:type ForSession:self.session_id];
}

- (void)sendDataAsync:(NSString *)data WithType:(NSString *)type WithMark:(int)mark {
  [[DebugRouter instance] sendDataAsync:data
                               WithType:type
                             ForSession:self.session_id
                               WithMark:mark];
}

- (NSString *)getTemplateUrl {
  if (self.delegate && [self.delegate getTemplateUrl]) {
    return [self.delegate getTemplateUrl];
  }
  return @"___UNKNOWN___";
}

- (UIView *)getTemplateView {
  if (self.delegate) {
    SEL sel = NSSelectorFromString(@"getTemplateView");
    if ([self.delegate respondsToSelector:sel]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
      id res = [self.delegate performSelector:sel];
#pragma clang diagnostic pop
      UIView *view = (UIView *)res;
      return view;
    }
  }
  return nil;
}

- (void)onMessage:(NSString *)message WithType:(NSString *)type {
  [self.delegate onMessage:message WithType:type];
}

- (void)dispatchDocumentUpdated {
  std::string data = debugrouter::processor::MessageAssembler::AssembleDispatchDocumentUpdated();
  [self sendDataAsync:[NSString stringWithUTF8String:data.c_str()] WithType:@"CDP"];
}
- (void)dispatchFrameNavigated:(NSString *)url {
  std::string data =
      debugrouter::processor::MessageAssembler::AssembleDispatchFrameNavigated([url UTF8String]);
  [self sendDataAsync:[NSString stringWithUTF8String:data.c_str()] WithType:@"CDP"];
}

- (void)clearScreenCastCache {
}

- (void)dispatchScreencastVisibilityChanged:(BOOL)status {
  std::string data =
      debugrouter::processor::MessageAssembler::AssembleDispatchScreencastVisibilityChanged(status);
  [self sendDataAsync:[NSString stringWithUTF8String:data.c_str()] WithType:@"CDP"];
}

- (void)sendScreenCast:(NSString *)data andMetadata:(NSDictionary *)metadata {
  std::unordered_map<std::string, float> md;
  for (NSString *key in metadata) {
    md[[key UTF8String]] = [metadata[key] floatValue];
  }

  auto cdp_data = debugrouter::processor::MessageAssembler::AssembleScreenCastFrame(
      self.session_id, [data UTF8String], md);
  NSString *msg = [NSString stringWithUTF8String:cdp_data.c_str()];

  [self sendDataAsync:msg WithType:@"CDP"];
}

@end
