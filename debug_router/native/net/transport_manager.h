// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_NET_TRANSPORT_MANAGER_H_
#define DEBUGROUTER_NATIVE_NET_TRANSPORT_MANAGER_H_

#include <memory>

#include "debug_router/native/core/message_transceiver.h"
#include "debug_router/native/socket/socket_server_api.h"

namespace debugrouter {
namespace net {

#if ENABLE_MESSAGE_IMPL
class TransportManager {
 public:
  void Init(core::MessageTransceiverDelegate *delegate);

  void StartServer() { socket_server_->StartServer(); }
  void StopServer(
      // intermediate state, need to be deleted after connection is refactored
      bool invalidate_listening_port = false) {
    socket_server_->StopServer(invalidate_listening_port);
  }

  int32_t GetListeningPort() const {
    return socket_server_ ? socket_server_->GetListeningPort()
                          : socket_server::kInvalidPort;
  }

#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
  bool SetStartPort(int32_t start_port) {
    return socket_server_ && socket_server_->SetStartPort(start_port);
  }

  // intermediate state, need to be deleted after connection is refactored
  void RestartServerWithStartPort(int32_t start_port, bool should_run) {
    StopServer(/*invalidate_listening_port=*/true);
    SetStartPort(start_port);
    if (should_run) {
      StartServer();
    }
  }
#endif

 private:
  std::shared_ptr<socket_server::SocketServerConnectionListener> listener_;
  std::shared_ptr<socket_server::SocketServer> socket_server_;
};
#else
class TransportManager {
 public:
  void Init(core::MessageTransceiverDelegate *) {}

  void StartServer() {}
  void StopServer(
      // intermediate state, need to be deleted after connection is refactored
      bool = false) {}

  int32_t GetListeningPort() const { return socket_server::kInvalidPort; }

#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
  bool SetStartPort(int32_t) { return false; }

  // intermediate state, need to be deleted after connection is refactored
  void RestartServerWithStartPort(int32_t, bool) {}
#endif
};
#endif

}  // namespace net
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_NET_TRANSPORT_MANAGER_H_
