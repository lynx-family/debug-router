// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_NET_WEBSOCKET_TASK_H_
#define DEBUGROUTER_NATIVE_NET_WEBSOCKET_TASK_H_

#include "debug_router/native/base/socket_guard.h"
#include "debug_router/native/core/message_transceiver.h"
#include "debug_router/native/socket/work_thread_executor.h"

namespace debugrouter {
namespace net {

class WebSocketTask : public base::WorkThreadExecutor {
 public:
  WebSocketTask(std::shared_ptr<core::MessageTransceiver> transceiver,
                const std::string &url);
  virtual ~WebSocketTask() override;

  void Stop();
  void SendInternal(const std::string &data);

 private:
  void start();

  bool do_connect();

  bool do_read(std::string &msg);

  void onOpen();
  void onFailure();
  void onMessage(const std::string &msg);

 private:
  std::weak_ptr<core::MessageTransceiver> transceiver_;
  std::string url_;
  std::unique_ptr<base::SocketGuard> socket_guard_;
};

}  // namespace net
}  // namespace debugrouter
#endif  // DEBUGROUTER_NATIVE_NET_WEBSOCKET_TASK_H_
