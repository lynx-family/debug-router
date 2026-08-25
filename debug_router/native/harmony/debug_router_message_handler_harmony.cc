// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/harmony/debug_router_message_handler_harmony.h"

#include <utility>

#include "debug_router/native/harmony/base/fml/message_loop.h"
#include "debug_router/native/harmony/base/fml/synchronization/waitable_event.h"
#include "debug_router/native/harmony/base/fml/time/time_delta.h"
#include "debug_router/native/harmony/base/napi_util.h"
#include "debug_router/native/log/logging.h"

namespace debugrouter {
namespace harmony {

DebugRouterMessageHandlerHarmony::DebugRouterMessageHandlerHarmony(
    napi_env env, napi_value js_this, std::string handler_name)
    : env_(env), js_this_ref_(nullptr), handler_name_(std::move(handler_name)) {
  napi_create_reference(env, js_this, 1, &js_this_ref_);
  uv_loop_t* loop = nullptr;
  napi_get_uv_event_loop(env, &loop);
  js_task_runner_ =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop).GetTaskRunner();
}

DebugRouterMessageHandlerHarmony::~DebugRouterMessageHandlerHarmony() {
  napi_env env = env_;
  napi_ref reference = js_this_ref_;
  js_this_ref_ = nullptr;
  fml::TaskRunner::RunNowOrPostTask(js_task_runner_, [env, reference]() {
    if (reference != nullptr) {
      napi_delete_reference(env, reference);
    }
  });
}

bool DebugRouterMessageHandlerHarmony::IsSame(napi_env env,
                                              napi_value value) const {
  if (env != env_) {
    return false;
  }
  napi_value object;
  bool equal = false;
  return napi_get_reference_value(env_, js_this_ref_, &object) == napi_ok &&
         napi_strict_equals(env_, object, value, &equal) == napi_ok && equal;
}

std::string DebugRouterMessageHandlerHarmony::Handle(std::string params) {
  if (!active_.load()) {
    return "";
  }
  if (js_task_runner_ == nullptr) {
    LOGE("DebugRouterMessageHandlerHarmony missing task runner: handle");
    return "";
  }

  if (js_task_runner_->RunsTasksOnCurrentThread()) {
    return InvokeHandleMethodOnCurrentThread(params);
  }

  struct InvokeResult {
    enum class State { kPending, kRunning, kCanceled, kCompleted };

    fml::AutoResetWaitableEvent event;
    std::string value;
    std::atomic<State> state{State::kPending};
  };
  auto invoke_result = std::make_shared<InvokeResult>();
  js_task_runner_->PostTask([handler = shared_from_this(), invoke_result,
                             params]() {
    InvokeResult::State expected = InvokeResult::State::kPending;
    if (!invoke_result->state.compare_exchange_strong(
            expected, InvokeResult::State::kRunning,
            std::memory_order_acq_rel)) {
      return;
    }
    if (!handler->active_.load()) {
      invoke_result->state.store(InvokeResult::State::kCompleted,
                                 std::memory_order_release);
      invoke_result->event.Signal();
      return;
    }
    invoke_result->value = handler->InvokeHandleMethodOnCurrentThread(params);
    invoke_result->state.store(InvokeResult::State::kCompleted,
                               std::memory_order_release);
    invoke_result->event.Signal();
  });
  if (invoke_result->event.WaitWithTimeout(fml::TimeDelta::FromSeconds(5))) {
    InvokeResult::State expected = InvokeResult::State::kPending;
    invoke_result->state.compare_exchange_strong(
        expected, InvokeResult::State::kCanceled, std::memory_order_acq_rel);
    LOGE("DebugRouterMessageHandlerHarmony invoke timeout: handle");
    return "";
  }
  return invoke_result->value;
}

std::string DebugRouterMessageHandlerHarmony::GetName() const {
  return handler_name_;
}

std::string DebugRouterMessageHandlerHarmony::InvokeHandleMethodOnCurrentThread(
    const std::string& params) {
  base::NapiHandleScope scope(env_);
  napi_value js_this = nullptr;
  napi_value handle = nullptr;
  napi_value args[1];
  napi_value result = nullptr;
  napi_status status = napi_get_reference_value(env_, js_this_ref_, &js_this);
  if (status == napi_ok) {
    status = napi_get_named_property(env_, js_this, "handle", &handle);
  }
  if (status == napi_ok) {
    status = napi_create_string_utf8(env_, params.c_str(), NAPI_AUTO_LENGTH,
                                     &args[0]);
  }
  if (status == napi_ok) {
    status = napi_call_function(env_, js_this, handle, 1, args, &result);
  }
  if (status != napi_ok || result == nullptr) {
    LOGE("DebugRouterMessageHandlerHarmony invoke failed: handle");
    return "";
  }
  return base::NapiUtil::ConvertToString(env_, result);
}

}  // namespace harmony
}  // namespace debugrouter
