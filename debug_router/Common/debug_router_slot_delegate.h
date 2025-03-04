// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_COMMON_DEBUG_ROUTER_SLOT_DELEGATE_H_
#define DEBUGROUTER_COMMON_DEBUG_ROUTER_SLOT_DELEGATE_H_

#include <string>

namespace debugrouter {
namespace common {

class DebugRouterSlotDelegate {
 public:
  virtual std::string GetTemplateUrl() = 0;
  virtual void OnMessage(const std::string &message,
                         const std::string &type) = 0;
};

}  // namespace common
}  // namespace debugrouter

#endif  // DEBUGROUTER_COMMON_DEBUG_ROUTER_SLOT_DELEGATE_H_
