// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/core/debug_router_config.h"

namespace debugrouter {
namespace core {

DebugRouterConfigs& DebugRouterConfigs::GetInstance() {
  static DebugRouterConfigs instance;
  return instance;
}

std::string DebugRouterConfigs::GetConfig(const std::string& key,
                                          std::string default_value) {
  std::lock_guard<std::mutex> lock(mutex_);
  std::string value = configs_[key];
  if (value.empty()) {
    value = default_value;
  }
  return value;
}

void DebugRouterConfigs::SetConfig(const std::string& key,
                                   const std::string& value) {
  std::lock_guard<std::mutex> lock(mutex_);
  configs_[key] = value;
}

}  // namespace core
}  // namespace debugrouter
