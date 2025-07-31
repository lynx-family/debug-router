// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/harmony/debug_router_state_listener_harmony.h"

#include "debug_router/native/harmony/base/fml/message_loop.h"
#include "debug_router/native/harmony/base/napi_util.h"
#include "napi/native_api.h"

namespace debugrouter {
namespace harmony {

DebugRouterStateListenerHarmony::DebugRouterStateListenerHarmony(
    napi_env env, napi_value js_this)
    : env_(env), js_this_ref_(nullptr) {
  napi_create_reference(env, js_this, 1, &js_this_ref_);
  napi_get_uv_event_loop(env, &loop_);
}

void DebugRouterStateListenerHarmony::OnOpen(
    debugrouter::core::ConnectionType type) {
  auto ui_task_runner =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop_)
          .GetTaskRunner();
  ui_task_runner->PostTask([weak_ptr = weak_from_this(), type]() {
    napi_value js_this;
    auto handler = weak_ptr.lock();
    if (!handler) {
      return;
    }
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);
    napi_value onOpen;
    auto status =
        napi_get_named_property(handler->env_, js_this, "onOpen", &onOpen);

    napi_value args[1];
    napi_create_string_utf8(handler->env_,
                            debugrouter::core::ConnectionTypes[type].c_str(),
                            NAPI_AUTO_LENGTH, &args[0]);

    napi_value result;
    status =
        napi_call_function(handler->env_, js_this, onOpen, 1, args, &result);
  });
}

void DebugRouterStateListenerHarmony::OnClose(int32_t code,
                                              const std::string &reason) {
  auto ui_task_runner =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop_)
          .GetTaskRunner();
  ui_task_runner->PostTask([weak_ptr = weak_from_this(), code, reason]() {
    napi_value js_this;
    auto handler = weak_ptr.lock();
    if (!handler) {
      return;
    }
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);
    napi_value onClose;
    auto status =
        napi_get_named_property(handler->env_, js_this, "onClose", &onClose);

    napi_value args[2];
    napi_create_int32(handler->env_, code, &args[0]);
    napi_create_string_utf8(handler->env_, reason.c_str(), NAPI_AUTO_LENGTH,
                            &args[1]);

    napi_value result;
    status =
        napi_call_function(handler->env_, js_this, onClose, 2, args, &result);
  });
}

void DebugRouterStateListenerHarmony::OnMessage(const std::string &message) {
  auto ui_task_runner =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop_)
          .GetTaskRunner();
  ui_task_runner->PostTask([weak_ptr = weak_from_this(), message]() {
    napi_value js_this;
    auto handler = weak_ptr.lock();
    if (!handler) {
      return;
    }
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);
    napi_value onMessage;
    auto status = napi_get_named_property(handler->env_, js_this, "onMessage",
                                          &onMessage);

    napi_value args[1];
    napi_create_string_utf8(handler->env_, message.c_str(), NAPI_AUTO_LENGTH,
                            &args[0]);

    napi_value result;
    status =
        napi_call_function(handler->env_, js_this, onMessage, 1, args, &result);
  });
}

void DebugRouterStateListenerHarmony::OnError(const std::string &error) {
  auto ui_task_runner =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop_)
          .GetTaskRunner();
  ui_task_runner->PostTask([weak_ptr = weak_from_this(), error]() {
    napi_value js_this;
    auto handler = weak_ptr.lock();
    if (!handler) {
      return;
    }
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);
    napi_value onError;
    auto status =
        napi_get_named_property(handler->env_, js_this, "onError", &onError);

    napi_value args[1];
    napi_create_string_utf8(handler->env_, error.c_str(), NAPI_AUTO_LENGTH,
                            &args[0]);

    napi_value result;
    status =
        napi_call_function(handler->env_, js_this, onError, 1, args, &result);
  });
}

}  // namespace harmony
}  // namespace debugrouter
