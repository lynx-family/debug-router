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
#include <mutex>

#include "debug_router/native/log/logging.h"

namespace debugrouter {
namespace base {

class SocketGuard {
 public:
  SocketType Get() {
    std::lock_guard<std::mutex> lock(mutex_);
    return sock_;
  }

  void Reset() {
    LOGI("SocketGuard reset.");
    std::lock_guard<std::mutex> lock(mutex_);
    if (sock_ != kInvalidSocket) {
      CLOSESOCKET(sock_);
    }
    sock_ = kInvalidSocket;
  }

  explicit SocketGuard(SocketType sock) : sock_(sock) {}

  ~SocketGuard() {
    LOGI("SocketGuard destruct.");
    Reset();
  }

  SocketGuard(const SocketGuard&) = delete;
  SocketGuard& operator=(const SocketGuard&) = delete;

 private:
  SocketType sock_;
  std::mutex mutex_;
};

}  // namespace base
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_BASE_SOCKET_UTIL_H_
