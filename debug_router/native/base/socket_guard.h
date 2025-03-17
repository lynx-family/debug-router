// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_BASE_SOCKET_UTIL_H_
#define DEBUGROUTER_NATIVE_BASE_SOCKET_UTIL_H_

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#define CLOSESOCKET closesocket
#else
#include <netdb.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#define SOCKET int
#define CLOSESOCKET close
#endif

constexpr SOCKET kInvalidSocket = 0;

namespace debugrouter {
namespace base {

class SocketGuard {
 public:
  SOCKET Get() const { return sock_; }

  explicit SocketGuard(SOCKET sock) : sock_(sock) {}

  ~SocketGuard() {
    if (sock_ != 0) {
      CLOSESOCKET(sock_);
    }
  }
  SocketGuard(const SocketGuard&) = delete;
  SocketGuard& operator=(const SocketGuard&) = delete;

 private:
  SOCKET sock_;
};

}  // namespace base
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_BASE_SOCKET_UTIL_H_
