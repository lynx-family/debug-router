// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_CONFIG_H_
#define DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_CONFIG_H_

#include <mutex>
#include <string>
#include <unordered_map>

namespace debugrouter {
namespace core {

static const std::string kForbidReconnectWhenClose =
    "debugrouter_forbid_reconnect_on_close";

/**
 * Store configs of DebugRouter
 */
class DebugRouterConfigs {
 public:
  static DebugRouterConfigs& GetInstance();
  DebugRouterConfigs(const DebugRouterConfigs&) = delete;
  DebugRouterConfigs& operator=(const DebugRouterConfigs&) = delete;
  std::string GetConfig(const std::string& key, std::string default_value = "");
  void SetConfig(const std::string& key, const std::string& value);

 private:
  DebugRouterConfigs() = default;
  std::unordered_map<std::string, std::string> configs_;
  std::mutex mutex_;
};

}  // namespace core
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_CONFIG_H_
