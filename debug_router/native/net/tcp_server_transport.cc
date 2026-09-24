// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/net/tcp_server_transport.h"

#include "debug_router/native/log/logging.h"

namespace debugrouter {
namespace net {

class ConnectionListener
    : public debugrouter::socket_server::TcpServerConnectionListener {
 public:
  ConnectionListener(std::shared_ptr<core::MessageTransceiver> client)
      : client_(client) {}
  virtual ~ConnectionListener() = default;
  // LOGI error_code here.
  void OnInit(int32_t code, const std::string &info) {
    LOGI("OnInit: code :" << code << ", info:" << info);
    if (auto client = client_.lock()) {
      core::MessageTransceiverDelegate *delegate = client->delegate();
      if (delegate == nullptr) {
        LOGE("OnInit: delegate == nullptr");
        return;
      }
      delegate->OnInit(client, code, info);
    }
  }

  void OnStatusChanged(const std::shared_ptr<socket_server::TcpConnection> &,
                       debugrouter::socket_server::ConnectionStatus status,
                       int32_t code, const std::string &info) {
    if (auto client = client_.lock()) {
      core::MessageTransceiverDelegate *delegate = client->delegate();
      if (delegate == nullptr) {
        LOGE(
            "OnStatusChanged: delegate == nullptr, client is already offline.");
        return;
      }
      if (status == debugrouter::socket_server::kConnected) {
        LOGI("OnOpen: code :" << code << ", info:" << info);
        delegate->OnOpen(client);
      } else if (status == debugrouter::socket_server::kDisconnected) {
        LOGI("OnClose: code :" << code << ", info:" << info);
        delegate->OnClosed(client);
      } else if (status == debugrouter::socket_server::kError) {
        LOGI("OnError: code :" << code << ", info:" << info);
        delegate->OnFailure(client, info, code);
      }
    }
  }

  void OnMessage(const std::shared_ptr<socket_server::TcpConnection> &,
                 const std::string &message) {
    if (auto client = client_.lock()) {
      core::MessageTransceiverDelegate *delegate = client->delegate();
      if (delegate == nullptr) {
        LOGE("OnMessage: delegate == nullptr, client is already offline.");
        return;
      }
      delegate->OnMessage(message, client);
    }
  }

 private:
  std::weak_ptr<core::MessageTransceiver> client_;
};

TcpServerTransport::TcpServerTransport() {}

void TcpServerTransport::Init() {
  listener_ = std::make_shared<ConnectionListener>(shared_from_this());
  tcp_server_ = socket_server::TcpServer::CreateTcpServer(listener_);
  tcp_server_->Init();
}

bool TcpServerTransport::Connect(const std::string &url) { return false; }

void TcpServerTransport::Disconnect() { tcp_server_->Disconnect(); }

core::ConnectionType TcpServerTransport::GetType() {
  return core::ConnectionType::kUsb;
}

void TcpServerTransport::Send(const std::string &data) {
  tcp_server_->Send(data);
}

void TcpServerTransport::HandleReceivedMessage(const std::string &message) {
  // empty
}

void TcpServerTransport::StartServer() {
  if (tcp_server_) {
    tcp_server_->StartServer();
  }
}

void TcpServerTransport::StopServer() {
  if (tcp_server_) {
    tcp_server_->StopServer();
  }
}

#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
bool TcpServerTransport::SetStartPort(int32_t start_port) {
  return tcp_server_ && tcp_server_->SetStartPort(start_port);
}
#endif

}  // namespace net
}  // namespace debugrouter
