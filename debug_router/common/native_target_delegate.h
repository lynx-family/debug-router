// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUG_ROUTER_COMMON_NATIVE_TARGET_DELEGATE_H_
#define DEBUG_ROUTER_COMMON_NATIVE_TARGET_DELEGATE_H_

#include "debug_router/common/debug_router_slot.h"
#include "debug_router/native/core/native_target.h"

namespace debugrouter {
namespace common {

class NativeTargetDelegate : public core::NativeTarget {
 public:
  NativeTargetDelegate(const std::shared_ptr<DebugRouterSlot> &target)
      : core::NativeTarget(target->GetType(), target->GetTemplateUrl()) {
    target_ = target;
  }
  ~NativeTargetDelegate() override { target_ = nullptr; }

  std::string GetUrl() { return target_->GetTemplateUrl(); }

  std::string GetType() { return target_->GetType(); }

  void OnMessage(const std::string &message, const std::string &type) override {
    target_->OnMessage(message, type);
  }

 private:
  std::shared_ptr<DebugRouterSlot> target_;
};

}  // namespace common
}  // namespace debugrouter

#endif  // DEBUG_ROUTER_COMMON_NATIVE_TARGET_DELEGATE_H_
