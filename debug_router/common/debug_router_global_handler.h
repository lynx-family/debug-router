// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_COMMON_DEBUG_ROUTER_GLOBAL_HANDLER_H_
#define DEBUGROUTER_COMMON_DEBUG_ROUTER_GLOBAL_HANDLER_H_

#include <string>

#include "debug_router/common/debug_router_export.h"

namespace debugrouter {
namespace common {

class DEBUG_ROUTER_EXPORT DebugRouterGlobalHandler {
 public:
  virtual void OpenCard(const std::string &url) = 0;
  virtual void OnMessage(const std::string &message,
                         const std::string &type) = 0;
};

}  // namespace common
}  // namespace debugrouter

#endif  // DEBUGROUTER_COMMON_DEBUG_ROUTER_GLOBAL_HANDLER_H_
