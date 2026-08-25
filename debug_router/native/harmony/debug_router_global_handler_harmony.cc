// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/harmony/debug_router_global_handler_harmony.h"

#include "debug_router/native/harmony/base/fml/message_loop.h"
#include "debug_router/native/harmony/base/napi_util.h"

namespace debugrouter {
namespace harmony {

DebugRouterGlobalHandlerHarmony::DebugRouterGlobalHandlerHarmony(
    napi_env env, napi_value js_this)
    : env_(env), js_this_ref_(nullptr) {
  napi_create_reference(env, js_this, 1, &js_this_ref_);
  uv_loop_t* loop = nullptr;
  napi_get_uv_event_loop(env, &loop);
  js_task_runner_ =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop).GetTaskRunner();
}

DebugRouterGlobalHandlerHarmony::~DebugRouterGlobalHandlerHarmony() {
  napi_env env = env_;
  napi_ref reference = js_this_ref_;
  js_this_ref_ = nullptr;
  fml::TaskRunner::RunNowOrPostTask(js_task_runner_, [env, reference]() {
    if (reference != nullptr) {
      napi_delete_reference(env, reference);
    }
  });
}

bool DebugRouterGlobalHandlerHarmony::IsSame(napi_env env,
                                             napi_value value) const {
  if (env != env_) {
    return false;
  }
  napi_value object;
  bool equal = false;
  return napi_get_reference_value(env_, js_this_ref_, &object) == napi_ok &&
         napi_strict_equals(env_, object, value, &equal) == napi_ok && equal;
}

void DebugRouterGlobalHandlerHarmony::OpenCard(const std::string& url) {
  if (!active_.load()) {
    return;
  }
  js_task_runner_->PostTask([handler = shared_from_this(), url]() {
    if (!handler->active_.load()) {
      return;
    }
    napi_value js_this;
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);
    napi_value openCard;
    auto status = napi_get_named_property(handler->env_, js_this, "onOpenCard",
                                          &openCard);

    napi_value args[1];
    napi_create_string_utf8(handler->env_, url.c_str(), NAPI_AUTO_LENGTH,
                            &args[0]);

    napi_value result;
    status =
        napi_call_function(handler->env_, js_this, openCard, 1, args, &result);
  });
}

void DebugRouterGlobalHandlerHarmony::OnMessage(const std::string& message,
                                                const std::string& type) {
  if (!active_.load()) {
    return;
  }
  js_task_runner_->PostTask([handler = shared_from_this(), message, type]() {
    if (!handler->active_.load()) {
      return;
    }
    napi_value js_this;
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);

    napi_value onMessage;
    napi_get_named_property(handler->env_, js_this, "onMessage", &onMessage);

    napi_value args[2];
    napi_create_string_utf8(handler->env_, message.c_str(), NAPI_AUTO_LENGTH,
                            &args[0]);
    napi_create_string_utf8(handler->env_, type.c_str(), NAPI_AUTO_LENGTH,
                            &args[1]);

    napi_value result;
    napi_call_function(handler->env_, js_this, onMessage, 2, args, &result);
  });
}

}  // namespace harmony
}  // namespace debugrouter
