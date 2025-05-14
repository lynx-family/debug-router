// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterInternalStateListener.h"
#import <Foundation/Foundation.h>
#import "DebugRouterLog.h"
#import "DebugRouterReport.h"
#import "DebugRouterToast.h"
#import "DebugRouterUtil.h"

@implementation DebugRouterInternalStateListener {
  dispatch_queue_t update_data_queue_;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    update_data_queue_ = dispatch_queue_create("DebugRouterUpdate", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)onOpen:(ConnectionType)type {
  [DebugRouterUtil dispatchMainAsyncSafe:^() {
    [UIApplication sharedApplication].idleTimerDisabled = YES;
  }];
  // TODO(zhoumingsong.smile) report
}
- (void)onClose:(NSInteger)code withReason:(nonnull NSString *)reason {
  // TODO(zhoumingsong.smile) report
  // TODO(zhoumingsong.smile) Toast
}
- (void)onMessage:(nonnull NSString *)message {
  // do nothing
}
- (void)onError:(nonnull NSString *)error {
  // TODO(zhoumingsong.smile) report
  // TODO(zhoumingsong.smile) Toast
}

- (void)checkUrlAccessibility:(NSString *)wsUrl {
  if (wsUrl == nil) {
    LLogError(@"checkUrlAccessibility: wsUrl == nil");
    return;
  }
  NSURL *wsURL = [NSURL URLWithString:wsUrl];
  NSString *host = [wsURL host];
  NSNumber *port = [wsURL port];
  NSString *httpUrlString = [NSString stringWithFormat:@"http://%@:%@", host, port];
  NSURL *url = [NSURL URLWithString:httpUrlString];
  NSURLSession *session = [NSURLSession sharedSession];
  NSURLSessionDataTask *task = [session
        dataTaskWithURL:url
      completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        dispatch_async(self->update_data_queue_, ^{
          if (error) {
            NSString *hostString = (host == nil) ? @"unknown" : host;
            NSString *portString = [port stringValue];
            portString = (portString == nil) ? @"unknown" : portString;
            [DebugRouterReport report:@"OnErrorCannotAccess"
                         withCategory:@{@"host" : hostString, @"port" : portString, @"url" : url}];
          }
        });
      }];
  [task resume];
}

- (void)toastUser:(NSInteger)retry_time_ withError:(NSString *)error isWebsocket:(bool)isWebsocket {
  if (!isWebsocket) {
    return;
  }
  if (retry_time_ != 0) {
    LLogInfo(@"only toast in first connection when error occurs");
    return;
  }
  if (error == nil) {
    LLogWarn(@"toastUser: error == nil");
    return;
  }

  if ([error rangeOfString:@"Network is down"].location != NSNotFound) {
    // No Network
    NSString *errorMess = @"The internet is disconnected.";
    [DebugRouterToast showToast:errorMess withTime:2];
  } else if ([error rangeOfString:@"Timed out connecting to server."].location != NSNotFound) {
    // Connect timeout
    NSString *errorMess = @"The network connection timed out. Please check if desktop and phone "
                          @"are on the same network.";
    [DebugRouterToast showToast:errorMess withTime:3];
  }
}

@end
