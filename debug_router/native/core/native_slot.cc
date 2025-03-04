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

}  // namespace core
}  // namespace debugrouter
