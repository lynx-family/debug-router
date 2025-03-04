// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_STATE_LISTENER_H_
#define DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_STATE_LISTENER_H_

#include <string>
#include <unordered_map>

namespace debugrouter {
namespace core {

enum class ConnectionType {
  kWebSocket,
  kUsb,
};

extern std::unordered_map<ConnectionType, std::string> ConnectionTypes;

class DebugRouterStateListener {
 public:
  virtual void OnOpen(ConnectionType type) = 0;
  virtual void OnClose(int32_t code, const std::string &reason) = 0;
  virtual void OnMessage(const std::string &message) = 0;
  virtual void OnError(const std::string &error) = 0;
};

}  // namespace core
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_STATE_LISTENER_H_
