// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef _WIN32

#include "debug_router/native/socket/posix/socket_server_posix.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdint>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "debug_router/native/base/socket_guard.h"
#include "debug_router/native/socket/count_down_latch.h"
#include "debug_router/native/socket/usb_client.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace socket_server {

class SocketServerPosixTestPeer {
 public:
  static void AdoptListeningSocket(SocketServerPosix &server, int socket_fd) {
    server.socket_fd_.store(socket_fd, std::memory_order_release);
  }

  static void AcceptOnce(SocketServerPosix &server) {
    {
      std::lock_guard<std::mutex> lock(server.running_mutex_);
      server.is_running_.store(true, std::memory_order_relaxed);
      ++server.server_generation_;
      server.listener_generation_ = server.server_generation_;
    }
    server.Start();
  }

  static void SetTemporaryClient(SocketServerPosix &server,
                                 std::shared_ptr<UsbClient> client) {
    std::lock_guard<std::mutex> lock(server.client_lock_);
    server.temp_usb_client_ = std::move(client);
  }

  static void SetCurrentClient(SocketServerPosix &server,
                               std::shared_ptr<UsbClient> client) {
    std::lock_guard<std::mutex> lock(server.client_lock_);
    server.usb_client_ = std::move(client);
  }

  static std::shared_ptr<UsbClient> CurrentClient(SocketServerPosix &server) {
    std::lock_guard<std::mutex> lock(server.client_lock_);
    return server.usb_client_;
  }

  static void SetLifecycleLatches(SocketServerPosix &server,
                                  CountDownLatch *created_latch,
                                  CountDownLatch *release_latch,
                                  CountDownLatch *stop_latch) {
    server.client_listener_created_latch_for_test_ = created_latch;
    server.release_client_listener_latch_for_test_ = release_latch;
    server.stop_requested_latch_for_test_ = stop_latch;
  }

  static void BeginGeneration(SocketServerPosix &server) {
    std::lock_guard<std::mutex> lock(server.running_mutex_);
    server.listener_should_exit_ = false;
    server.is_running_.store(true, std::memory_order_relaxed);
    ++server.server_generation_;
    server.listener_generation_ = server.server_generation_;
  }

  static bool SnapshotClientForDisconnect(SocketServerPosix &server,
                                          uint64_t *generation,
                                          std::shared_ptr<UsbClient> *target) {
    return server.SnapshotClientForDisconnect(generation, target);
  }

  static std::shared_ptr<UsbClient> TakeClientForDisconnect(
      SocketServerPosix &server, uint64_t generation,
      const std::shared_ptr<UsbClient> &target) {
    return server.TakeClientForDisconnect(generation, target);
  }

  static void SubmitClientWork(const std::shared_ptr<UsbClient> &client,
                               std::function<void()> task) {
    client->SubmitWorkForTest(std::move(task));
  }

  static void SubmitCleanupWork(SocketServerPosix &server,
                                std::function<void()> task) {
    server.clean_executor_.submit(std::move(task));
  }
};

namespace {

using namespace std::chrono_literals;

class NoopListener final : public SocketServerConnectionListener {
 public:
  void OnInit(int32_t, const std::string &) override {}
  void OnStatusChanged(ConnectionStatus, int32_t,
                       const std::string &) override {}
  void OnMessage(const std::string &) override {}
};

class StopServerOnExit {
 public:
  explicit StopServerOnExit(std::shared_ptr<SocketServerPosix> server)
      : server_(std::move(server)) {}
  ~StopServerOnExit() { server_->StopServer(); }

 private:
  std::shared_ptr<SocketServerPosix> server_;
};

class CountDownOnExit {
 public:
  explicit CountDownOnExit(std::shared_ptr<CountDownLatch> latch)
      : latch_(std::move(latch)) {}
  ~CountDownOnExit() { latch_->CountDown(); }

 private:
  std::shared_ptr<CountDownLatch> latch_;
};

int CreateLoopbackListener(uint16_t &port) {
  const int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (socket_fd < 0) {
    return -1;
  }

  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = 0;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(socket_fd, reinterpret_cast<sockaddr *>(&address),
           sizeof(address)) != 0 ||
      listen(socket_fd, 1) != 0) {
    close(socket_fd);
    return -1;
  }

  socklen_t address_length = sizeof(address);
  if (getsockname(socket_fd, reinterpret_cast<sockaddr *>(&address),
                  &address_length) != 0) {
    close(socket_fd);
    return -1;
  }
  port = ntohs(address.sin_port);
  return socket_fd;
}

int ConnectToPort(uint16_t port) {
  const int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (socket_fd < 0) {
    return -1;
  }

  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(socket_fd, reinterpret_cast<sockaddr *>(&address),
              sizeof(address)) != 0) {
    close(socket_fd);
    return -1;
  }
  return socket_fd;
}

TEST(SocketServerPosixTestSuite,
     AcceptsNewClientBeforeSupersededClientCleanupCompletes) {
  auto listener = std::make_shared<NoopListener>();
  auto server = std::make_shared<SocketServerPosix>(listener);
  StopServerOnExit stop_server(server);

  uint16_t port = 0;
  const int listener_socket = CreateLoopbackListener(port);
  ASSERT_GE(listener_socket, 0);
  SocketServerPosixTestPeer::AdoptListeningSocket(*server, listener_socket);
  ASSERT_NE(port, 0);

  int old_sockets[2] = {-1, -1};
  ASSERT_EQ(socketpair(AF_UNIX, SOCK_STREAM, 0, old_sockets), 0);
  base::SocketGuard old_peer(old_sockets[1]);
  auto old_client = std::make_shared<UsbClient>(old_sockets[0]);
  old_client->Init();
  std::weak_ptr<UsbClient> old_client_weak = old_client;
  SocketServerPosixTestPeer::SetTemporaryClient(*server, old_client);

  const int new_peer_socket = ConnectToPort(port);
  ASSERT_GE(new_peer_socket, 0);
  base::SocketGuard new_peer(new_peer_socket);

  auto release_old_cleanup = std::make_shared<CountDownLatch>(1);
  CountDownOnExit release_on_exit(release_old_cleanup);
  auto old_work_blocked = std::make_shared<std::promise<void>>();
  auto old_work_blocked_future = old_work_blocked->get_future();
  SocketServerPosixTestPeer::SubmitClientWork(old_client, [=]() {
    old_work_blocked->set_value();
    release_old_cleanup->Await();
  });
  ASSERT_EQ(old_work_blocked_future.wait_for(2s), std::future_status::ready);
  old_client.reset();

  auto accept_future = std::async(std::launch::async, [server]() {
    SocketServerPosixTestPeer::AcceptOnce(*server);
  });
  const bool accepted_before_cleanup =
      accept_future.wait_for(2s) == std::future_status::ready;

  auto cleanup_drained = std::make_shared<std::promise<void>>();
  auto cleanup_drained_future = cleanup_drained->get_future();
  SocketServerPosixTestPeer::SubmitCleanupWork(
      *server, [=]() { cleanup_drained->set_value(); });
  release_old_cleanup->CountDown();

  ASSERT_EQ(accept_future.wait_for(2s), std::future_status::ready);
  accept_future.get();
  ASSERT_EQ(cleanup_drained_future.wait_for(2s), std::future_status::ready);

  EXPECT_TRUE(accepted_before_cleanup);
  EXPECT_TRUE(old_client_weak.expired());
}

TEST(SocketServerPosixTestSuite,
     AcceptedClientListenerDoesNotOwnServerDuringTeardown) {
  auto listener = std::make_shared<NoopListener>();
  CountDownLatch client_listener_created(1);
  CountDownLatch release_client_listener(1);
  CountDownLatch stop_requested(1);
  auto base_server = SocketServer::CreateSocketServer(listener);
  auto server = std::static_pointer_cast<SocketServerPosix>(base_server);
  base_server.reset();
  std::weak_ptr<SocketServerPosix> weak_server = server;

  uint16_t port = 0;
  const int listener_socket = CreateLoopbackListener(port);
  ASSERT_GE(listener_socket, 0);
  SocketServerPosixTestPeer::AdoptListeningSocket(*server, listener_socket);

  SocketServerPosixTestPeer::SetLifecycleLatches(
      *server, &client_listener_created, &release_client_listener,
      &stop_requested);

  server->Init();
  server->StartServer();
  const int peer_socket = ConnectToPort(port);
  ASSERT_GE(peer_socket, 0);
  base::SocketGuard peer(peer_socket);
  client_listener_created.Await();

  EXPECT_EQ(server.use_count(), 1);
  if (server.use_count() != 1) {
    release_client_listener.CountDown();
    server->StopServer();
    return;
  }

  std::thread reset_thread(
      [owned_server = std::move(server)]() mutable { owned_server.reset(); });
  stop_requested.Await();
  release_client_listener.CountDown();
  reset_thread.join();

  EXPECT_TRUE(weak_server.expired());
}

TEST(SocketServerPosixTestSuite,
     StaleDisconnectDoesNotClearClientFromNewGeneration) {
  auto listener = std::make_shared<NoopListener>();
  auto server = std::make_shared<SocketServerPosix>(listener);
  auto old_client = std::make_shared<UsbClient>(kInvalidSocket);

  SocketServerPosixTestPeer::BeginGeneration(*server);
  SocketServerPosixTestPeer::SetCurrentClient(*server, old_client);
  uint64_t old_generation = 0;
  std::shared_ptr<UsbClient> old_target;
  ASSERT_TRUE(SocketServerPosixTestPeer::SnapshotClientForDisconnect(
      *server, &old_generation, &old_target));

  SocketServerPosixTestPeer::BeginGeneration(*server);
  auto new_client = std::make_shared<UsbClient>(kInvalidSocket);
  SocketServerPosixTestPeer::SetCurrentClient(*server, new_client);

  EXPECT_EQ(SocketServerPosixTestPeer::TakeClientForDisconnect(
                *server, old_generation, old_target),
            nullptr);
  EXPECT_EQ(SocketServerPosixTestPeer::CurrentClient(*server), new_client);
}

}  // namespace
}  // namespace socket_server
}  // namespace debugrouter

#endif  // _WIN32
