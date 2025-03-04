// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_NET_WEBSOCKET_CLIENT_H_
#define DEBUGROUTER_NATIVE_NET_WEBSOCKET_CLIENT_H_

#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "debug_router/native/core/message_transceiver.h"

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

namespace debugrouter {
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
  void run();
  bool do_connect();
  bool do_read(std::string &msg);

  std::string url_;
  SOCKET socket_ = 0;
  std::unique_ptr<std::thread> thread_;
  std::mutex mutex_;
};
}  // namespace net
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_NET_WEBSOCKET_CLIENT_H_
