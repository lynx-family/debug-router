// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_TCP_SERVER_H
#define DEBUGROUTER_NATIVE_SOCKET_TCP_SERVER_H

#include <atomic>
#include <mutex>
#include <queue>
#include <string>
#include <thread>

#include "debug_router/native/log/logging.h"
#include "debug_router/native/socket/count_down_latch.h"
#include "debug_router/native/socket/socket_server_type.h"
#include "debug_router/native/socket/tcp_connection_listener.h"
#include "debug_router/native/socket/work_thread_executor.h"

namespace debugrouter {
namespace socket_server {

class TcpServerConnectionListener {
 public:
  virtual void OnInit(int32_t code, const std::string &info) = 0;
  virtual void OnStatusChanged(const std::shared_ptr<TcpConnection> &client,
                               ConnectionStatus status, int32_t code,
                               const std::string &info) = 0;
  virtual void OnMessage(const std::shared_ptr<TcpConnection> &client,
                         const std::string &message) = 0;
};

class TcpServer : public std::enable_shared_from_this<TcpServer> {
 public:
  explicit TcpServer(
      const std::shared_ptr<TcpServerConnectionListener> &listener);
  virtual ~TcpServer();

  void Init();
  bool Send(const std::string &message);
  void Disconnect();
#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
  bool SetStartPort(int32_t start_port);
#endif

  void HandleOnOpenStatus(std::shared_ptr<TcpConnection> client, int32_t code,
                          const std::string &reason);
  void HandleOnMessageStatus(std::shared_ptr<TcpConnection> client,
                             const std::string &message);
  void HandleOnCloseStatus(std::shared_ptr<TcpConnection> client,
                           ConnectionStatus status, int32_t code,
                           const std::string &reason);
  void HandleOnErrorStatus(std::shared_ptr<TcpConnection> client,
                           ConnectionStatus status, int32_t code,
                           const std::string &reason);
  void ScheduleClientStop(const std::shared_ptr<TcpConnection> &client);

  static std::shared_ptr<TcpServer> CreateTcpServer(
      const std::shared_ptr<TcpServerConnectionListener> &listener);

  void StartServer();
  void StopServer();

 protected:
  static void ThreadFunc(std::shared_ptr<TcpServer> tcp_server);

  virtual void Start() = 0;
  virtual int GetErrorMessage() = 0;
  virtual void CloseSocket(int socket_fd) = 0;
  void Close();
  void NotifyInit(int32_t code, const std::string &info);
#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
  PORT_TYPE GetStartPort();
#endif

  void setEnableServer(bool enable);

  std::weak_ptr<TcpServerConnectionListener> listener_;
  std::queue<std::string> writer_message_queue_;
  std::condition_variable queue_available_;
  std::unique_ptr<CountDownLatch> latch_;
  std::mutex queue_lock_;
  std::mutex client_lock_;
  debugrouter::base::WorkThreadExecutor clean_executor_;
  std::shared_ptr<TcpConnection> tcp_connection_;
  std::shared_ptr<TcpConnection> temp_tcp_connection_;

  std::atomic<SocketType> socket_fd_{kInvalidSocket};

 private:
#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
  std::atomic<PORT_TYPE> start_port_{kStartPort};
#endif
  std::atomic<bool> is_running_{false};
  std::condition_variable running_condition_;
  std::mutex running_mutex_;
  bool is_serving_{false};
  std::condition_variable serving_condition_;
  std::mutex serving_mutex_;
};

class TcpConnectionForwarder : public TcpConnectionListener {
 public:
  TcpConnectionForwarder(std::shared_ptr<TcpServer> tcp_server)
      : tcp_server_(tcp_server) {}

  virtual ~TcpConnectionForwarder() = default;

  void OnOpen(std::shared_ptr<TcpConnection> client, int32_t code,
              const std::string &reason) override {
    if (auto tcp_server = tcp_server_.lock()) {
      tcp_server->HandleOnOpenStatus(client, code, reason);
    }
    client->SetConnectStatus(TcpConnectionStatus::CONNECTED);
  }

  void OnMessage(std::shared_ptr<TcpConnection> client,
                 const std::string &message) override {
    if (auto tcp_server = tcp_server_.lock()) {
      tcp_server->HandleOnMessageStatus(client, message);
    }
  }

  void OnClose(std::shared_ptr<TcpConnection> client, int32_t code,
               const std::string &reason) override {
    if (auto tcp_server = tcp_server_.lock()) {
      tcp_server->HandleOnCloseStatus(
          client, ConnectionStatus::kDisconnected, code, reason);
    }
    client->SetConnectStatus(TcpConnectionStatus::DISCONNECTED);
  }

  void OnError(std::shared_ptr<TcpConnection> client, int32_t code,
               const std::string &message) override {
    if (auto tcp_server = tcp_server_.lock()) {
      tcp_server->HandleOnErrorStatus(client, ConnectionStatus::kError, code,
                                         message);
    }
    client->SetConnectStatus(TcpConnectionStatus::DISCONNECTED);
  }

 private:
  std::weak_ptr<TcpServer> tcp_server_;
};

}  // namespace socket_server
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_TCP_SERVER_H
