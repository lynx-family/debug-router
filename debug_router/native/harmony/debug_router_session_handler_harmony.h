// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_SESSION_HANDLER_HARMONY_H_
#define DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_SESSION_HANDLER_HARMONY_H_

#include <node_api.h>
#include <uv.h>

#include "debug_router/native/core/debug_router_session_handler.h"

namespace debugrouter {
namespace harmony {

class DebugRouterSessionHandlerHarmony
    : public debugrouter::core::DebugRouterSessionHandler,
      public std::enable_shared_from_this<DebugRouterSessionHandlerHarmony> {
 public:
  DebugRouterSessionHandlerHarmony(napi_env env, napi_value js_object);
  virtual ~DebugRouterSessionHandlerHarmony() {
    napi_delete_reference(env_, js_this_ref_);
  };

  void OnSessionCreate(int session_id, const std::string &url) override;
  void OnSessionDestroy(int session_id) override;
  void OnMessage(const std::string &message, const std::string &type,
                 int session_id) override;

 private:
  static napi_value Constructor(napi_env env, napi_callback_info info);

  napi_env env_;
  napi_ref js_this_ref_;
  uv_loop_t *loop_;
};

}  // namespace harmony
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_SESSION_HANDLER_HARMONY_H_
