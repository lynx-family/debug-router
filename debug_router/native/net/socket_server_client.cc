// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/net/socket_server_client.h"

#include "debug_router/native/log/logging.h"

namespace debugrouter {
namespace net {

class ConnectionListener
    : public debugrouter::socket_server::SocketServerConnectionListener {
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

  void OnStatusChanged(debugrouter::socket_server::ConnectionStatus status,
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
        delegate->OnFailure(client);
      }
    }
  }

  void OnMessage(const std::string &message) {
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

SocketServerClient::SocketServerClient() {}

void SocketServerClient::Init() {
  listener_ = std::make_shared<ConnectionListener>(shared_from_this());
  socket_server_ = socket_server::SocketServer::CreateSocketServer(listener_);
  socket_server_->Init();
}

bool SocketServerClient::Connect(const std::string &url) { return false; }

void SocketServerClient::Disconnect() { socket_server_->Disconnect(); }

core::ConnectionType SocketServerClient::GetType() {
  return core::ConnectionType::kUsb;
}

void SocketServerClient::Send(const std::string &data) {
  socket_server_->Send(data);
}

void SocketServerClient::HandleReceivedMessage(const std::string &message) {
  // empty
}

}  // namespace net
}  // namespace debugrouter
