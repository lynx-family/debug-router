// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_COMMON_DEBUG_ROUTER_SLOT_H_
#define DEBUGROUTER_COMMON_DEBUG_ROUTER_SLOT_H_

#include <memory>
#include <string>
#include <unordered_map>

#include "debug_router/common/debug_router_slot_delegate.h"

namespace debugrouter {
namespace common {

class DebugRouterSlotDelegate;

class DebugRouterSlot : public std::enable_shared_from_this<DebugRouterSlot> {
 public:
  DebugRouterSlot();

  int32_t Plug();
  void Pull();
  void SendAsync(const std::string &message);
  void SendDataAsync(const std::string &data, const std::string &type);

  // delegate methods
  std::string GetTemplateUrl() const;
  void OnMessage(const std::string &message, const std::string &type);

  // dispatch specific messages
  void DispatchDocumentUpdated();
  void DispatchFrameNavigated(const std::string &url);
  void DispatchScreencastVisibilityChanged(bool status);
  [[deprecated]] void ClearScreenCastCache();
  void SendScreenCast(const std::string &data,
                      const std::unordered_map<std::string, float> &metadata);

  void SetDelegate(const std::shared_ptr<DebugRouterSlotDelegate> &delegate);
  const std::string &GetType();
  void SetType(const std::string &type);

 private:
  bool plugged_;
  int32_t session_id_;
  std::weak_ptr<DebugRouterSlotDelegate> delegate_;
  std::string type_;
};

}  // namespace common
}  // namespace debugrouter

#endif  // DEBUGROUTER_COMMON_DEBUG_ROUTER_SLOT_H_
