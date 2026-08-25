// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_GLOBAL_HANDLER_HARMONY_H_
#define DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_GLOBAL_HANDLER_HARMONY_H_

#include <node_api.h>
#include <uv.h>

#include <atomic>

#include "debug_router/native/core/debug_router_global_handler.h"
#include "debug_router/native/harmony/base/fml/task_runner.h"

namespace debugrouter {
namespace harmony {

class DebugRouterGlobalHandlerHarmony
    : public debugrouter::core::DebugRouterGlobalHandler,
      public std::enable_shared_from_this<DebugRouterGlobalHandlerHarmony> {
 public:
  DebugRouterGlobalHandlerHarmony(napi_env env, napi_value js_object);
  virtual ~DebugRouterGlobalHandlerHarmony();

  void OpenCard(const std::string& url) override;
  void OnMessage(const std::string& message, const std::string& type) override;
  bool IsSame(napi_env env, napi_value value) const;
  void Deactivate() { active_.store(false); }

 private:
  static napi_value Constructor(napi_env env, napi_callback_info info);

  napi_env env_;
  napi_ref js_this_ref_;
  fml::RefPtr<fml::TaskRunner> js_task_runner_;
  std::atomic_bool active_{true};
};

}  // namespace harmony
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_GLOBAL_HANDLER_HARMONY_H_
