// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_NET_TCP_SERVER_TRANSPORT_H_
#define DEBUGROUTER_NATIVE_NET_TCP_SERVER_TRANSPORT_H_

#include "debug_router/native/core/message_transceiver.h"
#include "debug_router/native/socket/tcp_server.h"

namespace debugrouter {
namespace net {
class TcpServerTransport : public core::MessageTransceiver {
 public:
  TcpServerTransport();
  virtual ~TcpServerTransport() = default;
  void Init() override;
  bool Connect(const std::string &url) override;
  void Disconnect() override;
  void Send(const std::string &data) override;
  core::ConnectionType GetType() override;
  void HandleReceivedMessage(const std::string &message) override;

  void StartServer() override;
  void StopServer() override;
#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
  bool SetStartPort(int32_t start_port);
#endif

 private:
  std::shared_ptr<debugrouter::socket_server::TcpServer> tcp_server_;
  std::shared_ptr<debugrouter::socket_server::TcpServerConnectionListener>
      listener_;
};

}  // namespace net
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_NET_TCP_SERVER_TRANSPORT_H_
