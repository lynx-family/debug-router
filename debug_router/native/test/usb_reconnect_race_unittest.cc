// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/core/util.h"
#include "debug_router/native/socket/socket_server_api.h"
#include "debug_router/native/thread/debug_router_executor.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace socket_server {
namespace {

std::string PackFrame(const std::string& payload) {
  const uint32_t payload_size = static_cast<uint32_t>(payload.size());
  const uint32_t total_size = kFrameHeaderLen + kPayloadSizeLen + payload_size;
  std::string result(total_size, '\0');
  char* buffer = &result[0];
  char char_array[4];

  util::IntToCharArray(kFrameProtocolVersion, char_array);
  memcpy(buffer, char_array, 4);
  util::IntToCharArray(kPTFrameTypeTextMessage, char_array);
  memcpy(buffer + 4, char_array, 4);
  util::IntToCharArray(kFrameDefaultTag, char_array);
  memcpy(buffer + 8, char_array, 4);
  util::IntToCharArray(payload_size + kPayloadSizeLen, char_array);
  memcpy(buffer + 12, char_array, 4);
  util::IntToCharArray(payload_size, char_array);
  memcpy(buffer + 16, char_array, 4);
  memcpy(buffer + 20, payload.data(), payload_size);
  return result;
}

int ConnectToPort(int port) {
  int sock = socket(AF_INET, SOCK_STREAM, 0);
  if (sock < 0) {
    return -1;
  }

  sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(port));
  addr.sin_addr.s_addr = inet_addr("127.0.0.1");

  if (connect(sock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
    close(sock);
    return -1;
  }
  return sock;
}

bool SendAll(int sock, const std::string& data) {
  size_t sent = 0;
  while (sent < data.size()) {
    ssize_t n = send(sock, data.data() + sent, data.size() - sent, 0);
    if (n <= 0) {
      return false;
    }
    sent += static_cast<size_t>(n);
  }
  return true;
}

bool WaitForExecutorTask(int timeout_ms) {
  std::mutex mutex;
  std::condition_variable cv;
  bool finished = false;
  thread::DebugRouterExecutor::GetInstance().Post([&]() {
    std::lock_guard<std::mutex> lock(mutex);
    finished = true;
    cv.notify_all();
  });
  std::unique_lock<std::mutex> lock(mutex);
  return cv.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                     [&]() { return finished; });
}

class RecordingSocketServerListener final
    : public SocketServerConnectionListener {
 public:
  void OnInit(int32_t code, const std::string& info) override {}

  void OnStatusChanged(ConnectionStatus status, int32_t code,
                       const std::string& info) override {
    if (status == kConnected) {
      connected_count.fetch_add(1, std::memory_order_relaxed);
    } else if (status == kDisconnected) {
      disconnected_count.fetch_add(1, std::memory_order_relaxed);
    } else if (status == kError) {
      error_count.fetch_add(1, std::memory_order_relaxed);
    }
    cv.notify_all();
  }

  void OnMessage(const std::string& message) override {}

  bool WaitForCount(const std::atomic<int>& counter, int expected_count,
                    int timeout_ms) {
    std::unique_lock<std::mutex> lock(mutex);
    return cv.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&]() {
      return counter.load(std::memory_order_relaxed) >= expected_count;
    });
  }

  std::mutex mutex;
  std::condition_variable cv;
  std::atomic<int> connected_count{0};
  std::atomic<int> disconnected_count{0};
  std::atomic<int> error_count{0};
};

class TestSocketServer final : public SocketServer {
 public:
  explicit TestSocketServer(
      const std::shared_ptr<SocketServerConnectionListener>& listener)
      : SocketServer(listener) {}

  void Start() override {}
  int GetErrorMessage() override { return 0; }
  void CloseSocket(int socket_fd) override {}

  void SeedClients(const std::shared_ptr<UsbClient>& current,
                   const std::shared_ptr<UsbClient>& pending) {
    std::lock_guard<std::mutex> lock(client_lock_);
    usb_client_ = current;
    temp_usb_client_ = pending;
  }

  std::shared_ptr<UsbClient> CurrentClient() {
    std::lock_guard<std::mutex> lock(client_lock_);
    return usb_client_;
  }

  bool WaitUntil(std::function<bool()> predicate, int timeout_ms) {
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(timeout_ms);
    while (std::chrono::steady_clock::now() < deadline) {
      if (predicate()) {
        return true;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return predicate();
  }
};

class UsbReconnectRaceTestSuite : public testing::Test {
 protected:
  static void SetUpTestSuite() { core::DebugRouterCore::GetInstance(); }

  static void TearDownTestSuite() {}
};

class IntegrationConnectionListener final
    : public SocketServerConnectionListener {
 public:
  void OnInit(int32_t code, const std::string& info) override {
    std::lock_guard<std::mutex> lock(mutex_);
    init_code_ = code;
    init_info_ = info;
    cv_.notify_all();
  }

  void OnStatusChanged(ConnectionStatus status, int32_t code,
                       const std::string& info) override {
    std::lock_guard<std::mutex> lock(mutex_);
    status_history_.push_back(status);
    cv_.notify_all();
  }

  void OnMessage(const std::string& message) override {
    std::lock_guard<std::mutex> lock(mutex_);
    messages_.push_back(message);
    cv_.notify_all();
  }

  bool WaitForInit(int timeout_ms) {
    std::unique_lock<std::mutex> lock(mutex_);
    return cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&]() {
      return init_code_ == 0 && init_info_.rfind("port:", 0) == 0;
    });
  }

  bool WaitForStatusCount(ConnectionStatus status, size_t expected_count,
                          int timeout_ms) {
    std::unique_lock<std::mutex> lock(mutex_);
    return cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&]() {
      return CountStatusLocked(status) >= expected_count;
    });
  }

  bool WaitForMessages(size_t expected_count, int timeout_ms) {
    std::unique_lock<std::mutex> lock(mutex_);
    return cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                        [&]() { return messages_.size() >= expected_count; });
  }

  int Port() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (init_info_.rfind("port:", 0) != 0) {
      return -1;
    }
    return std::stoi(init_info_.substr(5));
  }

  size_t StatusCount(ConnectionStatus status) {
    std::lock_guard<std::mutex> lock(mutex_);
    return CountStatusLocked(status);
  }

  std::vector<std::string> Messages() {
    std::lock_guard<std::mutex> lock(mutex_);
    return messages_;
  }

 private:
  size_t CountStatusLocked(ConnectionStatus status) const {
    size_t count = 0;
    for (ConnectionStatus current : status_history_) {
      if (current == status) {
        ++count;
      }
    }
    return count;
  }

  std::mutex mutex_;
  std::condition_variable cv_;
  int32_t init_code_ = -1;
  std::string init_info_;
  std::vector<ConnectionStatus> status_history_;
  std::vector<std::string> messages_;
};

class UsbReconnectIntegrationTest : public testing::Test {
 protected:
  static void SetUpTestSuite() { core::DebugRouterCore::GetInstance(); }

  void SetUp() override {
    listener_ = std::make_shared<IntegrationConnectionListener>();
    server_ = SocketServer::CreateSocketServer(listener_);
    server_->Init();
    server_->StartServer();
    ASSERT_TRUE(listener_->WaitForInit(5000));
    port_ = listener_->Port();
    ASSERT_GT(port_, 0);
  }

  void TearDown() override {
    if (server_) {
      server_->StopServer();
      server_.reset();
    }
  }

  std::shared_ptr<IntegrationConnectionListener> listener_;
  std::shared_ptr<SocketServer> server_;
  int port_ = -1;
};

TEST_F(UsbReconnectRaceTestSuite,
       StaleOpenAfterNextAcceptDoesNotPromoteOldClient) {
  auto listener = std::make_shared<RecordingSocketServerListener>();
  auto server = std::shared_ptr<TestSocketServer>(
      new TestSocketServer(listener), [](TestSocketServer*) {});
  auto old_client = std::make_shared<UsbClient>(kInvalidSocket);
  auto new_client = std::make_shared<UsbClient>(kInvalidSocket);

  server->SeedClients(nullptr, new_client);

  server->HandleOnOpenStatus(old_client, 0, "Init Success!");
  ASSERT_TRUE(WaitForExecutorTask(1000));
  EXPECT_EQ(listener->connected_count.load(std::memory_order_relaxed), 0);
  EXPECT_EQ(server->CurrentClient(), nullptr);

  server->HandleOnOpenStatus(new_client, 0, "Init Success!");
  ASSERT_TRUE(listener->WaitForCount(listener->connected_count, 1, 1000));
  EXPECT_EQ(listener->connected_count.load(std::memory_order_relaxed), 1);
  EXPECT_EQ(server->CurrentClient(), new_client);
}

TEST_F(UsbReconnectRaceTestSuite,
       PromotedCloseBeforePendingFailureStillNotifiesDisconnect) {
  auto listener = std::make_shared<RecordingSocketServerListener>();
  auto server = std::shared_ptr<TestSocketServer>(
      new TestSocketServer(listener), [](TestSocketServer*) {});
  auto old_client = std::make_shared<UsbClient>(kInvalidSocket);
  auto new_client = std::make_shared<UsbClient>(kInvalidSocket);

  server->SeedClients(nullptr, old_client);
  server->HandleOnOpenStatus(old_client, 0, "Init Success!");
  ASSERT_TRUE(listener->WaitForCount(listener->connected_count, 1, 1000));
  EXPECT_EQ(server->CurrentClient(), old_client);

  server->SeedClients(old_client, new_client);
  server->HandleOnCloseStatus(old_client, ConnectionStatus::kDisconnected, 0,
                              "peer closed connection (EOF)");
  ASSERT_TRUE(server->WaitUntil(
      [&]() { return server->CurrentClient() == nullptr; }, 1000));
  ASSERT_TRUE(listener->WaitForCount(listener->disconnected_count, 1, 1000));
  EXPECT_EQ(listener->error_count.load(std::memory_order_relaxed), 0);

  server->HandleOnCloseStatus(new_client, ConnectionStatus::kDisconnected, 0,
                              "peer closed connection (EOF)");
  ASSERT_TRUE(WaitForExecutorTask(1000));
  EXPECT_EQ(listener->connected_count.load(std::memory_order_relaxed), 1);
  EXPECT_EQ(listener->disconnected_count.load(std::memory_order_relaxed), 1);
  EXPECT_EQ(listener->error_count.load(std::memory_order_relaxed), 0);
}

TEST_F(UsbReconnectRaceTestSuite,
       PromotedErrorBeforePendingFailureStillNotifiesError) {
  auto listener = std::make_shared<RecordingSocketServerListener>();
  auto server = std::shared_ptr<TestSocketServer>(
      new TestSocketServer(listener), [](TestSocketServer*) {});
  auto old_client = std::make_shared<UsbClient>(kInvalidSocket);
  auto new_client = std::make_shared<UsbClient>(kInvalidSocket);

  server->SeedClients(nullptr, old_client);
  server->HandleOnOpenStatus(old_client, 0, "Init Success!");
  ASSERT_TRUE(listener->WaitForCount(listener->connected_count, 1, 1000));
  EXPECT_EQ(server->CurrentClient(), old_client);

  server->SeedClients(old_client, new_client);
  server->HandleOnErrorStatus(old_client, ConnectionStatus::kError, 32,
                              "broken pipe");
  ASSERT_TRUE(server->WaitUntil(
      [&]() { return server->CurrentClient() == nullptr; }, 1000));
  ASSERT_TRUE(listener->WaitForCount(listener->error_count, 1, 1000));
  EXPECT_EQ(listener->disconnected_count.load(std::memory_order_relaxed), 0);

  server->HandleOnErrorStatus(new_client, ConnectionStatus::kError, 32,
                              "broken pipe");
  ASSERT_TRUE(WaitForExecutorTask(1000));
  EXPECT_EQ(listener->connected_count.load(std::memory_order_relaxed), 1);
  EXPECT_EQ(listener->error_count.load(std::memory_order_relaxed), 1);
  EXPECT_EQ(listener->disconnected_count.load(std::memory_order_relaxed), 0);

  server->HandleOnCloseStatus(old_client, ConnectionStatus::kDisconnected, 0,
                              "peer closed connection (EOF)");
  ASSERT_TRUE(WaitForExecutorTask(1000));
  EXPECT_EQ(listener->connected_count.load(std::memory_order_relaxed), 1);
  EXPECT_EQ(listener->error_count.load(std::memory_order_relaxed), 1);
  EXPECT_EQ(listener->disconnected_count.load(std::memory_order_relaxed), 0);
}

TEST_F(UsbReconnectIntegrationTest,
       ImmediateReconnectStillDeliversNewConnectionMessages) {
  int sock_a = ConnectToPort(port_);
  ASSERT_GE(sock_a, 0);
  ASSERT_TRUE(
      SendAll(sock_a, PackFrame(R"({"event":"Initialize","data":-1})")));
  ASSERT_TRUE(listener_->WaitForStatusCount(kConnected, 1, 3000));
  ASSERT_TRUE(listener_->WaitForMessages(1, 3000));

  close(sock_a);

  int sock_b = ConnectToPort(port_);
  ASSERT_GE(sock_b, 0);
  const size_t connected_before_b = listener_->StatusCount(kConnected);
  const size_t disconnected_before_b = listener_->StatusCount(kDisconnected);
  const size_t error_before_b = listener_->StatusCount(kError);
  const size_t messages_before_b = listener_->Messages().size();

  const std::string init_b = R"({"event":"Initialize","data":-1})";
  const std::string list_session =
      R"({"event":"Customized","data":{"type":"ListSession"}})";
  ASSERT_TRUE(SendAll(sock_b, PackFrame(init_b) + PackFrame(list_session)));

  ASSERT_TRUE(
      listener_->WaitForStatusCount(kConnected, connected_before_b + 1, 3000));
  ASSERT_TRUE(listener_->WaitForMessages(messages_before_b + 2, 3000));
  EXPECT_EQ(listener_->StatusCount(kError), error_before_b);

  std::vector<std::string> messages = listener_->Messages();
  ASSERT_GE(messages.size(), messages_before_b + 2);
  EXPECT_EQ(messages[messages.size() - 2], init_b);
  EXPECT_EQ(messages[messages.size() - 1], list_session);

  close(sock_b);
  ASSERT_TRUE(listener_->WaitForStatusCount(kDisconnected,
                                            disconnected_before_b + 1, 3000));
  EXPECT_EQ(listener_->StatusCount(kError), error_before_b);
}

TEST_F(UsbReconnectIntegrationTest, StressNoWaitReconnect) {
  const int num_reconnects = 20;
  const std::string init_msg = R"({"event":"Initialize","data":-1})";
  const std::string cmd_msg =
      R"({"event":"Customized","data":{"type":"ListSession"}})";

  int expected_messages = 0;

  for (int i = 0; i < num_reconnects; i++) {
    int sock = ConnectToPort(port_);
    if (sock < 0) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      sock = ConnectToPort(port_);
    }
    ASSERT_GE(sock, 0) << "Failed to connect on iteration " << i;

    std::string bulk;
    bulk += PackFrame(init_msg);
    expected_messages++;
    for (int j = 0; j < 3; j++) {
      bulk += PackFrame(cmd_msg);
      expected_messages++;
    }
    ASSERT_TRUE(SendAll(sock, bulk));

    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    close(sock);
  }

  const bool got_all = listener_->WaitForMessages(expected_messages, 15000);
  const std::vector<std::string> all_msgs = listener_->Messages();
  std::cout << "Stress test: Expected " << expected_messages
            << " messages, got " << all_msgs.size() << std::endl;

  EXPECT_TRUE(got_all) << "Expected " << expected_messages
                       << " messages but got " << all_msgs.size()
                       << ". Messages were dropped during stress reconnect "
                          "test.";
}

}  // namespace
}  // namespace socket_server
}  // namespace debugrouter
