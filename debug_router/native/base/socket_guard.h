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
#else
#include <netdb.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#define CLOSESOCKET close
typedef int SocketType;
#endif
#include <mutex>

#include "debug_router/native/log/logging.h"
#include "debug_router/native/socket/socket_server_type.h"

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
    if (sock_ != socket_server::kInvalidSocket) {
      CLOSESOCKET(sock_);
    }
    sock_ = socket_server::kInvalidSocket;
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
