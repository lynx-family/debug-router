// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/net/socket_server_client.h"

namespace debugrouter {
namespace net {

SocketServerClient::SocketServerClient(
    const std::shared_ptr<socket_server::SocketServer> &server,
    const std::shared_ptr<socket_server::UsbClient> &client)
    : socket_server_(server), usb_client_(client) {}

bool SocketServerClient::Connect(const std::string &url) { return false; }

void SocketServerClient::Disconnect() {
  auto server = socket_server_.lock();
  auto client = usb_client_.lock();
  if (server && client) {
    server->Disconnect(client);
  }
}

core::ConnectionType SocketServerClient::GetType() {
  return core::ConnectionType::kUsb;
}

void SocketServerClient::Send(const std::string &data) {
  auto server = socket_server_.lock();
  auto client = usb_client_.lock();
  if (server && client) {
    server->Send(client, data);
  }
}

void SocketServerClient::HandleReceivedMessage(const std::string &message) {
  // empty
}

}  // namespace net
}  // namespace debugrouter
