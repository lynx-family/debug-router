// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_MESSAGE_HANDLER_HARMONY_H_
#define DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_MESSAGE_HANDLER_HARMONY_H_

#include <node_api.h>
#include <uv.h>

#include <atomic>
#include <string>

#include "debug_router/native/core/debug_router_message_handler.h"
#include "debug_router/native/harmony/base/fml/task_runner.h"

namespace debugrouter {
namespace harmony {

class DebugRouterMessageHandlerHarmony
    : public debugrouter::core::DebugRouterMessageHandler,
      public std::enable_shared_from_this<DebugRouterMessageHandlerHarmony> {
 public:
  DebugRouterMessageHandlerHarmony(napi_env env, napi_value js_object,
                                   std::string handler_name);
  virtual ~DebugRouterMessageHandlerHarmony();

  std::string Handle(std::string params) override;
  std::string GetName() const override;
  bool IsSame(napi_env env, napi_value value) const;
  void Deactivate() { active_.store(false); }

 private:
  static napi_value Constructor(napi_env env, napi_callback_info info);
  std::string InvokeHandleMethodOnCurrentThread(const std::string& params);

  napi_env env_;
  napi_ref js_this_ref_;
  fml::RefPtr<fml::TaskRunner> js_task_runner_;
  std::string handler_name_;
  std::atomic_bool active_{true};
};

}  // namespace harmony
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_MESSAGE_HANDLER_HARMONY_H_
