// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/win/socket_server_win.h"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <mutex>

#include "debug_router/native/core/util.h"
#include "debug_router/native/log/logging.h"

#pragma comment(lib, "Ws2_32.lib")

namespace debugrouter {
namespace socket_server {

SocketServerWin::SocketServerWin(
    const std::shared_ptr<SocketServerConnectionListener> &listener)
    : SocketServer(listener) {}

int32_t SocketServerWin::InitSocket() {
  LOGI("start new");
  WSADATA wsaData;
  int startup_result = WSAStartup(MAKEWORD(2, 2), &wsaData);
  if (startup_result != 0) {
    LOGE("WSAStartup failed: " << startup_result);
    NotifyInit(GetErrorMessage(), "WSAStartup error");
    return kInvalidPort;
  }

  socket_fd_ = socket(PF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (socket_fd_ == kInvalidSocket) {
    LOGE("create socket error:" << GetErrorMessage());
    NotifyInit(GetErrorMessage(), "create socket error");
    return kInvalidPort;
  }

  bool flag = false;
  PORT_TYPE port = kStartPort;
  int bind_result = SOCKET_ERROR;
  do {
    struct sockaddr_in sockAddr;
    memset(&sockAddr, 0, sizeof(sockAddr));
    sockAddr.sin_family = PF_INET;
    sockAddr.sin_addr.s_addr = inet_addr("127.0.0.1");
    sockAddr.sin_port = htons(port);
    bind_result = bind(socket_fd_, (SOCKADDR *)&sockAddr, sizeof(SOCKADDR));
    if (bind_result == 0) {
      flag = true;
      break;
    }
    port = port + 1;
  } while ((port < kStartPort + kTryPortCount) && bind_result == SOCKET_ERROR &&
           GetErrorMessage() == WSAEADDRINUSE);

  if (!flag) {
    Close();
    LOGE("bind address error:" << GetErrorMessage());
    NotifyInit(GetErrorMessage(), "bind address error");
    return kInvalidPort;
  }

  LOGI("bind port:" << port);

  if (listen(socket_fd_, kConnectionQueueMaxLength) == SOCKET_ERROR) {
    Close();
    LOGE("listen error:" << GetErrorMessage());
    NotifyInit(GetErrorMessage(), "listen error");
    return kInvalidPort;
  }
  return port;
}

void SocketServerWin::Start() {
  int32_t port = kInvalidPort;
  if (socket_fd_ == kInvalidSocket) {
    port = InitSocket();
    if (port == kInvalidPort) {
      return;
    }
  }
  NotifyInit(0, "port:" + std::to_string(port));
  LOGI("server socket:" << socket_fd_);
  SocketType accept_socket_fd = accept(socket_fd_, NULL, NULL);
  if (accept_socket_fd == kInvalidSocket) {
    Close();
    LOGE("accept socket error:" << GetErrorMessage());
    NotifyInit(GetErrorMessage(), "accept socket error");
    return;
  }
  auto temp_usb_client = std::make_shared<UsbClient>(accept_socket_fd);
  std::shared_ptr<ClientListener> listener =
      std::make_shared<ClientListener>(shared_from_this());
  temp_usb_client->Init();
  temp_usb_client->StartUp(listener);
}

void SocketServerWin::CloseSocket(int socket_fd) {
  LOGI("CloseSocket" << socket_fd);
  if (socket_fd == kInvalidSocket) {
    return;
  }
  if (closesocket(socket_fd) != 0) {
    LOGE("close socket error:" << GetErrorMessage());
  }
}

}  // namespace socket_server
}  // namespace debugrouter
