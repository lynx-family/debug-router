// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_NET_WEBSOCKET_CLIENT_H_
#define DEBUGROUTER_NATIVE_NET_WEBSOCKET_CLIENT_H_

#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "debug_router/native/base/socket_guard.h"
#include "debug_router/native/core/message_transceiver.h"
#include "debug_router/native/net/websocket_task.h"
#include "debug_router/native/socket/work_thread_executor.h"

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <netdb.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#define SOCKET int
#endif

namespace debugrouter {
namespace base {
class WorkThreadExecutor;
class SocketGuard;
}  // namespace base
namespace net {

class WebSocketClient : public core::MessageTransceiver {
 public:
  WebSocketClient();
  virtual ~WebSocketClient();

  virtual void Init() override;
  virtual bool Connect(const std::string &url) override;
  virtual void Disconnect() override;
  virtual void Send(const std::string &data) override;
  core::ConnectionType GetType() override;

 private:
  void DisconnectInternal();
  void ConnectInternal(const std::string &url);

  base::WorkThreadExecutor work_thread_;
  std::unique_ptr<WebSocketTask> current_task_;
};
}  // namespace net
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_NET_WEBSOCKET_CLIENT_H_
