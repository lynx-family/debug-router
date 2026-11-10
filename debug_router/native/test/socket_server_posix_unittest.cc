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
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "debug_router/native/base/socket_guard.h"
#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/core/util.h"
#include "debug_router/native/socket/count_down_latch.h"
#include "debug_router/native/socket/usb_client.h"
#include "debug_router/native/thread/debug_router_executor.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace socket_server {

class SocketServerPosixTestPeer {
 public:
  static int32_t InitSocket(SocketServerPosix &server) {
    return server.InitSocket();
  }

  static int SocketFd(SocketServerPosix &server) {
    return server.socket_fd_.load(std::memory_order_acquire);
  }

  static void AdoptListeningSocket(SocketServerPosix &server, int socket_fd) {
    server.socket_fd_.store(socket_fd, std::memory_order_release);
  }

  static void AcceptOnce(SocketServerPosix &server) { server.Start(); }

  static void SetTemporaryClient(SocketServerPosix &server,
                                 std::shared_ptr<UsbClient> client) {
    std::lock_guard<std::mutex> lock(server.client_lock_);
    server.temp_usb_client_ = std::move(client);
  }

  static std::shared_ptr<UsbClient> CurrentClient(SocketServerPosix &server) {
    std::lock_guard<std::mutex> lock(server.client_lock_);
    return server.usb_client_;
  }

  static std::shared_ptr<UsbClient> TemporaryClient(SocketServerPosix &server) {
    std::lock_guard<std::mutex> lock(server.client_lock_);
    return server.temp_usb_client_;
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

class RecordingListener final : public SocketServerConnectionListener {
 public:
  void OnInit(int32_t, const std::string &) override {}

  void OnStatusChanged(ConnectionStatus status, int32_t,
                       const std::string &) override {
    std::lock_guard<std::mutex> lock(mutex_);
    statuses_.push_back(status);
    condition_.notify_all();
  }

  void OnMessage(const std::string &message) override {
    std::lock_guard<std::mutex> lock(mutex_);
    messages_.push_back(message);
    condition_.notify_all();
  }

  bool WaitForStatusCount(ConnectionStatus status, size_t count) {
    std::unique_lock<std::mutex> lock(mutex_);
    return condition_.wait_for(lock, 2s, [&]() {
      size_t matches = 0;
      for (ConnectionStatus current : statuses_) {
        matches += current == status;
      }
      return matches >= count;
    });
  }

  bool WaitForMessageCount(size_t count) {
    std::unique_lock<std::mutex> lock(mutex_);
    return condition_.wait_for(lock, 2s,
                               [&]() { return messages_.size() >= count; });
  }

  std::vector<std::string> Messages() {
    std::lock_guard<std::mutex> lock(mutex_);
    return messages_;
  }

 private:
  std::mutex mutex_;
  std::condition_variable condition_;
  std::vector<ConnectionStatus> statuses_;
  std::vector<std::string> messages_;
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

int CreateLoopbackListener(uint16_t &port, uint16_t requested_port = 0) {
  const int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (socket_fd < 0) {
    return -1;
  }

  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(requested_port);
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

std::string PackFrame(const std::string &payload) {
  const uint32_t payload_size = static_cast<uint32_t>(payload.size());
  std::string frame(kFrameHeaderLen + kPayloadSizeLen + payload_size, '\0');
  char encoded[4];
  util::IntToCharArray(kFrameProtocolVersion, encoded);
  std::memcpy(frame.data(), encoded, sizeof(encoded));
  util::IntToCharArray(kPTFrameTypeTextMessage, encoded);
  std::memcpy(frame.data() + 4, encoded, sizeof(encoded));
  util::IntToCharArray(kFrameDefaultTag, encoded);
  std::memcpy(frame.data() + 8, encoded, sizeof(encoded));
  util::IntToCharArray(payload_size + kPayloadSizeLen, encoded);
  std::memcpy(frame.data() + 12, encoded, sizeof(encoded));
  util::IntToCharArray(payload_size, encoded);
  std::memcpy(frame.data() + 16, encoded, sizeof(encoded));
  std::memcpy(frame.data() + 20, payload.data(), payload.size());
  return frame;
}

bool SendAll(int socket_fd, const std::string &data) {
  size_t sent = 0;
  while (sent < data.size()) {
    const ssize_t count =
        send(socket_fd, data.data() + sent, data.size() - sent, 0);
    if (count <= 0) {
      return false;
    }
    sent += static_cast<size_t>(count);
  }
  return true;
}

class ScopedSocketEnvironment {
 public:
  explicit ScopedSocketEnvironment(const char *name) : name_(name) {
    const char *value = std::getenv(name);
    was_set_ = value != nullptr;
    value_ = value ? value : "";
    unsetenv(name_);
  }
  ~ScopedSocketEnvironment() {
    if (was_set_) {
      setenv(name_, value_.c_str(), 1);
    } else {
      unsetenv(name_);
    }
  }

 private:
  const char *name_;
  bool was_set_;
  std::string value_;
};

class SocketServerEnvironmentTest : public testing::Test {
 protected:
  static void SetUpTestSuite() { core::DebugRouterCore::GetInstance(); }

  int32_t InitSocket() {
    // Run callbacks before returning so they cannot outlive the server.
    std::promise<int32_t> result;
    thread::DebugRouterExecutor::GetInstance().Post([&]() {
      result.set_value(SocketServerPosixTestPeer::InitSocket(server_));
    });
    return result.get_future().get();
  }

  ScopedSocketEnvironment port_env_{"LYNX_DEBUG_ROUTER_PORT"};
  SocketServerPosix server_{std::make_shared<NoopListener>()};
};

TEST_F(SocketServerEnvironmentTest, KeepsDefaultPortRetry) {
  uint16_t occupied_port = 0;
  base::SocketGuard occupied(CreateLoopbackListener(occupied_port, kStartPort));
  if (occupied.Get() < 0) {
    GTEST_SKIP() << "Default port is unavailable";
  }
  const int32_t port = InitSocket();
  EXPECT_GT(port, kStartPort);
  EXPECT_LT(port, kStartPort + kTryPortCount);
}

TEST_F(SocketServerEnvironmentTest, UsesExactConfiguredPort) {
  uint16_t port = 0;
  base::SocketGuard occupied(CreateLoopbackListener(port));
  ASSERT_GE(occupied.Get(), 0);
  ASSERT_EQ(setenv("LYNX_DEBUG_ROUTER_PORT", std::to_string(port).c_str(), 1),
            0);
  EXPECT_EQ(InitSocket(), kInvalidPort);
  occupied.Reset();
  ASSERT_EQ(InitSocket(), port);
  base::SocketGuard client(ConnectToPort(port));
  EXPECT_GE(client.Get(), 0);
}

TEST_F(SocketServerEnvironmentTest, RejectsInvalidPorts) {
  for (const char *value : {"", "0", "-1", "65536", "9001x", " 9001",
                            "999999999999999999999999999999"}) {
    SCOPED_TRACE(value);
    ASSERT_EQ(setenv("LYNX_DEBUG_ROUTER_PORT", value, 1), 0);
    EXPECT_EQ(InitSocket(), kInvalidPort);
    EXPECT_EQ(SocketServerPosixTestPeer::SocketFd(server_), kInvalidSocket);
  }
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
     BareConnectionKeepsActiveClientUntilValidFramePromotes) {
  auto listener = std::make_shared<RecordingListener>();
  auto server = std::make_shared<SocketServerPosix>(listener);
  StopServerOnExit stop_server(server);

  uint16_t port = 0;
  const int listener_socket = CreateLoopbackListener(port);
  ASSERT_GE(listener_socket, 0);
  SocketServerPosixTestPeer::AdoptListeningSocket(*server, listener_socket);

  const auto accept_once = [&]() {
    auto accept_future = std::async(std::launch::async, [server]() {
      SocketServerPosixTestPeer::AcceptOnce(*server);
    });
    if (accept_future.wait_for(2s) != std::future_status::ready) {
      return false;
    }
    accept_future.get();
    return true;
  };
  const auto wait_for_cleanup = [&]() {
    auto cleanup_done = std::make_shared<std::promise<void>>();
    auto cleanup_future = cleanup_done->get_future();
    SocketServerPosixTestPeer::SubmitCleanupWork(
        *server, [cleanup_done]() { cleanup_done->set_value(); });
    return cleanup_future.wait_for(2s) == std::future_status::ready;
  };

  base::SocketGuard active_peer(ConnectToPort(port));
  ASSERT_GE(active_peer.Get(), 0);
  ASSERT_TRUE(accept_once());
  const std::string active_message = R"({"event":"Initialize"})";
  ASSERT_TRUE(SendAll(active_peer.Get(), PackFrame(active_message)));
  ASSERT_TRUE(listener->WaitForStatusCount(kConnected, 1));
  ASSERT_TRUE(listener->WaitForMessageCount(1));
  const auto active_client = SocketServerPosixTestPeer::CurrentClient(*server);
  ASSERT_NE(active_client, nullptr);
  EXPECT_EQ(SocketServerPosixTestPeer::TemporaryClient(*server), nullptr);

  base::SocketGuard bare_peer(ConnectToPort(port));
  ASSERT_GE(bare_peer.Get(), 0);
  ASSERT_TRUE(accept_once());
  ASSERT_TRUE(wait_for_cleanup());
  EXPECT_EQ(SocketServerPosixTestPeer::CurrentClient(*server), active_client);
  const auto bare_client = SocketServerPosixTestPeer::TemporaryClient(*server);
  ASSERT_NE(bare_client, nullptr);
  EXPECT_NE(bare_client, active_client);

  const std::string active_after_bare =
      R"({"event":"Customized","data":{"type":"ListSession"}})";
  ASSERT_TRUE(SendAll(active_peer.Get(), PackFrame(active_after_bare)));
  ASSERT_TRUE(listener->WaitForMessageCount(2));
  EXPECT_EQ(listener->Messages()[1], active_after_bare);

  base::SocketGuard promoted_peer(ConnectToPort(port));
  ASSERT_GE(promoted_peer.Get(), 0);
  ASSERT_TRUE(accept_once());
  ASSERT_TRUE(wait_for_cleanup());
  const std::string promoted_message = R"({"event":"Initialize"})";
  ASSERT_TRUE(SendAll(promoted_peer.Get(), PackFrame(promoted_message)));
  ASSERT_TRUE(listener->WaitForStatusCount(kConnected, 2));
  ASSERT_TRUE(listener->WaitForMessageCount(3));
  EXPECT_NE(SocketServerPosixTestPeer::CurrentClient(*server), active_client);
  EXPECT_EQ(SocketServerPosixTestPeer::TemporaryClient(*server), nullptr);
  EXPECT_EQ(listener->Messages()[2], promoted_message);
}

}  // namespace
}  // namespace socket_server
}  // namespace debugrouter

#endif  // _WIN32
