// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/harmony/debug_router_message_handler_harmony.h"

#include "debug_router/native/harmony/base/fml/message_loop.h"
#include "debug_router/native/harmony/base/napi_util.h"

namespace debugrouter {
namespace harmony {

DebugRouterMessageHandlerHarmony::DebugRouterMessageHandlerHarmony(
    napi_env env, napi_value js_this)
    : env_(env), js_this_ref_(nullptr) {
  napi_create_reference(env, js_this, 1, &js_this_ref_);
  napi_get_uv_event_loop(env, &loop_);
}

std::string DebugRouterMessageHandlerHarmony::Handle(std::string params) {
  auto ui_task_runner =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop_)
          .GetTaskRunner();
  std::string ret;
  ui_task_runner->PostTask([weak_ptr = weak_from_this(), &ret, params]() {
    napi_value js_this;
    auto handler = weak_ptr.lock();
    if (!handler) {
      return;
    }
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);
    napi_value handle;
    auto status =
        napi_get_named_property(handler->env_, js_this, "handle", &handle);

    napi_value args[1];
    napi_create_string_utf8(handler->env_, params.c_str(), NAPI_AUTO_LENGTH,
                            &args[0]);

    napi_value result;
    status =
        napi_call_function(handler->env_, js_this, handle, 1, args, &result);

    size_t strSize;
    status =
        napi_get_value_string_utf8(handler->env_, result, nullptr, 0, &strSize);
    char* buffer = new char[strSize + 1];
    status = napi_get_value_string_utf8(handler->env_, result, buffer,
                                        strSize + 1, &strSize);
    std::string str(buffer);
    delete[] buffer;
    ret = std::move(str);
  });
  return ret;
}

std::string DebugRouterMessageHandlerHarmony::GetName() const {
  auto ui_task_runner =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop_)
          .GetTaskRunner();
  std::string ret;
  ui_task_runner->PostTask([weak_ptr = weak_from_this(), &ret]() {
    napi_value js_this;
    auto handler = weak_ptr.lock();
    if (!handler) {
      return;
    }
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);
    napi_value getName;
    auto status =
        napi_get_named_property(handler->env_, js_this, "getName", &getName);

    napi_value result;
    status = napi_call_function(handler->env_, js_this, getName, 0, nullptr,
                                &result);

    size_t strSize;
    status =
        napi_get_value_string_utf8(handler->env_, result, nullptr, 0, &strSize);
    char* buffer = new char[strSize + 1];
    status = napi_get_value_string_utf8(handler->env_, result, buffer,
                                        strSize + 1, &strSize);
    std::string str(buffer);
    delete[] buffer;
    ret = str;
  });
  return ret;
}

}  // namespace harmony
}  // namespace debugrouter
