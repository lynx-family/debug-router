// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/posix/socket_server_posix.h"

#include <netinet/in.h>
#include <strings.h>
#include <sys/socket.h>
#include <unistd.h>

#include "debug_router/native/core/util.h"
#include "debug_router/native/log/logging.h"
#include "debug_router/native/socket/usb_client.h"

namespace debugrouter {
namespace socket_server {

SocketServerPosix::SocketServerPosix(
    const std::shared_ptr<SocketServerConnectionListener> &listener)
    : SocketServer(listener) {}

int32_t SocketServerPosix::InitSocket() {
  LOGI("start new");

  socket_fd_ = socket(AF_INET, SOCK_STREAM, 0);
  if (socket_fd_ == kInvalidSocket) {
    LOGE("create socket error:" << GetErrorMessage());
    NotifyInit(GetErrorMessage(), "create socket error");
    return kInvalidPort;
  }

  int on = 1;
  if (setsockopt(socket_fd_, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on)) == -1) {
    Close();
    LOGE("setsockopt error:" << GetErrorMessage());
    NotifyInit(GetErrorMessage(), "setsockopt error");
    return kInvalidPort;
  }

  bool flag = false;
  PORT_TYPE port = kStartPort;
  do {
    struct sockaddr_in addr;
    bzero((char *)&addr, sizeof(addr));

    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);

    if (bind(socket_fd_, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
      flag = true;
      break;
    }
    port = port + 1;
  } while ((port < kStartPort + kTryPortCount) &&
           (GetErrorMessage() == EADDRINUSE));

  if (!flag) {
    Close();
    LOGE("bind address error:" << GetErrorMessage());
    NotifyInit(GetErrorMessage(), "bind address error");
    return kInvalidPort;
  }

  LOGI("bind port:" << port);

  if (listen(socket_fd_, kConnectionQueueMaxLength) != 0) {
    Close();
    LOGE("listen error:" << GetErrorMessage());
    NotifyInit(GetErrorMessage(), "listen error");
    return kInvalidPort;
  }
  return port;
}

void SocketServerPosix::Start() {
  if (socket_fd_ == kInvalidSocket) {
    int32_t port = kInvalidPort;
    port = InitSocket();
    if (port == kInvalidPort) {
      return;
    }
    NotifyInit(0, "port:" + std::to_string(port));
  }
  LOGI("server socket:" << socket_fd_);
  struct sockaddr_in addr;
  socklen_t addrLen = sizeof(addr);
  SocketType accept_socket_fd =
      accept(socket_fd_, (struct sockaddr *)(&addr), &addrLen);
  if (accept_socket_fd == kInvalidSocket) {
    Close();
    LOGE("accept socket error:" << GetErrorMessage());
    NotifyInit(GetErrorMessage(), "accept socket error");
    return;
  }
  LOGI("accept usbclient socket:" << accept_socket_fd);
  if (temp_usb_client_) {
    LOGI("close last connector, destroy temp_usb_client_.");
    temp_usb_client_->Stop();
  }
  LOGI("create a new usb client.");
  temp_usb_client_ = std::make_shared<UsbClient>(accept_socket_fd);
  std::shared_ptr<ClientListener> listener =
      std::make_shared<ClientListener>(shared_from_this());
  temp_usb_client_->Init();
  temp_usb_client_->StartUp(listener);
}

void SocketServerPosix::CloseSocket(int socket_fd) {
  LOGI("CloseSocket" << socket_fd);
  if (socket_fd == kInvalidSocket) {
    return;
  }
  if (close(socket_fd) != 0) {
    LOGE("close socket error:" << GetErrorMessage());
  }
}

}  // namespace socket_server
}  // namespace debugrouter
