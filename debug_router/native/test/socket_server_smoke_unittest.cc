// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <atomic>
#include <memory>
#include <string>
#include <thread>

#include "debug_router/native/socket/count_down_latch.h"
#include "debug_router/native/socket/socket_server_api.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace socket_server {
namespace {

class NoopSocketServerListener final : public SocketServerConnectionListener {
 public:
  void OnInit(int32_t, const std::string&) override {}
  void OnStatusChanged(ConnectionStatus, int32_t, const std::string&) override {
  }
  void OnMessage(const std::string&) override {}
};

class BarrierSocketServer final : public SocketServer {
 public:
  explicit BarrierSocketServer(
      const std::shared_ptr<SocketServerConnectionListener>& listener)
      : SocketServer(listener) {}
  ~BarrierSocketServer() override { StopServer(); }

  void WaitUntilStartEntered(int generation) {
    StartEntered(generation).Await();
  }
  void WaitUntilClose(int generation) { CloseCalled(generation).Await(); }
  void ReleaseStart(int generation) { ReleaseLatch(generation).CountDown(); }
  SocketType PublishedSocket() const {
    return socket_fd_.load(std::memory_order_acquire);
  }

 private:
  void Start() override {
    const int generation = start_count_.fetch_add(1, std::memory_order_relaxed);
    StartEntered(generation).CountDown();
    ReleaseLatch(generation).Await();
    TryPublishSocket(123 + generation);
  }

  int GetErrorMessage() override { return 0; }

  void CloseSocket(int) override {
    const int generation = close_count_.fetch_add(1, std::memory_order_relaxed);
    CloseCalled(generation).CountDown();
  }

  CountDownLatch& StartEntered(int generation) {
    return generation == 0 ? first_start_entered_ : second_start_entered_;
  }
  CountDownLatch& ReleaseLatch(int generation) {
    return generation == 0 ? release_first_start_ : release_second_start_;
  }
  CountDownLatch& CloseCalled(int generation) {
    return generation == 0 ? first_close_called_ : second_close_called_;
  }

  std::atomic<int> start_count_{0};
  std::atomic<int> close_count_{0};
  CountDownLatch first_start_entered_{1};
  CountDownLatch second_start_entered_{1};
  CountDownLatch release_first_start_{1};
  CountDownLatch release_second_start_{1};
  CountDownLatch first_close_called_{1};
  CountDownLatch second_close_called_{1};
};

TEST(SocketServerSmokeTestSuite,
     ConstructAndImmediateDestroyWithoutStartDoesNotCrash) {
  ASSERT_EXIT(
      {
        auto listener = std::make_shared<NoopSocketServerListener>();
        auto server = SocketServer::CreateSocketServer(listener);
        server.reset();
        _exit(0);
      },
      ::testing::ExitedWithCode(0), "");
}

TEST(SocketServerSmokeTestSuite,
     StopCompletesAndRejectsPreStopListenerGeneration) {
  auto listener = std::make_shared<NoopSocketServerListener>();
  auto server = std::make_shared<BarrierSocketServer>(listener);
  std::weak_ptr<SocketServer> weak_server = server;

  server->Init();
  server->StartServer();
  server->WaitUntilStartEntered(0);
  std::thread stop_thread(&SocketServer::StopServer, server);
  server->WaitUntilClose(0);
  server->ReleaseStart(0);
  stop_thread.join();

  EXPECT_EQ(server->PublishedSocket(), kInvalidSocket);
  server.reset();

  EXPECT_TRUE(weak_server.expired());
}

TEST(SocketServerSmokeTestSuite, StartCreatesNewListenerAfterStop) {
  auto listener = std::make_shared<NoopSocketServerListener>();
  auto server = std::make_shared<BarrierSocketServer>(listener);
  server->Init();

  server->StartServer();
  server->WaitUntilStartEntered(0);
  std::thread first_stop(&SocketServer::StopServer, server);
  server->WaitUntilClose(0);
  server->ReleaseStart(0);
  first_stop.join();

  server->StartServer();
  server->WaitUntilStartEntered(1);
  std::thread second_stop(&SocketServer::StopServer, server);
  server->WaitUntilClose(1);
  server->ReleaseStart(1);
  second_stop.join();

  EXPECT_EQ(server->PublishedSocket(), kInvalidSocket);
}

}  // namespace
}  // namespace socket_server
}  // namespace debugrouter
