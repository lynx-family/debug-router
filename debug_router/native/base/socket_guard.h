// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_BASE_SOCKET_UTIL_H_
#define DEBUGROUTER_NATIVE_BASE_SOCKET_UTIL_H_

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#define CLOSESOCKET closesocket
typedef SOCKET SocketType;
constexpr SocketType kInvalidSocket = INVALID_SOCKET;
#else
#include <netdb.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#define CLOSESOCKET close
typedef int SocketType;
constexpr SocketType kInvalidSocket = -1;
#endif

namespace debugrouter {
namespace base {

class SocketGuard {
 public:
  SocketType Get() const { return sock_; }

  void Reset() {
    if (sock_ != kInvalidSocket) {
      CLOSESOCKET(sock_);
    }
    sock_ = kInvalidSocket;
  }

  explicit SocketGuard(SocketType sock) : sock_(sock) {}

  ~SocketGuard() {
    if (sock_ != kInvalidSocket) {
      CLOSESOCKET(sock_);
    }
  }
  SocketGuard(const SocketGuard&) = delete;
  SocketGuard& operator=(const SocketGuard&) = delete;

 private:
  SocketType sock_;
};

}  // namespace base
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_BASE_SOCKET_UTIL_H_
