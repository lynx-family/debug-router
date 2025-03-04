// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_POSIX_SOCKET_SERVER_POSIX_H
#define DEBUGROUTER_NATIVE_SOCKET_POSIX_SOCKET_SERVER_POSIX_H

#include "debug_router/native/socket/socket_server_api.h"

namespace debugrouter {
namespace socket_server {

class SocketServerPosix : public SocketServer {
 public:
  explicit SocketServerPosix(
      const std::shared_ptr<SocketServerConnectionListener> &listener);

 private:
  inline int GetErrorMessage() override { return errno; }
  int32_t InitSocket();
  void Start() override;
  void CloseSocket(int socket_fd) override;
};

}  // namespace socket_server
};  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_POSIX_SOCKET_SERVER_POSIX_H
