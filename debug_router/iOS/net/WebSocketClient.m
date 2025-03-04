// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "WebSocketClient.h"
#import <SocketRocket/SocketRocket.h>
#import <objc/message.h>
#import "DebugRouterLog.h"

#define dispatch_main_async_safe(block)               \
  if ([NSThread isMainThread]) {                      \
    block();                                          \
  } else {                                            \
    dispatch_async(dispatch_get_main_queue(), block); \
  }

#define WeakSelf(type) __weak typeof(type) weak##type = type;

@interface WebSocketClient () <SRWebSocketDelegate>

@property(nonatomic, strong) SRWebSocket *socket;

@end

@implementation WebSocketClient {
  NSTimer *heart_beat_;
  NSTimeInterval reconnect_time_;
  NSString *url_;
  dispatch_queue_t work_queue_;
}

- (BOOL)connect:(NSString *)url {
  url_ = url;
  self.socket = [[SRWebSocket alloc]
      initWithURLRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:url_]]];
  LLogInfo(@"[WS] connect %@", self.socket.url.absoluteString);
  self.socket.delegate = self;
  [self.socket
      setDelegateDispatchQueue:dispatch_queue_create("DebugRouter", DISPATCH_QUEUE_SERIAL)];
  [self.socket open];
  return YES;
}

- (void)disconnect {
  if (self.socket) {
    [self.socket close];
  }
}

#pragma mark - socket delegate
- (void)webSocketDidOpen:(SRWebSocket *)webSocket {
  reconnect_time_ = 0;

  [self initHeartBeat];
  if (webSocket == self.socket) {
    LLogWarn(@"[WS] onOpen");
    if (self.delegate_) {
      [self.delegate_ onOpen:self];
    }
  }
}

- (void)webSocket:(SRWebSocket *)webSocket didFailWithError:(NSError *)error {
  if (webSocket == self.socket) {
    LLogWarn(@"[WS] OnFailure: %@", error);
    [self destoryHeartBeat];
    self.socket = nil;
    if (self.delegate_) {
      [self.delegate_ onFailure:self withError:[error localizedDescription]];
    }
  }
}

- (void)webSocket:(SRWebSocket *)webSocket
    didCloseWithCode:(NSInteger)code
              reason:(NSString *)reason
            wasClean:(BOOL)wasClean {
  if (webSocket == self.socket) {
    LLogWarn(@"[WS] onClose: code:%ld, reason:%@, wasClean:%d", (long)code, reason, wasClean);
    [self destoryHeartBeat];
    self.socket = nil;
    if (self.delegate_) {
      [self.delegate_ onClosed:self withCode:code withReason:reason];
    }
  }
}

- (void)webSocket:(SRWebSocket *)webSocket didReceivePong:(NSData *)pongPayload {
  NSString *reply = [[NSString alloc] initWithData:pongPayload encoding:NSUTF8StringEncoding];
  LLogInfo(@"[WS] didReceivePong: %@", reply);
}

- (void)webSocket:(SRWebSocket *)webSocket didReceiveMessage:(id)message {
  if (webSocket == self.socket) {
    LLogInfo(@"[WS] onMessage :%@", message);
    if (!message) {
      return;
    }
    [self handleReceivedMessage:message];
  }
}

- (void)reconnect {
  if (!url_ || (self.socket && self.socket.readyState == SR_OPEN)) {
    return;
  }

  [self disconnect];
  if (reconnect_time_ > 128) {
    LLogError(@"[WS] Failed to reconnect");
    return;
  }

  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(reconnect_time_ * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   self.socket = nil;
                   [self connect:self->url_];
                   LLogInfo(@"[WS] try to reconnect");
                 });

  if (reconnect_time_ == 0) {
    reconnect_time_ = 2;
  } else {
    reconnect_time_ *= 2;
  }
}

- (void)initHeartBeat {
  dispatch_main_async_safe(^{
    [self destoryHeartBeat];
    // ping server every 30s
    self->heart_beat_ = [NSTimer timerWithTimeInterval:30
                                                target:self
                                              selector:@selector(ping)
                                              userInfo:nil
                                               repeats:YES];
    [[NSRunLoop currentRunLoop] addTimer:self->heart_beat_ forMode:NSRunLoopCommonModes];
  })
}

- (void)destoryHeartBeat {
  dispatch_main_async_safe(^{
    if (self->heart_beat_) {
      if ([self->heart_beat_ respondsToSelector:@selector(isValid)]) {
        if ([self->heart_beat_ isValid]) {
          [self->heart_beat_ invalidate];
          self->heart_beat_ = nil;
        }
      }
    }
  })
}

- (void)ping {
  if (self.socket.readyState == SR_OPEN) {
    // keep compatible with old version SocketRocket
    SEL sendPingSel = NSSelectorFromString(@"sendPing:");
    SEL sendPingErrorSel = NSSelectorFromString(@"sendPing:error:");
    if ([self.socket respondsToSelector:sendPingErrorSel]) {
      BOOL(*sendPingError)
      (NSData *, NSError **) = (BOOL(*)(NSData *, NSError **))objc_msgSend;
      sendPingError(nil, nil);
    } else if ([self.socket respondsToSelector:sendPingSel]) {
      void (*sendPing)(NSData *) = (void (*)(NSData *))objc_msgSend;
      sendPing(nil);
    }
  }
}

- (void)send:(id)data {
  WeakSelf(self);
  if (work_queue_ == nil) {
    work_queue_ = dispatch_queue_create("ws", NULL);
  }

  dispatch_async(work_queue_, ^{
    if (weakself.socket) {
      if (weakself.socket.readyState == SR_OPEN) {
        LLogInfo(@"[WS] send :%@", data);
        [self.socket send:data];
      }
    }
  });
}

- (SRReadyState)getStatus {
  return self.socket.readyState;
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  LLogInfo(@"[WS] WebSocketClient dealloced");
}

@end
