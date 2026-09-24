// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_POSIX_TCP_SERVER_POSIX_H
#define DEBUGROUTER_NATIVE_SOCKET_POSIX_TCP_SERVER_POSIX_H

#include "debug_router/native/socket/tcp_server.h"

namespace debugrouter {
namespace socket_server {

class TcpServerPosix : public TcpServer {
 public:
  explicit TcpServerPosix(
      const std::shared_ptr<TcpServerConnectionListener> &listener);
  ~TcpServerPosix() override;

 private:
#if defined(TESTING)
  friend class TcpServerPosixTestPeer;
#endif

  inline int GetErrorMessage() override { return errno; }
  int32_t InitSocket();
  void Start() override;
  void CloseSocket(int socket_fd) override;
};

}  // namespace socket_server
};  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_POSIX_TCP_SERVER_POSIX_H
