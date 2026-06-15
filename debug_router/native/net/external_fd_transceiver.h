// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_NET_EXTERNAL_FD_TRANSCEIVER_H_
#define DEBUGROUTER_NATIVE_NET_EXTERNAL_FD_TRANSCEIVER_H_

#include "debug_router/native/core/message_transceiver.h"
#include "debug_router/native/socket/socket_server_api.h"
#include "debug_router/native/socket/usb_client.h"

namespace debugrouter {
namespace net {

class ExternalFdTransceiver
    : public core::MessageTransceiver,
      public socket_server::SocketServerConnectionListener {
 public:
  ExternalFdTransceiver();
  ~ExternalFdTransceiver() = default;

  void AcceptFd(socket_server::SocketType fd);

  void Init() override;
  bool Connect(const std::string &url) override;
  void Disconnect() override;
  void Send(const std::string &data) override;
  core::ConnectionType GetType() override;
  void HandleReceivedMessage(const std::string &message) override;
  void StartServer() override;
  void StopServer() override;

  void OnInit(int32_t code, const std::string &info) override;
  void OnStatusChanged(socket_server::ConnectionStatus status, int32_t code,
                       const std::string &info) override;
  void OnMessage(const std::string &message) override;

 private:
  std::shared_ptr<socket_server::UsbClient> usb_client_;
};

}  // namespace net
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_NET_EXTERNAL_FD_TRANSCEIVER_H_
