// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_WIN_SOCKET_SERVER_WIN
#define DEBUGROUTER_NATIVE_SOCKET_WIN_SOCKET_SERVER_WIN

#include "debug_router/native/socket/socket_server_api.h"

namespace debugrouter {
namespace socket_server {

class SocketServerWin : public SocketServer {
 public:
  SocketServerWin(
      const std::shared_ptr<SocketServerConnectionListener> &listener);
  ~SocketServerWin() override;

 private:
  inline int GetErrorMessage() override { return WSAGetLastError(); }

  int32_t InitSocket() override;
  void Start(SocketType socket_fd) override;
  void CloseSocket(SocketType socket_fd) override;
};

}  // namespace socket_server
};  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_WIN_SOCKET_SERVER_WIN
