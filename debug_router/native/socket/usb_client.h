// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_USB_CLIENT_H_
#define DEBUGROUTER_NATIVE_SOCKET_USB_CLIENT_H_

#include "debug_router/native/socket/blocking_queue.h"
#include "debug_router/native/socket/count_down_latch.h"
#include "debug_router/native/socket/socket_server_type.h"
#include "debug_router/native/socket/usb_client_listener.h"
#include "debug_router/native/socket/work_thread_executor.h"

namespace debugrouter {
namespace base {
class WorkThreadExecutor;
}
namespace socket_server {
class UsbClientListener;

static const char *kMessageQuit = "quit";

// Client of socket_server
class UsbClient : public std::enable_shared_from_this<UsbClient> {
 public:
  // below three functions work only on one work thread
  void StartUp(const std::shared_ptr<UsbClientListener> &listener);
  void Stop();
  // true means the message are added to message queue
  bool Send(const std::string &message);

  explicit UsbClient(SocketType socket_fd);
  ~UsbClient();

  void SetConnectStatus(USBConnectStatus status);

 private:
  void StartInternal(const std::shared_ptr<UsbClientListener> &listener);
  void DisconnectInternal();
  void SendInternal(const std::string &message);

  void StartReader(SocketType socket_fd_);
  void StartWriter(SocketType socket_fd_);
  void StartMessageDispatcher(SocketType socket_fd_);
  void ReadMessage(SocketType socket_fd_);
  void MessageDispatcher();
  void WriteMessage(SocketType socket_fd_);
  void HandleFirstFrame(SocketType socket_fd);

  bool Read(SocketType socket_fd_, char *buffer, uint32_t read_size);
  bool ReadAndCheckMessageHeader(char *header, SocketType socket_fd_);

  void CloseClientSocket(SocketType socket_fd_);
  /**
   *  The DebugRouter message structure is:
   *
   *  struct message {
   *   uint32_t version, // [0,4) protocol version, current version is
   *   kFrameProtocolVersion
   *
   *   uint32_t type, // [4, 8) message_type, DebugRouter only use text message,
   *   current type is kPTFrameTypeTextMessage
   *
   *   uint32_t tag, // [8, 12) unused, the value remains unchanged at
   *   kFrameDefaultTag
   *
   *   uint32_t payloadSize, // [12, 16) payload's size
   *
   *   PayLoad payload
   *  }
   *
   *  struct PayLoad {
   *      uint32_t len, // payload len
   *      uint32_t[payloadSize-4] content // payload content
   *  }
   *
   *  At DebugRouter, we use term 'header' represent version, type and tag.
   *
   *  WrapHeader add header for message
   */
  static void WrapHeader(const std::string &message, std::string &result);

  // work threads
  static void MessageDispatcherFunc(std::shared_ptr<UsbClient> client);
  static void ReadThreadFunc(std::shared_ptr<UsbClient> client,
                             SocketType socket_fd_);
  static void WriteThreadFunc(std::shared_ptr<UsbClient> client,
                              SocketType socket_fd_);

 private:
  BlockingQueue<std::string> incoming_message_queue_;
  BlockingQueue<std::string> outgoing_message_queue_;

  base::WorkThreadExecutor work_thread_;
  std::shared_ptr<UsbClientListener> listener_;
  USBConnectStatus connect_status_ = USBConnectStatus::DISCONNECTED;
  std::unique_ptr<CountDownLatch> latch_;

  volatile SocketType socket_fd_ = kInvalidSocket;
  // mutex for close socket_fd_
  std::mutex mutex_;
};

}  // namespace socket_server
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_USB_CLIENT_H_
