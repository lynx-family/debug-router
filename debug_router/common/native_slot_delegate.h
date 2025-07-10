// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUG_ROUTER_COMMON_NATIVE_SLOT_DELEGATE_H_
#define DEBUG_ROUTER_COMMON_NATIVE_SLOT_DELEGATE_H_

#include "debug_router/common/debug_router_slot.h"
#include "debug_router/native/core/native_slot.h"

namespace debugrouter {
namespace common {

class NativeSlotDelegate : public core::NativeSlot {
 public:
  NativeSlotDelegate(const std::shared_ptr<DebugRouterSlot> &slot)
      : core::NativeSlot(slot->GetType(), slot->GetTemplateUrl()) {
    slot_ = slot;
  }
  ~NativeSlotDelegate() override { slot_ = nullptr; }

  std::string GetUrl() { return slot_->GetTemplateUrl(); }

  std::string GetType() { return slot_->GetType(); }

  void OnMessage(const std::string &message, const std::string &type) override {
    slot_->OnMessage(message, type);
  }

 private:
  std::shared_ptr<DebugRouterSlot> slot_;
};

}  // namespace common
}  // namespace debugrouter

#endif  // DEBUG_ROUTER_COMMON_NATIVE_SLOT_DELEGATE_H_
