// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_HARMONY_H_
#define DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_HARMONY_H_

#include <node_api.h>
#include <uv.h>

#include <map>
#include <memory>
#include <string>

#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/harmony/debug_router_global_handler_harmony.h"
#include "debug_router/native/harmony/debug_router_message_handler_harmony.h"
#include "debug_router/native/harmony/debug_router_session_handler_harmony.h"

namespace debugrouter {
namespace harmony {

typedef enum { Unknown = -1, WebSocket = 0, USB } ConnectionType;

struct NapiValueCompare {
  bool operator()(const napi_value& lhs, const napi_value& rhs) const {
    return lhs < rhs;
  }
};

class DebugRouterHarmony {
 public:
  DebugRouterHarmony() = default;
  static napi_value Init(napi_env env, napi_value exports);

 private:
  static napi_value Constructor(napi_env env, napi_callback_info info);

  static napi_value CreateInstance(napi_env env, napi_callback_info info);
  static napi_value AddGlobalHandler(
      napi_env env,
      napi_callback_info info);  // DebugRouterGlobalHandlerHarmony *handler
  static napi_value RemoveGlobalHandler(napi_env env, napi_callback_info info);
  static napi_value AddSessionHandler(
      napi_env env,
      napi_callback_info info);  // DebugRouterSessionHandlerHarmony *handler
  static napi_value RemoveSessionHandler(napi_env env, napi_callback_info info);
  static napi_value AddMessageHandler(
      napi_env env,
      napi_callback_info info);  // DebugRouterMessageHandlerHarmony *handler
  static napi_value RemoveMessageHandler(napi_env env, napi_callback_info info);

  static napi_value ConnectAsync(napi_env env,
                                 napi_callback_info info);  // url, room
  static napi_value DisconnectAsync(napi_env env, napi_callback_info info);
  static napi_value IsConnected(napi_env env, napi_callback_info info);

  static napi_value SendAsync(napi_env env,
                              napi_callback_info info);  // message
  static napi_value SendDataAsync(
      napi_env env,
      napi_callback_info
          info);  // data, type, session_id(, is_object) 大部分都是前三个参数

  static napi_value Plug(
      napi_env env,
      napi_callback_info info);  // std::shared_ptr<DebugRouterSlot> &slot
  static napi_value Pull(napi_env env, napi_callback_info info);  // session_id

  static napi_value IsValidSchema(napi_env env,
                                  napi_callback_info info);  // schema
  static napi_value HandleSchema(napi_env env,
                                 napi_callback_info info);  // schema

  static napi_value SetAppInfo(
      napi_env env,
      napi_callback_info info);  // app_info(unordered_map) | key, value
  static napi_value GetAppInfoByKey(napi_env env,
                                    napi_callback_info info);  // key
  static napi_value AddStateListener(
      napi_env env,
      napi_callback_info info);  // DebugRouterStateListenerHarmony *listener

  static std::map<napi_value, int, NapiValueCompare> global_handlers_map_;
  static std::map<napi_value, int, NapiValueCompare> session_handlers_map_;
  static std::map<napi_value, std::string, NapiValueCompare>
      message_handlers_map_;
  // 保留强引用，否则DebugRouterGlobalHandlerHarmony会被销毁
  static std::map<napi_value, std::shared_ptr<DebugRouterGlobalHandlerHarmony>,
                  NapiValueCompare>
      global_handlers;
  static std::map<napi_value, std::shared_ptr<DebugRouterSessionHandlerHarmony>,
                  NapiValueCompare>
      session_handlers;
  static std::map<napi_value, std::shared_ptr<DebugRouterMessageHandlerHarmony>,
                  NapiValueCompare>
      message_handlers;
};

}  // namespace harmony
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_HARMONY_H_
