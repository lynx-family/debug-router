// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_HARMONY_NATIVE_TARGET_HARMONY_H_
#define DEBUGROUTER_NATIVE_HARMONY_NATIVE_TARGET_HARMONY_H_

#include <node_api.h>
#include <uv.h>

#include "debug_router/native/core/native_target.h"
#include "debug_router/native/harmony/base/fml/task_runner.h"

namespace debugrouter {
namespace harmony {

class NativeTargetHarmony
    : public debugrouter::core::NativeTarget,
      public std::enable_shared_from_this<NativeTargetHarmony> {
 public:
  NativeTargetHarmony(napi_env env, napi_value js_this, const std::string& url,
                      const std::string& type);

  virtual ~NativeTargetHarmony() override;

  void OnMessage(const std::string& message, const std::string& type) override;

 private:
  static napi_value Constructor(napi_env env, napi_callback_info info);

  napi_env env_;
  napi_ref js_this_ref_;
  fml::RefPtr<fml::TaskRunner> js_task_runner_;
};

}  // namespace harmony
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_HARMONY_NATIVE_TARGET_HARMONY_H_
