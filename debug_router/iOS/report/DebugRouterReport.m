// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouterReport.h"
#import "DebugRouterLog.h"
#import "MessageTransceiver.h"

#import <DebugRouterReportServiceUtil.h>
#import <Foundation/Foundation.h>
#import "WebSocketClient.h"

@implementation DebugRouterReport
+ (void)report:(nonnull NSString *)tag
    withCategory:(nullable NSDictionary *)category
      withMetric:(nullable NSDictionary *)metric {
  id reportServiceInstance = [DebugRouterReportServiceUtil getReportServiceInstance];
  if (reportServiceInstance) {
    [reportServiceInstance report:tag withCategory:category withMetric:metric withExtra:nil];
  } else {
    LLogInfo(@"Fail to report because report service cannot be found.");
  }
}

+ (void)report:(nonnull NSString *)tag withCategory:(nullable NSDictionary *)category {
  [self report:tag withCategory:category withMetric:nil];
}

+ (void)report:(nonnull NSString *)tag {
  [self report:tag withCategory:nil withMetric:nil];
}

+ (void)reportConnect:(NSString *)url toRoom:(NSString *)room {
  url = (url == nil) ? @"" : url;
  room = (room == nil) ? @"" : room;
  [self report:@"connect" withCategory:@{@"url" : url, @"room" : room}];
}
+ (void)reportReConnect:(NSString *)url toRoom:(NSString *)room ofConnectType:(NSInteger)type;
{
  url = (url == nil) ? @"" : url;
  room = (room == nil) ? @"" : room;
  [self report:@"reconnect" withCategory:@{@"url" : url, @"room" : room, @"ConnectType" : @(type)}];
}
+ (void)reportChangeRoomServer:(NSString *)url toRoom:(NSString *)room {
  url = (url == nil) ? @"" : url;
  room = (room == nil) ? @"" : room;
  [self report:@"change_room_server" withCategory:@{@"url" : url, @"room" : room}];
}

+ (void)reportHandleScema:(NSString *)url {
  url = (url == nil) ? @"" : url;
  [self report:@"handleSchema" withCategory:@{@"url" : url}];
}

+ (void)reportOnOpen:(MessageTransceiver *)transceiver {
  [self report:@"onOpen"
      withCategory:@{@"connect_type" : [DebugRouterReport getTransceiverType:transceiver]}];
}

+ (void)reportOnClose:(MessageTransceiver *)transceiver
             withCode:(NSInteger)code
           withReason:(NSString *)reason;
{
  reason = (reason == nil) ? @"" : reason;
  [self report:@"onClose"
      withCategory:@{
        @"connect_type" : [DebugRouterReport getTransceiverType:transceiver],
        @"code" : [NSString stringWithFormat:@"%ld", code],
        @"reason" : reason
      }];
}

+ (void)reportFirstConnectOnOpen {
  [self report:@"FirstConnOpen"];
}

+ (void)reportNonFirstConnectOnOpen {
  [self report:@"NonFirstConnOpen"];
}

+ (void)reportHostCannotAccess:(NSString *)host WithPort:(NSString *)port WithUrl:(NSString *)url {
  host = (host == nil) ? @"unknown" : host;
  port = (port == nil) ? @"unknown" : port;
  url = (url == nil) ? @"unknown" : url;
  [self report:@"OnErrorCannotAccess" withCategory:@{@"host" : host, @"port" : port, @"url" : url}];
}

+ (void)reportOnCloseWarnning:(MessageTransceiver *)currentTransceiver
              whenTransceiver:(MessageTransceiver *)transceiver
                    whenState:(NSInteger)state {
  NSString *msg = @"";
  if (currentTransceiver != transceiver) {
    msg = @"different transceiver when close";
  } else if (state == DISCONNECTED) {
    msg = @"ConnectionState is DISCONNECTED when close";
  }
  [self report:@"OnCloseWarning"
      withCategory:@{
        @"connect_type" : [DebugRouterReport getTransceiverType:currentTransceiver],
        @"warning_msg" : msg
      }];
}

+ (void)reportOnErrorWarnning:(MessageTransceiver *)currentTransceiver
              whenTransceiver:(MessageTransceiver *)transceiver
                    whenState:(NSInteger)state {
  NSString *msg = @"";
  if (currentTransceiver != transceiver) {
    msg = @"different transceiver when error";
  } else if (state == DISCONNECTED) {
    msg = @"ConnectionState is DISCONNECTED when error";
  }
  [self report:@"OnErrorWarning"
      withCategory:@{
        @"connect_type" : [DebugRouterReport getTransceiverType:currentTransceiver],
        @"warning_msg" : msg
      }];
}

+ (void)reportOnMessageWarnning:(MessageTransceiver *)currentTransceiver
                whenTransceiver:(MessageTransceiver *)transceiver
                    whenMessage:(NSString *)message {
  message = (message == nil) ? @"" : message;
  [self report:@"OnMessageWarning"
      withCategory:@{
        @"CurrentTransceiver" : [DebugRouterReport getTransceiverType:currentTransceiver],
        @"msg" : [message substringToIndex:MIN(512, [message length])],
        @"Transceiver" : [DebugRouterReport getTransceiverType:transceiver]
      }];
}

+ (void)reportOnError:(NSString *)errorInfo onTransceiver:(MessageTransceiver *)transceiver {
  errorInfo = (errorInfo == nil) ? @"" : errorInfo;
  [self report:@"onError"
      withCategory:@{
        @"connect_type" : [DebugRouterReport getTransceiverType:transceiver],
        @"error_msg" : errorInfo
      }];
}

+ (void)reportProcessError:(NSString *)error {
  [self report:@"ProcessError" withCategory:@{@"error" : error}];
}

+ (void)reportSendMessage:(NSString *)msg {
  msg = (msg == nil) ? @"" : msg;
  [self report:@"SendMessage"
      withCategory:@{@"msg" : [msg substringToIndex:MIN(512, [msg length])]}];
}

+ (void)reportReceiveMessage:(NSString *)msg {
  msg = (msg == nil) ? @"" : msg;
  [self report:@"ReceiveMessage"
      withCategory:@{@"msg" : [msg substringToIndex:MIN(512, [msg length])]}];
}

+ (void)reportNewSocketClient:(NSString *)address {
  address = (address == nil) ? @"" : address;
  [self report:@"new_socket_client" withCategory:@{@"client" : address}];
}

+ (void)reportNewUSBClient:(NSString *)address {
  address = (address == nil) ? @"" : address;
  [self report:@"new_usb_client" withCategory:@{@"client" : address}];
}

+ (void)reportUSBServerInitOK:(NSInteger)port {
  [self report:@"USBServerInitOK"
      withCategory:@{@"port" : [NSString stringWithFormat:@"%ld", port]}];
}

+ (void)reportDurTime:(MessageTransceiver *)transceiver
         withDuration:(NSInteger)duration
           withReason:(NSString *)reason {
  reason = (reason == nil) ? @"unknown" : reason;
  [self report:@"TransceiverTime"
      withCategory:@{
        @"Transceiver" : [DebugRouterReport getTransceiverType:transceiver],
        @"reason" : reason
      }
        withMetric:@{@"duration" : @(duration)}];
}

+ (void)reportDurTimeError:(MessageTransceiver *)transceiver withReason:(NSString *)reason {
  [self report:@"TransceiverTimeError"
      withCategory:@{
        @"Transceiver" : [DebugRouterReport getTransceiverType:transceiver],
        @"reason" : reason
      }];
}

+ (NSString *)getTransceiverType:(MessageTransceiver *)transceiver {
  if ([transceiver isKindOfClass:[WebSocketClient class]]) {
    return @"SRWebSocket";
  }
  return @"null";
}

@end
