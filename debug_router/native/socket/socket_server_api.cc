// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/socket_server_type.h"
#ifdef _WIN32
#include "debug_router/native/socket/win/socket_server_win.h"
#else
#include "debug_router/native/socket/posix/socket_server_posix.h"
#endif
#include "debug_router/native/socket/util.h"
#include "debug_router/native/thread/debug_router_executor.h"

namespace debugrouter {
namespace socket_server {

std::shared_ptr<SocketServer> SocketServer::CreateSocketServer(
    const std::shared_ptr<SocketServerConnectionListener> &listener) {
#ifdef _WIN32
  return std::make_shared<SocketServerWin>(listener);
#else
  return std::make_shared<SocketServerPosix>(listener);
#endif
}

SocketServer::SocketServer(
    const std::shared_ptr<SocketServerConnectionListener> &listener)
    : listener_(listener), usb_client_(nullptr) {}

bool SocketServer::Send(const std::string &message) {
  if (!usb_client_) {
    LOGI("SocketServerApi Send: client is null.");
    return false;
  }
  return usb_client_->Send(message);
}

void SocketServer::HandleOnOpenStatus(std::shared_ptr<UsbClient> client,
                                      int32_t code, const std::string &reason) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    std::shared_ptr<UsbClient> old_client_ = usb_client_;
    LOGI("SocketServerApi OnOpen: replace old client.");
    if (old_client_) {
      old_client_->Stop();
    }
    usb_client_ = client;
    if (auto listener = listener_.lock()) {
      listener->OnStatusChanged(kConnected, code, reason);
    }
  });
}

void SocketServer::HandleOnMessageStatus(std::shared_ptr<UsbClient> client,
                                         const std::string &message) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    if (!usb_client_ || usb_client_ != client) {
      LOGI("SocketServerApi OnMessage: client is null or not match.");
      return;
    }
    if (auto listener = listener_.lock()) {
      listener->OnMessage(message);
    }
  });
}

void SocketServer::HandleOnCloseStatus(std::shared_ptr<UsbClient> client,
                                       ConnectionStatus status, int32_t code,
                                       const std::string &reason) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    if (!usb_client_ || usb_client_ != client) {
      LOGI("SocketServerApi OnMessage: client is null or not match.");
      return;
    }
    usb_client_->Stop();
    usb_client_ = nullptr;
    if (auto listener = listener_.lock()) {
      listener->OnStatusChanged(status, code, reason);
    }
  });
}

void SocketServer::HandleOnErrorStatus(std::shared_ptr<UsbClient> client,
                                       ConnectionStatus status, int32_t code,
                                       const std::string &reason) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    if (!usb_client_ || usb_client_ != client) {
      LOGI("SocketServerApi OnMessage: client is null or not match.");
      return;
    }
    usb_client_->Stop();
    usb_client_ = nullptr;
    if (auto listener = listener_.lock()) {
      listener->OnStatusChanged(status, code, reason);
    }
  });
}

void SocketServer::NotifyInit(int32_t code, const std::string &info) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    if (auto listener = listener_.lock()) {
      listener->OnInit(code, info);
    }
  });
}

void SocketServer::ThreadFunc(std::shared_ptr<SocketServer> socket_server) {
  int count = 0;
  while (true) {
    LOGI("Init start:" << count);
    socket_server->Start();
    count++;
  }
}

void SocketServer::Init() {
  std::thread listen_thread(ThreadFunc, shared_from_this());
  listen_thread.detach();
}

// close server socket
void SocketServer::Close() {
  LOGI("SocketServer::Close");
  CloseSocket(socket_fd_);
  socket_fd_ = kInvalidSocket;
}

void SocketServer::Disconnect() {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    if (!usb_client_) {
      usb_client_ = nullptr;
    }
  });
}

SocketServer::~SocketServer() {
  if (!usb_client_) {
    usb_client_->Stop();
  }
  Close();
}

}  // namespace socket_server
}  // namespace debugrouter
