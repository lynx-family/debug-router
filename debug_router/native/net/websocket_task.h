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

// custom error for websocket
extern const int kParseUrlErrorCode;
extern const int kNullSocketGuard;
extern const int kUnexpectedOpcode;
extern const int kUnexpectedMaskPayloadLen;
extern const int kDeflatedMessageUnimplemented;

class WebSocketTask : public base::WorkThreadExecutor {
 public:
  WebSocketTask(std::shared_ptr<core::MessageTransceiver> transceiver,
                const std::string &url);
  virtual ~WebSocketTask() override;

  void Stop();
  void Start();
  void SendInternal(const std::string &data);

#ifdef TESTING
  void SetConnectedForTest(bool connected) {
    is_connected_.store(connected, std::memory_order_relaxed);
  }

  void NotifyFailureForTest(const std::string &error_message, int error_code) {
    onFailure(error_message, error_code);
  }

  void NotifyCloseForTest() { onClose(); }

  static bool IsValidWebSocketUrlForTest(const std::string &url);
  static std::string GetRequestTargetForTest(const std::string &url);
#endif

 private:
  void StartInternal();
  void BeginTransportShutdown();

  bool do_connect();
  bool do_read(std::string &msg);

  void NotifyFailureOnce(const std::string &error_message, int error_code);
  void NotifyClosedOnce();
  void onOpen();
  void onFailure(const std::string &error_message, int error_code);
  void onClose();
  void onMessage(const std::string &msg);

 private:
  std::weak_ptr<core::MessageTransceiver> transceiver_;
  std::string url_;
  std::unique_ptr<base::SocketGuard> socket_guard_;
  std::atomic<bool> is_connected_ = {false};
  std::atomic<bool> stopping_ = {false};
  std::atomic<bool> failure_reported_ = {false};
  std::atomic<bool> closed_reported_ = {false};
};

}  // namespace net
}  // namespace debugrouter
#endif  // DEBUGROUTER_NATIVE_NET_WEBSOCKET_TASK_H_
