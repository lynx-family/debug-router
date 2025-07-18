// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/harmony/debug_router_session_handler_harmony.h"

#include "debug_router/native/harmony/base/fml/message_loop.h"
#include "debug_router/native/harmony/base/napi_util.h"

namespace debugrouter {
namespace harmony {

DebugRouterSessionHandlerHarmony::DebugRouterSessionHandlerHarmony(
    napi_env env, napi_value js_this)
    : env_(env), js_this_ref_(nullptr) {
  napi_create_reference(env, js_this, 1, &js_this_ref_);
  napi_get_uv_event_loop(env, &loop_);
}

void DebugRouterSessionHandlerHarmony::OnSessionCreate(int session_id,
                                                       const std::string &url) {
  auto ui_task_runner =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop_)
          .GetTaskRunner();
  ui_task_runner->PostTask([weak_ptr = weak_from_this(), session_id, url]() {
    napi_value js_this;
    auto handler = weak_ptr.lock();
    if (!handler) {
      return;
    }
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);
    napi_value onSessionCreate;
    auto status = napi_get_named_property(handler->env_, js_this,
                                          "onSessionCreate", &onSessionCreate);

    napi_value args[2];
    napi_create_int32(handler->env_, session_id, &args[0]);
    napi_create_string_utf8(handler->env_, url.c_str(), NAPI_AUTO_LENGTH,
                            &args[1]);

    napi_value result;
    status = napi_call_function(handler->env_, js_this, onSessionCreate, 2,
                                args, &result);
  });
}

void DebugRouterSessionHandlerHarmony::OnSessionDestroy(int session_id) {
  auto ui_task_runner =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop_)
          .GetTaskRunner();
  ui_task_runner->PostTask([weak_ptr = weak_from_this(), session_id]() {
    napi_value js_this;
    auto handler = weak_ptr.lock();
    if (!handler) {
      return;
    }
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);
    napi_value onSessionDestroy;
    auto status = napi_get_named_property(
        handler->env_, js_this, "onSessionDestroy", &onSessionDestroy);

    napi_value args[1];
    napi_create_int32(handler->env_, session_id, &args[0]);

    napi_value result;
    status = napi_call_function(handler->env_, js_this, onSessionDestroy, 1,
                                args, &result);
  });
}

void DebugRouterSessionHandlerHarmony::OnMessage(const std::string &message,
                                                 const std::string &type,
                                                 int session_id) {
  auto ui_task_runner =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop_)
          .GetTaskRunner();
  ui_task_runner->PostTask([weak_ptr = weak_from_this(), message, type,
                            session_id]() {
    napi_value js_this;
    auto handler = weak_ptr.lock();
    if (!handler) {
      return;
    }
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);
    napi_value onMessage;
    auto status = napi_get_named_property(handler->env_, js_this, "onMessage",
                                          &onMessage);

    napi_value args[3];
    napi_create_string_utf8(handler->env_, message.c_str(), NAPI_AUTO_LENGTH,
                            &args[0]);
    napi_create_string_utf8(handler->env_, type.c_str(), NAPI_AUTO_LENGTH,
                            &args[1]);
    napi_create_int32(handler->env_, session_id, &args[2]);

    napi_value result;
    status =
        napi_call_function(handler->env_, js_this, onMessage, 3, args, &result);
  });
}

}  // namespace harmony
}  // namespace debugrouter
