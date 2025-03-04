// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "DebugRouter.h"
#import <DebugRouterReportServiceUtil.h>
#import <DebugRouterToast.h>
#import "DebugRouterGlobalHandler.h"
#import "DebugRouterInternalStateListener.h"
#import "DebugRouterLog.h"
#import "DebugRouterReport.h"
#import "DebugRouterSlot.h"
#include "DebugRouterUtil.h"
#import "DebugRouterVersion.h"
#include "debug_router/native/core/debug_router_config.h"
#include "debug_router/native/core/debug_router_core.h"

#include <json/json.h>

typedef enum : NSUInteger {
  CONNECTION_SCENE_UNINIT,
  FIRST_CONNECT,
  NO_FIRST_CONNECT
} ConnectionScene;

typedef enum : NSUInteger { APP_STATE_UNINIT, FOREGROUND, BACKGROUND } AppState;

class NativeSlotDeleagate : public debugrouter::core::NativeSlot {
 public:
  NativeSlotDeleagate(DebugRouterSlot *slot, const std::string &type, const std::string &url)
      : debugrouter::core::NativeSlot(type, url), slot_ios_(slot) {}
  virtual void OnMessage(const std::string &message, const std::string &type) override {
    NSString *messageNSStr = [NSString stringWithUTF8String:message.c_str()];
    NSString *typeNSStr = [NSString stringWithUTF8String:type.c_str()];
    [slot_ios_ onMessage:messageNSStr WithType:typeNSStr];
  }

 private:
  DebugRouterSlot *slot_ios_;
};

class StateListenerDeleagte : public debugrouter::core::DebugRouterStateListener {
 public:
  StateListenerDeleagte(id<DebugRouterStateListener> listener) : listener_ios_(listener) {}
  virtual void OnOpen(debugrouter::core::ConnectionType type) override {
    ConnectionType connnectionType = Unknown;
    switch (type) {
      case debugrouter::core::ConnectionType::kWebSocket:
        connnectionType = ConnectionTypeWebSocket;
        break;
      case debugrouter::core::ConnectionType::kUsb:
        connnectionType = ConnectionTypeUSB;
        break;
      default:
        break;
    }
    [listener_ios_ onOpen:connnectionType];
  }
  virtual void OnClose(int32_t code, const std::string &reason) override {
    [listener_ios_ onClose:code withReason:[NSString stringWithUTF8String:reason.c_str()]];
  }
  virtual void OnMessage(const std::string &message) override {
    [listener_ios_ onMessage:[NSString stringWithUTF8String:message.c_str()]];
  }
  virtual void OnError(const std::string &error) override {
    [listener_ios_ onError:[NSString stringWithUTF8String:error.c_str()]];
  }

 private:
  id<DebugRouterStateListener> listener_ios_;
};

class GlobalHandlerDelegate : public debugrouter::core::DebugRouterGlobalHandler {
 public:
  GlobalHandlerDelegate(id<DebugRouterGlobalHandler> handler) : handler_(handler) {}

  virtual void OpenCard(const std::string &url) override {
    [handler_ openCard:[NSString stringWithUTF8String:url.c_str()]];
  }
  virtual void OnMessage(const std::string &message, const std::string &type) override {
    [handler_ onMessage:[NSString stringWithUTF8String:message.c_str()]
               withType:[NSString stringWithUTF8String:type.c_str()]];
  }

 private:
  id<DebugRouterGlobalHandler> handler_;
};

class SessionHandlerDelegate : public debugrouter::core::DebugRouterSessionHandler {
 public:
  SessionHandlerDelegate(id<DebugRouterSessionHandler> handler) : handler_(handler) {}

  virtual void OnMessage(const std::string &message, const std::string &type,
                         int32_t session_id) override {
    [handler_ onMessage:[NSString stringWithUTF8String:message.c_str()]
               withType:[NSString stringWithUTF8String:type.c_str()]
          withSessionId:session_id];
  }
  virtual void OnSessionCreate(int32_t session_id, const std::string &url) override {
    [handler_ onSessionCreate:session_id withUrl:[NSString stringWithUTF8String:url.c_str()]];
  }
  virtual void OnSessionDestroy(int32_t session_id) override {
    [handler_ onSessionDestroy:session_id];
  }

 private:
  id<DebugRouterSessionHandler> handler_;
};

class MessageHandlerDelegate : public debugrouter::core::DebugRouterMessageHandler {
 public:
  MessageHandlerDelegate(id<DebugRouterMessageHandler> handler) : handler_(handler) {}

  virtual std::string GetName() const override {
    NSString *handler_name = [handler_ getName];
    return [handler_name UTF8String];
  }

  virtual std::string Handle(std::string params) override {
    LLogInfo(@"MessageHandlerDelegate handle params.");
    Json::Value paramsJson;
    Json::Reader reader;
    bool result = reader.parse(params, paramsJson);
    if (!result) {
      LLogError(@"Handle: params is invalid json: %s ", params.c_str());
      NSString *errorStr = [[[DebugRouterMessageHandleResult alloc]
          initWithCode:-1
               message:@"params resolve error"] toJsonString];
      return std::string([errorStr UTF8String]);
    }
    NSMutableDictionary<NSString *, NSString *> *paramsMap = [[NSMutableDictionary alloc] init];
    for (auto it = paramsJson.begin(); it != paramsJson.end(); it++) {
      NSString *key = [NSString stringWithCString:it.key().asString().c_str()
                                         encoding:[NSString defaultCStringEncoding]];
      std::string valueStr;
      if (it->isConvertibleTo(Json::stringValue)) {
        valueStr = it->asString();
      } else {
        valueStr = it->toStyledString();
      }
      NSString *value = [NSString stringWithCString:valueStr.c_str()
                                           encoding:[NSString defaultCStringEncoding]];
      [paramsMap setObject:value forKey:key];
    }
    DebugRouterMessageHandleResult *handleResult = [handler_ handleMessageWithParams:paramsMap];
    if (handleResult == nil) {
      handleResult = [[DebugRouterMessageHandleResult alloc] init];
    }
    return std::string([[handleResult toJsonString] UTF8String]);
  }

 private:
  id<DebugRouterMessageHandler> handler_;
};

#pragma mark - DebugRouter
@interface DebugRouter ()
- (void)appExit;
- (void)handleDidBecomeActive:(NSNotification *)notification;
- (void)handleEnterBackground:(NSNotification *)notification;
@end
@implementation DebugRouter {
  bool recordAppIdleTimerDisabledStatus;
  AppState appState_;
  NSMapTable *viewMap_;
  NSMutableDictionary *global_handler_map;
  NSMutableDictionary *session_handler_map;
}

+ (DebugRouter *)instance {
  static DebugRouter *instance_ = nil;
  static dispatch_once_t token;
  dispatch_once(&token, ^{
    instance_ = [[DebugRouter alloc] init];
  });
  return instance_;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    [self initReportService];
    viewMap_ = [NSMapTable mapTableWithKeyOptions:NSMapTableWeakMemory
                                     valueOptions:NSMapTableStrongMemory];
    DebugRouterAddDebugLogObserver();
    debugrouter::core::DebugRouterCore::GetInstance().SetAppInfo(
        "App", [[[NSProcessInfo processInfo] processName] UTF8String]);
    debugrouter::core::DebugRouterCore::GetInstance().SetAppInfo(
        "debugRouterVersion", [[DebugRouterVersion versionString] UTF8String]);
    debugrouter::core::DebugRouterCore::GetInstance().SetAppInfo(
        "bundleId", [[[NSBundle mainBundle] bundleIdentifier] UTF8String]);
    debugrouter::core::DebugRouterCore::GetInstance().SetAppInfo("osType", "iOS");
    NSUUID *id_generate = [NSUUID UUID];
    NSString *id_string = [id_generate UUIDString];
    // A process-level id that identifies the unique id of a debugRouter connection
    // If the connection is completely disconnected and then reconnected, a new debugRouterId will
    // be generated
    debugrouter::core::DebugRouterCore::GetInstance().SetAppInfo("debugRouterId",
                                                                 [id_string UTF8String]);
    global_handler_map = [[NSMutableDictionary alloc] init];
    session_handler_map = [[NSMutableDictionary alloc] init];

    [DebugRouterUtil dispatchMainAsyncSafe:^() {
      self->recordAppIdleTimerDisabledStatus = [UIApplication sharedApplication].idleTimerDisabled;
    }];

    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(appExit)
                                                 name:@"UIApplicationWillTerminateNotification"
                                               object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(handleDidBecomeActive:)
                                                 name:@"UIApplicationDidBecomeActiveNotification"
                                               object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(handleEnterBackground:)
                                                 name:@"UIApplicationDidEnterBackgroundNotification"
                                               object:nil];
    [self addStateListener:[[DebugRouterInternalStateListener alloc] init]];
  }

  return self;
}

- (void)appExit {
  LLogInfo(@"appExit");
  [UIApplication sharedApplication].idleTimerDisabled = recordAppIdleTimerDisabledStatus;
}

- (void)handleEnterBackground:(NSNotification *)notification {
  LLogInfo(@"handleEnterBackground");
  appState_ = BACKGROUND;
}

- (void)handleDidBecomeActive:(NSNotification *)notification {
  LLogInfo(@"handleDidBecomeActive");
  if (appState_ == BACKGROUND && self.connection_state == DISCONNECTED) {
    LLogInfo(@"create new usb server");
    // create new usb server TODO(zhoumingsong.smile)
  }
  appState_ = FOREGROUND;
}

- (void)connect:(NSString *)url ToRoom:(NSString *)room {
  LLogInfo(@"connect url: %@, room: %@", url, room);
  debugrouter::core::DebugRouterCore::GetInstance().Connect([url UTF8String], [room UTF8String]);
}

- (void)disconnect {
  LLogInfo(@"disconnect");
  debugrouter::core::DebugRouterCore::GetInstance().Disconnect();
}

- (void)send:(NSString *)message {
  debugrouter::core::DebugRouterCore::GetInstance().Send([message UTF8String]);
}

- (void)sendData:(NSString *)data WithType:(NSString *)type ForSession:(int)session {
  [self sendData:data WithType:type ForSession:session WithMark:-1];
}

- (void)sendData:(NSString *)data
        WithType:(NSString *)type
      ForSession:(int)session
        WithMark:(int)mark {
  [self sendData:data WithType:type ForSession:session WithMark:mark isObject:NO];
}

- (void)sendObject:(NSDictionary *)data WithType:(NSString *)type ForSession:(int)session {
  [self sendObject:data WithType:type ForSession:session WithMark:-1];
}

- (void)sendObject:(NSDictionary *)data
          WithType:(NSString *)type
        ForSession:(int)session
          WithMark:(int)mark {
  NSError *error;
  NSData *jsonData = [NSJSONSerialization dataWithJSONObject:data
                                                     options:NSJSONWritingPrettyPrinted
                                                       error:&error];
  NSString *jsonString;
  if (jsonData) {
    jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    [self sendData:jsonString WithType:type ForSession:session WithMark:mark isObject:YES];
  }
}

- (void)sendData:(NSString *)data
        WithType:(NSString *)type
      ForSession:(int)session
        WithMark:(int)mark
        isObject:(BOOL)isObject {
  debugrouter::core::DebugRouterCore::GetInstance().SendData([data UTF8String], [type UTF8String],
                                                             session, mark, isObject);
}

- (void)sendAsync:(NSString *)message {
  debugrouter::core::DebugRouterCore::GetInstance().SendAsync([message UTF8String]);
}

- (void)sendDataAsync:(NSString *)data WithType:(NSString *)type ForSession:(int)session {
  [self sendDataAsync:data WithType:type ForSession:session WithMark:-1];
}

- (void)sendDataAsync:(NSString *)data
             WithType:(NSString *)type
           ForSession:(int)session
             WithMark:(int)mark {
  debugrouter::core::DebugRouterCore::GetInstance().SendDataAsync(
      [data UTF8String], [type UTF8String], session, mark, false);
}

- (void)sendObjectAsync:(NSDictionary *)data WithType:(NSString *)type ForSession:(int)session {
  [self sendObjectAsync:data WithType:type ForSession:session WithMark:-1];
}

- (void)sendObjectAsync:(NSDictionary *)data
               WithType:(NSString *)type
             ForSession:(int)session
               WithMark:(int)mark {
  NSError *error;
  NSData *jsonData = [NSJSONSerialization dataWithJSONObject:data
                                                     options:NSJSONWritingPrettyPrinted
                                                       error:&error];
  NSString *jsonString;
  if (jsonData) {
    jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    debugrouter::core::DebugRouterCore::GetInstance().SendDataAsync(
        [jsonString UTF8String], [type UTF8String], session, mark, true);
  }
}

- (int)plug:(DebugRouterSlot *)slot {
  LLogInfo(@"plug %@", [slot getTemplateUrl]);

  int32_t sessionId =
      debugrouter::core::DebugRouterCore::GetInstance().Plug(std::make_shared<NativeSlotDeleagate>(
          slot, [[slot type] UTF8String], [[slot getTemplateUrl] UTF8String]));
  UIView *view = [slot getTemplateView];
  if (view != nil) {
    @synchronized(viewMap_) {
      [viewMap_ setObject:@(sessionId) forKey:(id)view];
    }
  }
  return sessionId;
}

- (void)pull:(int)sessionId {
  LLogInfo(@"pull session %d", sessionId);
  debugrouter::core::DebugRouterCore::GetInstance().Pull(sessionId);
}

- (void)initReportService {
  id reportServiceInstance = [DebugRouterReportServiceUtil getReportServiceInstance];
  if (reportServiceInstance) {
    DebugRouterMetaInfo *metaInfo = [[DebugRouterMetaInfo alloc] init];
    metaInfo.debugrouterVersion = [DebugRouterVersion versionString];
    metaInfo.appProcessName = [[NSProcessInfo processInfo] processName];
    [reportServiceInstance initService:metaInfo];
    NSString *tag = @"DebugRouterInit";
    NSDictionary *categroy = nil;
    [DebugRouterReport report:tag withCategory:categroy];
  } else {
    LLogInfo(@"only toast in first connection when error occurs");
  }
}

- (void)addGlobalHandler:(id<DebugRouterGlobalHandler>)handler {
  if (handler == nil) {
    return;
  }
  GlobalHandlerDelegate *handlerDelegate = new GlobalHandlerDelegate(handler);
  int handlerId =
      debugrouter::core::DebugRouterCore::GetInstance().AddGlobalHandler(handlerDelegate);
  NSNumber *key = [NSNumber numberWithUnsignedInteger:(NSUInteger)handler];
  [global_handler_map setObject:@(handlerId) forKey:key];
}

- (BOOL)removeGlobalHandler:(id<DebugRouterGlobalHandler>)handler {
  if (handler == nil) {
    return false;
  }
  NSNumber *key = [NSNumber numberWithUnsignedInteger:(NSUInteger)handler];
  NSNumber *removedHandlerId = [global_handler_map objectForKey:key];
  if (removedHandlerId) {
    [global_handler_map removeObjectForKey:key];
    int removedId = [removedHandlerId intValue];
    return debugrouter::core::DebugRouterCore::GetInstance().RemoveGlobalHandler(removedId);
  }
  return false;
}

- (void)addMessageHandler:(id<DebugRouterMessageHandler>)handler {
  debugrouter::core::DebugRouterCore::GetInstance().AddMessageHandler(
      new MessageHandlerDelegate(handler));
}

- (BOOL)removeMessageHandler:(id<DebugRouterMessageHandler>)handler {
  return debugrouter::core::DebugRouterCore::GetInstance().RemoveMessageHandler(
      [[handler getName] UTF8String]);
}

- (void)addSessionHandler:(id<DebugRouterSessionHandler>)handler {
  if (handler == nil) {
    return;
  }
  SessionHandlerDelegate *handlerDelegate = new SessionHandlerDelegate(handler);
  int handlerId =
      debugrouter::core::DebugRouterCore::GetInstance().AddSessionHandler(handlerDelegate);
  NSNumber *key = [NSNumber numberWithUnsignedInteger:(NSUInteger)handler];
  [session_handler_map setObject:@(handlerId) forKey:key];
}

- (BOOL)removeSessionHandler:(id<DebugRouterSessionHandler>)handler {
  if (handler == nil) {
    return false;
  }
  NSNumber *key = [NSNumber numberWithUnsignedInteger:(NSUInteger)handler];
  NSNumber *removedHandlerId = [session_handler_map objectForKey:key];
  if (removedHandlerId) {
    [session_handler_map removeObjectForKey:key];
    int removedId = [removedHandlerId intValue];
    return debugrouter::core::DebugRouterCore::GetInstance().RemoveSessionHandler(removedId);
  }
  return false;
}

- (BOOL)isValidSchema:(NSString *)schema {
  return debugrouter::core::DebugRouterCore::GetInstance().IsValidSchema([schema UTF8String]);
}

- (BOOL)handleSchema:(NSString *)schema {
  LLogInfo(@"handleSchema: %@", schema);
  return debugrouter::core::DebugRouterCore::GetInstance().HandleSchema([schema UTF8String]);
}

- (void)addStateListener:(id<DebugRouterStateListener>)listener {
  debugrouter::core::DebugRouterCore::GetInstance().AddStateListener(
      std::make_shared<StateListenerDeleagte>(listener));
}

- (int)usb_port {
  return debugrouter::core::DebugRouterCore::GetInstance().GetUSBPort();
}

- (NSString *)room_id {
  std::string roomId = debugrouter::core::DebugRouterCore::GetInstance().GetRoomId();
  return [NSString stringWithUTF8String:roomId.c_str()];
}

- (NSString *)server_url {
  std::string serverUrl = debugrouter::core::DebugRouterCore::GetInstance().GetServerUrl();
  return [NSString stringWithUTF8String:serverUrl.c_str()];
}

- (ConnectionState)connection_state {
  debugrouter::core::ConnectionState state =
      debugrouter::core::DebugRouterCore::GetInstance().GetConnectionState();
  switch (state) {
    case debugrouter::core::CONNECTED:
      return CONNECTED;
    case debugrouter::core::DISCONNECTED:
      return DISCONNECTED;
    case debugrouter::core::CONNECTING:
      return CONNECTING;
  }
  return DISCONNECTED;
}

- (void)setConfig:(BOOL)value forKey:(NSString *)configKey {
  std::string configKeyStr = [configKey UTF8String];
  std::string valueStr = value ? "true" : "false";
  debugrouter::core::DebugRouterConfigs::GetInstance().SetConfig(configKeyStr, valueStr);
}

- (BOOL)getConfig:(NSString *)configKey withDefaultValue:(BOOL)defaultValue {
  std::string configKeyStr = [configKey UTF8String];
  std::string defaultValueStr = defaultValue ? "true" : "false";
  std::string result =
      debugrouter::core::DebugRouterConfigs::GetInstance().GetConfig(configKeyStr, defaultValueStr);
  if (result == "true") {
    return true;
  } else {
    return false;
  }
  LLogWarn(@"getConfig: unknown value:%s", result.c_str());
  return false;
}

- (void)setAppInfo:(nonnull NSString *)key withValue:(nonnull NSString *)value {
  debugrouter::core::DebugRouterCore::GetInstance().SetAppInfo([key UTF8String],
                                                               [value UTF8String]);
}

- (int)getSessionIdByView:(nonnull UIView *)view {
  @synchronized(viewMap_) {
    NSNumber *session_number = [viewMap_ objectForKey:(id)view];
    return session_number ? [session_number intValue] : 0;
  }
}

- (void)setSessionId:(int)sessionId ofView:(UIView *)view {
  @synchronized(viewMap_) {
    [viewMap_ setObject:@(sessionId) forKey:(id)view];
  }
}

- (UIView *)getViewBySessionId:(int)sessionId {
  @synchronized(viewMap_) {
    for (UIView *view in viewMap_) {
      NSNumber *viewSessionId = [viewMap_ objectForKey:view];
      if ([viewSessionId integerValue] == sessionId) {
        return view;
      }
    }
    return nil;
  }
}

- (NSString *)getAppInfoByKey:(nonnull NSString *)key {
  std::string infoString =
      debugrouter::core::DebugRouterCore::GetInstance().GetAppInfoByKey([key UTF8String]);
  return [NSString stringWithUTF8String:infoString.c_str()];
}

@end
