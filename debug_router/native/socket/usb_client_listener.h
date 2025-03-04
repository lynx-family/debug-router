// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_USB_CLIENT_LISTENER_H_
#define DEBUGROUTER_NATIVE_SOCKET_USB_CLIENT_LISTENER_H_

#include "debug_router/native/socket/usb_client.h"

namespace debugrouter {
namespace socket_server {
class UsbClient;

// listener of usb_client
class UsbClientListener {
 public:
  virtual void OnOpen(std::shared_ptr<UsbClient> client, int32_t code,
                      const std::string& reason) = 0;
  virtual void OnClose(std::shared_ptr<UsbClient> client, int32_t code,
                       const std::string& reason) = 0;
  virtual void OnError(std::shared_ptr<UsbClient> client, int32_t code,
                       const std::string& message) = 0;
  virtual void OnMessage(std::shared_ptr<UsbClient> client,
                         const std::string& message) = 0;
};

}  // namespace socket_server
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_USB_CLIENT_LISTENER_H_
