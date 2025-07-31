// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/harmony/native_slot_harmony.h"

#include "debug_router/native/harmony/base/fml/message_loop.h"
#include "debug_router/native/harmony/base/napi_util.h"

namespace debugrouter {
namespace harmony {

NativeSlotHarmony::NativeSlotHarmony(napi_env env, napi_value js_this,
                                     const std::string& url,
                                     const std::string& type)
    : NativeSlot(type, url), env_(env), js_this_ref_(nullptr) {
  napi_create_reference(env, js_this, 1, &js_this_ref_);
  napi_get_uv_event_loop(env, &loop_);
}

void NativeSlotHarmony::OnMessage(const std::string& message,
                                  const std::string& type) {
  auto ui_task_runner =
      fml::MessageLoop::EnsureInitializedForCurrentThread(loop_)
          .GetTaskRunner();
  ui_task_runner->PostTask([weak_ptr = weak_from_this(), message, type]() {
    napi_value js_this;
    auto handler = weak_ptr.lock();
    if (!handler) {
      return;
    }
    napi_get_reference_value(handler->env_, handler->js_this_ref_, &js_this);
    napi_value onMessage;
    auto status = napi_get_named_property(handler->env_, js_this, "onMessage",
                                          &onMessage);

    napi_value args[2];
    napi_create_string_utf8(handler->env_, message.c_str(), NAPI_AUTO_LENGTH,
                            &args[0]);
    napi_create_string_utf8(handler->env_, type.c_str(), NAPI_AUTO_LENGTH,
                            &args[1]);

    napi_value result;
    status =
        napi_call_function(handler->env_, js_this, onMessage, 2, args, &result);
  });
}

}  // namespace harmony
}  // namespace debugrouter
