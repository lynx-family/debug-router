// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_HARMONY_NATIVE_SLOT_HARMONY_H_
#define DEBUGROUTER_NATIVE_HARMONY_NATIVE_SLOT_HARMONY_H_

#include <node_api.h>
#include <uv.h>

#include "debug_router/native/core/native_slot.h"

namespace debugrouter {
namespace harmony {

class NativeSlotHarmony
    : public debugrouter::core::NativeSlot,
      public std::enable_shared_from_this<NativeSlotHarmony> {
 public:
  NativeSlotHarmony(napi_env env, napi_value js_this, const std::string& url,
                    const std::string& type);

  virtual ~NativeSlotHarmony() override {
    napi_delete_reference(env_, js_this_ref_);
  };

  void OnMessage(const std::string& message, const std::string& type) override;

 private:
  static napi_value Constructor(napi_env env, napi_callback_info info);

  napi_env env_;
  napi_ref js_this_ref_;
  uv_loop_t* loop_;
};

}  // namespace harmony
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_HARMONY_NATIVE_SLOT_HARMONY_H_
