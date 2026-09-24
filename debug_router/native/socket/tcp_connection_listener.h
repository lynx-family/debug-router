// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_TCP_CONNECTION_LISTENER_H_
#define DEBUGROUTER_NATIVE_SOCKET_TCP_CONNECTION_LISTENER_H_

#include "debug_router/native/socket/tcp_connection.h"

namespace debugrouter {
namespace socket_server {
class TcpConnection;

// listener of tcp_connection
class TcpConnectionListener {
 public:
  virtual void OnOpen(std::shared_ptr<TcpConnection> client, int32_t code,
                      const std::string& reason) = 0;
  virtual void OnClose(std::shared_ptr<TcpConnection> client, int32_t code,
                       const std::string& reason) = 0;
  virtual void OnError(std::shared_ptr<TcpConnection> client, int32_t code,
                       const std::string& message) = 0;
  virtual void OnMessage(std::shared_ptr<TcpConnection> client,
                         const std::string& message) = 0;
};

}  // namespace socket_server
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_TCP_CONNECTION_LISTENER_H_
