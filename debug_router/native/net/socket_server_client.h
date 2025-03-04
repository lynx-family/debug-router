// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_NET_SOCKET_SERVER_CLIENT_H_
#define DEBUGROUTER_NATIVE_NET_SOCKET_SERVER_CLIENT_H_

#include "debug_router/native/core/message_transceiver.h"
#include "debug_router/native/socket/socket_server_api.h"

namespace debugrouter {
namespace net {
class SocketServerClient : public core::MessageTransceiver {
 public:
  SocketServerClient();
  virtual ~SocketServerClient() = default;
  void Init() override;
  bool Connect(const std::string &url) override;
  void Disconnect() override;
  void Send(const std::string &data) override;
  core::ConnectionType GetType() override;
  void HandleReceivedMessage(const std::string &message) override;

 private:
  std::shared_ptr<debugrouter::socket_server::SocketServer> socket_server_;
  std::shared_ptr<debugrouter::socket_server::SocketServerConnectionListener>
      listener_;
};

}  // namespace net
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_NET_SOCKET_SERVER_CLIENT_H_
