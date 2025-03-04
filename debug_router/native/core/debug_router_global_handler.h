// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_GLOBAL_HANDLER_H_
#define DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_GLOBAL_HANDLER_H_

#include <string>

namespace debugrouter {
namespace core {

class DebugRouterGlobalHandler {
 public:
  virtual void OpenCard(const std::string &url) = 0;
  virtual void OnMessage(const std::string &message,
                         const std::string &type) = 0;
};

}  // namespace core
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_GLOBAL_HANDLER_H_
