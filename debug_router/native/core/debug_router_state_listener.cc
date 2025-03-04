// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/core/debug_router_state_listener.h"

namespace debugrouter {
namespace core {

std::unordered_map<ConnectionType, std::string> ConnectionTypes{
    {ConnectionType::kWebSocket, "websocket"},
    {ConnectionType::kUsb, "usb"},
};

}  // namespace core
}  // namespace debugrouter
