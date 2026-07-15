// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/core/native_slot.h"

#include <string>

namespace debugrouter {
namespace core {

NativeSlot::NativeSlot(const std::string &type, const std::string &url) {
  url_ = url;
  type_ = type;
}

std::string NativeSlot::GetUrl() { return url_; }
std::string NativeSlot::GetType() { return type_; }
std::string NativeSlot::GetSessionDebugRouterId() {
  return session_debug_router_id_;
}
void NativeSlot::SetSessionDebugRouterId(
    const std::string &session_debug_router_id) {
  session_debug_router_id_ = session_debug_router_id;
}

}  // namespace core
}  // namespace debugrouter
