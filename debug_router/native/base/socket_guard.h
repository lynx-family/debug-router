// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_BASE_SOCKET_UTIL_H_
#define DEBUGROUTER_NATIVE_BASE_SOCKET_UTIL_H_

#include <cstddef>

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#define CLOSESOCKET closesocket
typedef SOCKET SocketType;
typedef int SocketSendResult;
#else
#include <netdb.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include <cerrno>
#define CLOSESOCKET close
typedef int SocketType;
typedef ssize_t SocketSendResult;
#endif
#include <mutex>

#include "debug_router/native/log/logging.h"
#include "debug_router/native/socket/socket_server_type.h"

namespace debugrouter {
namespace base {

inline void SetNoSigPipe(SocketType sock) {
#if !defined(_WIN32) && defined(SO_NOSIGPIPE)
  int value = 1;
  if (setsockopt(sock, SOL_SOCKET, SO_NOSIGPIPE, &value, sizeof(value)) == -1) {
    LOGE("Set SO_NOSIGPIPE failed: " << errno);
  }
#else
  (void)sock;
#endif
}

inline SocketSendResult SendNoSigPipe(SocketType sock, const void* buffer,
                                      size_t length) {
#if defined(_WIN32)
  return send(sock, static_cast<const char*>(buffer), static_cast<int>(length),
              0);
#elif defined(MSG_NOSIGNAL)
  return send(sock, buffer, length, MSG_NOSIGNAL);
#else
  return send(sock, buffer, length, 0);
#endif
}

namespace internal {

inline bool IsSocketSendInterrupted() {
#if defined(_WIN32)
  return WSAGetLastError() == WSAEINTR;
#else
  return errno == EINTR;
#endif
}

template <typename SendOperation>
bool SendAllWith(const void* buffer, size_t length,
                 SendOperation send_operation) {
  const char* next = static_cast<const char*>(buffer);
  size_t remaining = length;
  while (remaining > 0) {
    const SocketSendResult result = send_operation(next, remaining);
    if (result > 0) {
      const size_t sent = static_cast<size_t>(result);
      if (sent > remaining) {
        return false;
      }
      next += sent;
      remaining -= sent;
      continue;
    }
    if (result < 0 && IsSocketSendInterrupted()) {
      continue;
    }
    return false;
  }
  return true;
}

inline bool SendAllNoSigPipe(SocketType sock, const void* buffer,
                             size_t length) {
  return SendAllWith(buffer, length,
                     [sock](const void* remaining, size_t remaining_length) {
                       return SendNoSigPipe(sock, remaining, remaining_length);
                     });
}

}  // namespace internal

class SocketGuard {
 public:
  SocketType Get() {
    std::lock_guard<std::mutex> lock(mutex_);
    return sock_;
  }

  void ShutdownAndReset() {
    LOGI("SocketGuard shutdown and reset.");
    std::lock_guard<std::mutex> lock(mutex_);
    if (sock_ != socket_server::kInvalidSocket) {
#ifdef _WIN32
      shutdown(sock_, SD_BOTH);
#else
      shutdown(sock_, SHUT_RDWR);
#endif
      CLOSESOCKET(sock_);
    }
    sock_ = socket_server::kInvalidSocket;
  }

  void Reset() {
    LOGI("SocketGuard reset.");
    std::lock_guard<std::mutex> lock(mutex_);
    if (sock_ != socket_server::kInvalidSocket) {
      CLOSESOCKET(sock_);
    }
    sock_ = socket_server::kInvalidSocket;
  }

  explicit SocketGuard(SocketType sock) : sock_(sock) {
    if (sock_ != socket_server::kInvalidSocket) {
      SetNoSigPipe(sock_);
    }
  }

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
