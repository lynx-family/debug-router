// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_SOCKET_SERVER_API_H
#define DEBUGROUTER_NATIVE_SOCKET_SOCKET_SERVER_API_H

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>

#include "debug_router/native/log/logging.h"
#include "debug_router/native/socket/count_down_latch.h"
#include "debug_router/native/socket/socket_server_type.h"
#include "debug_router/native/socket/usb_client_listener.h"
#include "debug_router/native/socket/work_thread_executor.h"

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
  void ScheduleClientStop(const std::shared_ptr<UsbClient> &client);

  static std::shared_ptr<SocketServer> CreateSocketServer(
      const std::shared_ptr<SocketServerConnectionListener> &listener);

  void StartServer();
  void StopServer();

 protected:
  // SocketServer is an internal platform abstraction. Callers must use
  // CreateSocketServer(), whose deleter stops the listener before object
  // destruction starts. Built-in destructors repeat StopServer() idempotently
  // for direct internal construction after an explicit stop.
  static void ThreadFunc(std::shared_ptr<SocketServer> socket_server);

  virtual void Start() = 0;
  virtual int GetErrorMessage() = 0;
  virtual void CloseSocket(int socket_fd) = 0;
  bool TryPublishSocket(SocketType socket_fd);
  bool TryInstallPendingClient(const std::shared_ptr<UsbClient> &client,
                               std::shared_ptr<UsbClient> *old_client);
#if defined(TESTING)
  void WaitForClientListenerReleaseForTest();
#endif
  void Close();
  void NotifyInit(int32_t code, const std::string &info);

  void setEnableServer(bool enable);

  std::weak_ptr<SocketServerConnectionListener> listener_;
  std::queue<std::string> writer_message_queue_;
  std::condition_variable queue_available_;
  std::unique_ptr<CountDownLatch> latch_;
  std::mutex queue_lock_;
  std::mutex client_lock_;
  debugrouter::base::WorkThreadExecutor clean_executor_;
  std::shared_ptr<UsbClient> usb_client_;
  std::shared_ptr<UsbClient> temp_usb_client_;

  std::atomic<SocketType> socket_fd_{kInvalidSocket};

 private:
#if defined(TESTING)
  friend class SocketServerPosixTestPeer;
#endif

  static void ListenerThreadFunc(SocketServer *socket_server);
  bool IsListenerGenerationActive(uint64_t generation);
  bool SnapshotClientForDisconnect(uint64_t *generation,
                                   std::shared_ptr<UsbClient> *target);
  std::shared_ptr<UsbClient> TakeClientForDisconnect(
      uint64_t generation, const std::shared_ptr<UsbClient> &target);

  std::atomic<bool> is_running_{false};
  std::condition_variable running_condition_;
  std::mutex running_mutex_;
  std::mutex server_operation_mutex_;
  std::thread listen_thread_;
  bool initialized_{false};
  bool listener_should_exit_{false};
  uint64_t server_generation_{0};
  uint64_t listener_generation_{0};
#if defined(TESTING)
  CountDownLatch *client_listener_created_latch_for_test_{nullptr};
  CountDownLatch *release_client_listener_latch_for_test_{nullptr};
  CountDownLatch *stop_requested_latch_for_test_{nullptr};
#endif
};

// ClientListener
class ClientListener : public UsbClientListener {
 public:
  ClientListener(std::shared_ptr<SocketServer> socket_server)
      : socket_server_(socket_server) {}
  explicit ClientListener(std::weak_ptr<SocketServer> socket_server)
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
