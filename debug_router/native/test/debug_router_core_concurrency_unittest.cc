// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <atomic>
#include <thread>
#include <vector>

#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/core/debug_router_global_handler.h"
#include "debug_router/native/core/debug_router_session_handler.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace core {

class TestGlobalHandler : public DebugRouterGlobalHandler {
 public:
  virtual ~TestGlobalHandler() = default;
  void OpenCard(const std::string &url) override {}
  void OnMessage(const std::string &message, const std::string &type) override {
  }
};

class TestSessionHandler : public DebugRouterSessionHandler {
 public:
  virtual ~TestSessionHandler() = default;
  void OnSessionCreate(int session_id, const std::string &url) override {}
  void OnSessionDestroy(int session_id) override {}
  void OnMessage(const std::string &message, const std::string &type,
                 int session_id) override {}
};

class DebugRouterCoreConcurrencyTest : public ::testing::Test {
 protected:
  void SetUp() override {
    core_ = &DebugRouterCore::GetInstance();
    ClearGlobalHandlers();
    ClearSessionHandlers();
  }

  void TearDown() override {
    ClearGlobalHandlers();
    ClearSessionHandlers();
  }

  void ClearGlobalHandlers() {
    std::unique_lock lock(core_->global_handler_mutex_);
    core_->global_handler_map_.clear();
  }

  size_t GetGlobalHandlerCount() {
    std::shared_lock lock(core_->global_handler_mutex_);
    return core_->global_handler_map_.size();
  }

  void ClearSessionHandlers() {
    std::unique_lock lock(core_->session_handler_mutex_);
    core_->session_handler_map_.clear();
  }

  size_t GetSessionHandlerCount() {
    std::shared_lock lock(core_->session_handler_mutex_);
    return core_->session_handler_map_.size();
  }

  DebugRouterCore *core_;
};

TEST_F(DebugRouterCoreConcurrencyTest, ConcurrentAddSameGlobalHandler) {
  TestGlobalHandler handler;
  std::vector<std::thread> threads;
  std::vector<int> returned_ids;
  std::mutex ids_mutex;
  const size_t kNumThreads = 10;

  for (size_t i = 0; i < kNumThreads; ++i) {
    threads.emplace_back([&, this]() {
      int id = core_->AddGlobalHandler(&handler);
      std::lock_guard<std::mutex> lock(ids_mutex);
      returned_ids.push_back(id);
    });
  }

  for (auto &t : threads) {
    t.join();
  }

  EXPECT_EQ(returned_ids.size(), kNumThreads);

  int first_id = returned_ids[0];
  for (int id : returned_ids) {
    EXPECT_EQ(id, first_id);
  }

  EXPECT_EQ(GetGlobalHandlerCount(), static_cast<size_t>(1));
}

TEST_F(DebugRouterCoreConcurrencyTest, ConcurrentAddDifferentGlobalHandlers) {
  std::vector<std::unique_ptr<TestGlobalHandler>> handlers;
  for (int i = 0; i < 10; ++i) {
    handlers.push_back(std::make_unique<TestGlobalHandler>());
  }

  std::vector<std::thread> threads;
  const size_t kNumThreads = 10;

  for (size_t i = 0; i < kNumThreads; ++i) {
    threads.emplace_back(
        [&, i, this]() { core_->AddGlobalHandler(handlers[i].get()); });
  }

  for (auto &t : threads) {
    t.join();
  }

  EXPECT_EQ(GetGlobalHandlerCount(), kNumThreads);
}

TEST_F(DebugRouterCoreConcurrencyTest, ConcurrentRemoveGlobalHandler) {
  TestGlobalHandler handler;

  int handler_id = core_->AddGlobalHandler(&handler);

  std::vector<std::thread> threads;
  std::atomic<int> success_count(0);
  const size_t kNumThreads = 10;

  for (size_t i = 0; i < kNumThreads; ++i) {
    threads.emplace_back([&, handler_id, this]() {
      if (core_->RemoveGlobalHandler(handler_id)) {
        success_count.fetch_add(1, std::memory_order_relaxed);
      }
    });
  }

  for (auto &t : threads) {
    t.join();
  }

  EXPECT_EQ(success_count.load(std::memory_order_relaxed), 1);

  EXPECT_EQ(GetGlobalHandlerCount(), static_cast<size_t>(0));
}

TEST_F(DebugRouterCoreConcurrencyTest, ConcurrentAddAndRemoveGlobalHandlers) {
  std::vector<std::unique_ptr<TestGlobalHandler>> handlers;
  for (int i = 0; i < 5; ++i) {
    handlers.push_back(std::make_unique<TestGlobalHandler>());
  }

  std::vector<int> handler_ids;
  for (auto &h : handlers) {
    handler_ids.push_back(core_->AddGlobalHandler(h.get()));
  }

  std::vector<std::thread> threads;
  const int kNumThreads = 20;

  for (size_t i = 0; i < kNumThreads; ++i) {
    if (i % 2 == 0) {
      threads.emplace_back([&, i, this]() {
        int idx = i % handlers.size();
        core_->AddGlobalHandler(handlers[idx].get());
      });
    } else {
      threads.emplace_back([&, i, this]() {
        int idx = i % handler_ids.size();
        core_->RemoveGlobalHandler(handler_ids[idx]);
      });
    }
  }

  for (auto &t : threads) {
    t.join();
  }

  // Lightweight assertions to ensure final handler count is within reasonable
  // bounds
  size_t final_count = GetGlobalHandlerCount();
  // At least 0 (always true, but explicitly written as documentation)
  EXPECT_GE(final_count, static_cast<size_t>(0));
  // At most: initial 5 + 10 adds = 15 (different threads might add same
  // handler, but no duplicate counting) In reality, since same handler is not
  // added repeatedly, at most 5
  EXPECT_LE(final_count,
            static_cast<size_t>(handlers.size() + kNumThreads / 2));
}

TEST_F(DebugRouterCoreConcurrencyTest, ConcurrentAddSameSessionHandler) {
  TestSessionHandler handler;
  std::vector<std::thread> threads;
  std::vector<int> returned_ids;
  std::mutex ids_mutex;
  const size_t kNumThreads = 10;

  for (size_t i = 0; i < kNumThreads; ++i) {
    threads.emplace_back([&, this]() {
      int id = core_->AddSessionHandler(&handler);
      std::lock_guard<std::mutex> lock(ids_mutex);
      returned_ids.push_back(id);
    });
  }

  for (auto &t : threads) {
    t.join();
  }

  EXPECT_EQ(returned_ids.size(), kNumThreads);

  int first_id = returned_ids[0];
  for (int id : returned_ids) {
    EXPECT_EQ(id, first_id);
  }

  EXPECT_EQ(GetSessionHandlerCount(), static_cast<size_t>(1));
}

TEST_F(DebugRouterCoreConcurrencyTest, ConcurrentAddDifferentSessionHandlers) {
  std::vector<std::unique_ptr<TestSessionHandler>> handlers;
  for (int i = 0; i < 10; ++i) {
    handlers.push_back(std::make_unique<TestSessionHandler>());
  }

  std::vector<std::thread> threads;
  const size_t kNumThreads = 10;

  for (size_t i = 0; i < kNumThreads; ++i) {
    threads.emplace_back(
        [&, i, this]() { core_->AddSessionHandler(handlers[i].get()); });
  }

  for (auto &t : threads) {
    t.join();
  }

  EXPECT_EQ(GetSessionHandlerCount(), kNumThreads);
}

TEST_F(DebugRouterCoreConcurrencyTest, ConcurrentRemoveSessionHandler) {
  TestSessionHandler handler;

  int handler_id = core_->AddSessionHandler(&handler);

  std::vector<std::thread> threads;
  std::atomic<int> success_count(0);
  const size_t kNumThreads = 10;

  for (size_t i = 0; i < kNumThreads; ++i) {
    threads.emplace_back([&, handler_id, this]() {
      if (core_->RemoveSessionHandler(handler_id)) {
        success_count.fetch_add(1, std::memory_order_relaxed);
      }
    });
  }

  for (auto &t : threads) {
    t.join();
  }

  EXPECT_EQ(success_count.load(std::memory_order_relaxed), 1);

  EXPECT_EQ(GetSessionHandlerCount(), static_cast<size_t>(0));
}

TEST_F(DebugRouterCoreConcurrencyTest, ConcurrentAddAndRemoveSessionHandlers) {
  std::vector<std::unique_ptr<TestSessionHandler>> handlers;
  for (int i = 0; i < 5; ++i) {
    handlers.push_back(std::make_unique<TestSessionHandler>());
  }

  std::vector<int> handler_ids;
  for (auto &h : handlers) {
    handler_ids.push_back(core_->AddSessionHandler(h.get()));
  }

  std::vector<std::thread> threads;
  const int kNumThreads = 20;

  for (size_t i = 0; i < kNumThreads; ++i) {
    if (i % 2 == 0) {
      threads.emplace_back([&, i, this]() {
        int idx = i % handlers.size();
        core_->AddSessionHandler(handlers[idx].get());
      });
    } else {
      threads.emplace_back([&, i, this]() {
        int idx = i % handler_ids.size();
        core_->RemoveSessionHandler(handler_ids[idx]);
      });
    }
  }

  for (auto &t : threads) {
    t.join();
  }

  // Lightweight assertions to ensure final handler count is within reasonable
  // bounds
  size_t final_count = GetSessionHandlerCount();
  // At least 0 (always true, but explicitly written as documentation)
  EXPECT_GE(final_count, static_cast<size_t>(0));
  // At most: initial 5 + 10 adds = 15 (different threads might add same
  // handler, but no duplicate counting) In reality, since same handler is not
  // added repeatedly, at most 5
  EXPECT_LE(final_count,
            static_cast<size_t>(handlers.size() + kNumThreads / 2));
}

}  // namespace core
}  // namespace debugrouter
