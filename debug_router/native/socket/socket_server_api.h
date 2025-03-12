// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_SOCKET_SERVER_API_H
#define DEBUGROUTER_NATIVE_SOCKET_SOCKET_SERVER_API_H

#include <mutex>
#include <queue>
#include <string>
#include <thread>

#include "debug_router/native/log/logging.h"
#include "debug_router/native/socket/count_down_latch.h"
#include "debug_router/native/socket/socket_server_type.h"
#include "debug_router/native/socket/usb_client_listener.h"

namespace debugrouter {
namespace socket_server {

class SocketServerConnectionListener {
 public:
  virtual void OnInit(int32_t code, const std::string &info) = 0;
  virtual void OnStatusChanged(ConnectionStatus status, int32_t code,
                               const std::string &info) = 0;
  virtual void OnMessage(const std::string &message) = 0;
};

class SocketServer : public std::enable_shared_from_this<SocketServer> {
 public:
  explicit SocketServer(
      const std::shared_ptr<SocketServerConnectionListener> &listener);
  virtual ~SocketServer();

  void Init();
  bool Send(const std::string &message);
  void Disconnect();

  void HandleOnOpenStatus(std::shared_ptr<UsbClient> client, int32_t code,
                          const std::string &reason);
  void HandleOnMessageStatus(std::shared_ptr<UsbClient> client,
                             const std::string &message);
  void HandleOnCloseStatus(std::shared_ptr<UsbClient> client,
                           ConnectionStatus status, int32_t code,
                           const std::string &reason);
  void HandleOnErrorStatus(std::shared_ptr<UsbClient> client,
                           ConnectionStatus status, int32_t code,
                           const std::string &reason);

  static std::shared_ptr<SocketServer> CreateSocketServer(
      const std::shared_ptr<SocketServerConnectionListener> &listener);

 protected:
  static void ThreadFunc(std::shared_ptr<SocketServer> socket_server);

  virtual void Start() = 0;
  virtual int GetErrorMessage() = 0;
  virtual void CloseSocket(int socket_fd) = 0;
  void Close();
  void NotifyInit(int32_t code, const std::string &info);

  std::weak_ptr<SocketServerConnectionListener> listener_;
  std::queue<std::string> writer_message_queue_;
  std::condition_variable queue_available_;
  std::unique_ptr<CountDownLatch> latch_;
  std::mutex queue_lock_;
  std::shared_ptr<UsbClient> usb_client_;

  volatile SocketType socket_fd_ = kInvalidSocket;
};

// ClientListener
class ClientListener : public UsbClientListener {
 public:
  ClientListener(std::shared_ptr<SocketServer> socket_server)
      : socket_server_(socket_server) {}

  virtual ~ClientListener() = default;

  void OnOpen(std::shared_ptr<UsbClient> client, int32_t code,
              const std::string &reason) override {
    if (auto socket_server = socket_server_.lock()) {
      socket_server->HandleOnOpenStatus(client, code, reason);
    }
    client->SetConnectStatus(USBConnectStatus::CONNECTED);
  }

  void OnMessage(std::shared_ptr<UsbClient> client,
                 const std::string &message) override {
    if (auto socket_server = socket_server_.lock()) {
      socket_server->HandleOnMessageStatus(client, message);
    }
  }

  void OnClose(std::shared_ptr<UsbClient> client, int32_t code,
               const std::string &reason) override {
    if (auto socket_server = socket_server_.lock()) {
      socket_server->HandleOnCloseStatus(
          client, ConnectionStatus::kDisconnected, code, reason);
    }
    client->SetConnectStatus(USBConnectStatus::DISCONNECTED);
  }

  void OnError(std::shared_ptr<UsbClient> client, int32_t code,
               const std::string &message) override {
    if (auto socket_server = socket_server_.lock()) {
      socket_server->HandleOnErrorStatus(client, ConnectionStatus::kError, code,
                                         message);
    }
    client->SetConnectStatus(USBConnectStatus::DISCONNECTED);
  }

 private:
  std::weak_ptr<SocketServer> socket_server_;
};

}  // namespace socket_server
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_SOCKET_SERVER_API_H
