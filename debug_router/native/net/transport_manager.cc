// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/net/transport_manager.h"

#if ENABLE_MESSAGE_IMPL

#include "debug_router/native/log/logging.h"
#include "debug_router/native/net/socket_server_client.h"

namespace debugrouter {
namespace net {
namespace {

class UsbConnectionListener final
    : public socket_server::SocketServerConnectionListener {
 public:
  explicit UsbConnectionListener(core::MessageTransceiverDelegate *delegate)
      : delegate_(delegate) {}

  void SetServer(const std::shared_ptr<socket_server::SocketServer> &server) {
    server_ = server;
  }

  void OnInit(int32_t code, const std::string &info) override {
    LOGI("OnInit: code :" << code << ", info:" << info);
  }

  void OnStatusChanged(const std::shared_ptr<socket_server::UsbClient> &client,
                       socket_server::ConnectionStatus status, int32_t code,
                       const std::string &info) override {
    if (status == socket_server::kConnected) {
      auto server = server_.lock();
      if (server && client) {
        LOGI("OnOpen: code :" << code << ", info:" << info);
        auto connection = std::make_shared<SocketServerClient>(server, client);
        connection->SetDelegate(delegate_);
        client->SetTransceiver(connection);
        delegate_->OnOpen(connection);
      }
    } else {
      auto connection = client->GetTransceiver();
      if (!connection) {
        return;
      }
      if (status == socket_server::kDisconnected) {
        LOGI("OnClose: code :" << code << ", info:" << info);
        delegate_->OnClosed(connection);
      } else if (status == socket_server::kError) {
        LOGI("OnError: code :" << code << ", info:" << info);
        delegate_->OnFailure(connection, info, code);
      }
    }
  }

  void OnMessage(const std::shared_ptr<socket_server::UsbClient> &client,
                 const std::string &message) override {
    if (auto connection = client->GetTransceiver()) {
      delegate_->OnMessage(message, connection);
    }
  }

 private:
  core::MessageTransceiverDelegate *delegate_;
  std::weak_ptr<socket_server::SocketServer> server_;
};

}  // namespace

void TransportManager::Init(core::MessageTransceiverDelegate *delegate) {
  auto listener = std::make_shared<UsbConnectionListener>(delegate);
  listener_ = listener;
  socket_server_ = socket_server::SocketServer::CreateSocketServer(listener);
  listener->SetServer(socket_server_);
  socket_server_->Init();
}

}  // namespace net
}  // namespace debugrouter

#endif  // ENABLE_MESSAGE_IMPL
