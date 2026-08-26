// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/win/socket_server_win.h"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <memory>
#include <mutex>

#include "debug_router/native/core/util.h"
#include "debug_router/native/log/logging.h"

#pragma comment(lib, "Ws2_32.lib")

namespace debugrouter {
namespace socket_server {

SocketServerWin::SocketServerWin(
    const std::shared_ptr<SocketServerConnectionListener> &listener)
    : SocketServer(listener) {}

SocketServerWin::~SocketServerWin() { StopServer(); }

int32_t SocketServerWin::InitSocket() {
  LOGI("SocketServerWin::InitSocket");
  WSADATA wsaData;
  int startup_result = WSAStartup(MAKEWORD(2, 2), &wsaData);
  if (startup_result != 0) {
    LOGE("WSAStartup failed: " << startup_result);
    NotifyInit(GetErrorMessage(), "WSAStartup error");
    return kInvalidPort;
  }

  const SocketType socket_fd = socket(PF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (socket_fd == kInvalidSocket) {
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
    bind_result = bind(socket_fd, (SOCKADDR *)&sockAddr, sizeof(SOCKADDR));
    if (bind_result == 0) {
      flag = true;
      break;
    }
    port = port + 1;
  } while ((port < kStartPort + kTryPortCount) && bind_result == SOCKET_ERROR &&
           GetErrorMessage() == WSAEADDRINUSE);

  if (!flag) {
    CloseSocket(socket_fd);
    LOGE("bind address error:" << GetErrorMessage());
    NotifyInit(GetErrorMessage(), "bind address error");
    return kInvalidPort;
  }

  LOGI("bind port:" << port);

  if (listen(socket_fd, kConnectionQueueMaxLength) == SOCKET_ERROR) {
    CloseSocket(socket_fd);
    LOGE("listen error:" << GetErrorMessage());
    NotifyInit(GetErrorMessage(), "listen error");
    return kInvalidPort;
  }
  if (!TryPublishSocket(socket_fd)) {
    CloseSocket(socket_fd);
    return kInvalidPort;
  }
  return port;
}

void SocketServerWin::Start() {
  SocketType socket_fd = socket_fd_.load(std::memory_order_acquire);
  int32_t port = kInvalidPort;
  if (socket_fd == kInvalidSocket) {
    port = InitSocket();
    if (port == kInvalidPort) {
      return;
    }
    socket_fd = socket_fd_.load(std::memory_order_acquire);
  }
  if (port != kInvalidPort) {
    NotifyInit(0, "port:" + std::to_string(port));
  }
  LOGI("server socket:" << socket_fd);
  SocketType accept_socket_fd = accept(socket_fd, NULL, NULL);
  if (accept_socket_fd == kInvalidSocket) {
    const int error = GetErrorMessage();
    Close();
    LOGE("accept socket error:" << error);
    NotifyInit(error, "accept socket error");
    return;
  }
  std::shared_ptr<UsbClient> old_client;
  auto new_client = std::make_shared<UsbClient>(accept_socket_fd);
  if (!TryInstallPendingClient(new_client, &old_client)) {
    return;
  }
  if (old_client) {
    LOGI("close last connector, destroy temp_usb_client_.");
    ScheduleClientStop(old_client);
  }
  std::shared_ptr<ClientListener> listener =
      std::make_shared<ClientListener>(weak_from_this());
  new_client->Init();
  new_client->StartUp(listener);
#if defined(TESTING)
  WaitForClientListenerReleaseForTest();
#endif
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
