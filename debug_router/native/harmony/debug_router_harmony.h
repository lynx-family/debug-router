// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_HARMONY_H_
#define DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_HARMONY_H_

#include <node_api.h>
#include <uv.h>

#include <memory>
#include <string>
#include <vector>

#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/harmony/debug_router_global_handler_harmony.h"
#include "debug_router/native/harmony/debug_router_message_handler_harmony.h"
#include "debug_router/native/harmony/debug_router_target_handler_harmony.h"

namespace debugrouter {
namespace harmony {

typedef enum { Unknown = -1, WebSocket = 0, USB } ConnectionType;

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
  static napi_value AddTargetHandler(
      napi_env env,
      napi_callback_info info);  // DebugRouterTargetHandlerHarmony *handler
  static napi_value RemoveTargetHandler(napi_env env, napi_callback_info info);
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
      napi_callback_info info);  // type, target_id, data

  static napi_value Plug(
      napi_env env,
      napi_callback_info info);  // std::shared_ptr<DebugRouterSlot> &target
  static napi_value Pull(napi_env env, napi_callback_info info);  // target_id

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

  static napi_value EnableAllTargets(napi_env env, napi_callback_info info);
  static napi_value EnableSingleTarget(napi_env env, napi_callback_info info);
  static napi_value EnableDebugChannel(napi_env env, napi_callback_info info);
  static napi_value DisableDebugChannel(napi_env env, napi_callback_info info);
  static napi_value IsDebugChannelEnabled(napi_env env,
                                          napi_callback_info info);

  struct GlobalHandlerRegistration {
    int handler_id;
    std::shared_ptr<DebugRouterGlobalHandlerHarmony> handler;
  };
  struct TargetHandlerRegistration {
    int handler_id;
    std::shared_ptr<DebugRouterTargetHandlerHarmony> handler;
  };
  struct MessageHandlerRegistration {
    std::string handler_name;
    std::shared_ptr<DebugRouterMessageHandlerHarmony> handler;
  };

  static std::vector<GlobalHandlerRegistration> global_handlers_;
  static std::vector<TargetHandlerRegistration> target_handlers_;
  static std::vector<MessageHandlerRegistration> message_handlers_;
};

}  // namespace harmony
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_HARMONY_H_
