// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/net/external_fd_transceiver.h"

#include "debug_router/native/log/logging.h"
#include "debug_router/native/socket/usb_client_listener.h"

namespace debugrouter {
namespace net {

class ExternalFdClientListener : public socket_server::UsbClientListener {
 public:
  explicit ExternalFdClientListener(
      std::weak_ptr<ExternalFdTransceiver> transceiver)
      : transceiver_(transceiver) {}

  void OnOpen(std::shared_ptr<socket_server::UsbClient> client, int32_t code,
              const std::string &reason) override {
    if (auto t = transceiver_.lock()) {
      t->OnStatusChanged(socket_server::kConnected, code, reason);
    }
    client->SetConnectStatus(socket_server::USBConnectStatus::CONNECTED);
  }

  void OnClose(std::shared_ptr<socket_server::UsbClient> client, int32_t code,
               const std::string &reason) override {
    if (auto t = transceiver_.lock()) {
      t->OnStatusChanged(socket_server::kDisconnected, code, reason);
    }
    client->SetConnectStatus(socket_server::USBConnectStatus::DISCONNECTED);
  }

  void OnError(std::shared_ptr<socket_server::UsbClient> client, int32_t code,
               const std::string &message) override {
    if (auto t = transceiver_.lock()) {
      t->OnStatusChanged(socket_server::kError, code, message);
    }
    client->SetConnectStatus(socket_server::USBConnectStatus::DISCONNECTED);
  }

  void OnMessage(std::shared_ptr<socket_server::UsbClient> client,
                 const std::string &message) override {
    if (auto t = transceiver_.lock()) {
      t->OnMessage(message);
    }
  }

 private:
  std::weak_ptr<ExternalFdTransceiver> transceiver_;
};

ExternalFdTransceiver::ExternalFdTransceiver() {}

void ExternalFdTransceiver::Init() {}

void ExternalFdTransceiver::AcceptFd(socket_server::SocketType fd) {
  if (fd == socket_server::kInvalidSocket) {
    LOGE("ExternalFdTransceiver::AcceptFd: invalid fd");
    return;
  }
  if (usb_client_) {
    usb_client_->Stop();
    usb_client_ = nullptr;
  }
  LOGI("ExternalFdTransceiver::AcceptFd: fd=" << fd);
  usb_client_ = std::make_shared<socket_server::UsbClient>(fd);
  auto self = std::dynamic_pointer_cast<ExternalFdTransceiver>(
      shared_from_this());
  auto listener = std::make_shared<ExternalFdClientListener>(self);
  usb_client_->Init();
  usb_client_->StartUp(listener);
}

bool ExternalFdTransceiver::Connect(const std::string &url) { return false; }

void ExternalFdTransceiver::Disconnect() {
  if (usb_client_) {
    usb_client_->Stop();
    usb_client_ = nullptr;
  }
}

void ExternalFdTransceiver::Send(const std::string &data) {
  if (usb_client_) {
    usb_client_->Send(data);
  }
}

core::ConnectionType ExternalFdTransceiver::GetType() {
  return core::ConnectionType::kUsb;
}

void ExternalFdTransceiver::HandleReceivedMessage(const std::string &message) {}

void ExternalFdTransceiver::StartServer() {}

void ExternalFdTransceiver::StopServer() {}

void ExternalFdTransceiver::OnInit(int32_t code, const std::string &info) {
  core::MessageTransceiverDelegate *d = delegate();
  if (d) {
    d->OnInit(shared_from_this(), code, info);
  }
}

void ExternalFdTransceiver::OnStatusChanged(
    socket_server::ConnectionStatus status, int32_t code,
    const std::string &info) {
  core::MessageTransceiverDelegate *d = delegate();
  if (!d) return;
  if (status == socket_server::kConnected) {
    d->OnOpen(shared_from_this());
  } else if (status == socket_server::kDisconnected) {
    d->OnClosed(shared_from_this());
  } else if (status == socket_server::kError) {
    d->OnFailure(shared_from_this(), info, code);
  }
}

void ExternalFdTransceiver::OnMessage(const std::string &message) {
  core::MessageTransceiverDelegate *d = delegate();
  if (d) {
    d->OnMessage(message, shared_from_this());
  }
}

}  // namespace net
}  // namespace debugrouter
