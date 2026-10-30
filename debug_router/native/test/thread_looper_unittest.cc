// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <atomic>
#include <future>
#include <memory>
#include <thread>
#include <vector>

#include "debug_router/native/thread/debug_router_executor.h"
#include "gtest/gtest.h"

namespace debugrouter {
namespace thread {

// Completion events establish ordering; CI bounds hangs with its step timeout.
// Scheduler latency is not a test assertion.
TEST(ThreadLooperTest, ProcessesPrequeuedTasksInOrder) {
  ThreadLooper looper;
  std::vector<int> seen;
  looper.Post([&]() { seen.push_back(1); });
  looper.Post([&]() { seen.push_back(2); });
  looper.Post([&]() {
    seen.push_back(3);
    looper.Stop();
  });
  looper.Run();
  EXPECT_EQ(seen, (std::vector<int>{1, 2, 3}));
}

TEST(ThreadLooperTest, StopBeforeRunDiscardsQueuedTasks) {
  ThreadLooper looper;
  bool ran = false;
  looper.Post([&]() { ran = true; });
  looper.Stop();
  looper.Run();
  EXPECT_FALSE(ran);
}

TEST(ThreadLooperTest, CallbackCanPostWithoutHoldingQueueLock) {
  ThreadLooper looper;
  std::vector<int> seen;
  looper.Post([&]() {
    seen.push_back(1);
    looper.Post([&]() {
      seen.push_back(3);
      looper.Stop();
    });
  });
  looper.Post([&]() { seen.push_back(2); });
  looper.Run();
  EXPECT_EQ(seen, (std::vector<int>{1, 2, 3}));
}

TEST(ThreadLooperTest, StopDuringCallbackDiscardsPendingTasks) {
  ThreadLooper looper;
  std::promise<void> entered;
  auto ready = entered.get_future();
  std::promise<void> release;
  auto released = release.get_future();
  bool pending_ran = false;
  looper.Post([&]() {
    entered.set_value();
    released.wait();
  });
  looper.Post([&]() { pending_ran = true; });
  std::thread worker([&]() { looper.Run(); });

  ready.wait();
  looper.Stop();
  release.set_value();
  worker.join();
  EXPECT_FALSE(pending_ran);
}

// Exercise the return-to-idle boundary without assuming a particular schedule.
// These stress cases complement the ordered semantics above; they do not force
// the historical empty-check -> wait interleaving on every run.
TEST(ThreadLooperTest, PostsAcrossIdleBoundaryComplete) {
  ThreadLooper looper;
  std::thread worker([&]() { looper.Run(); });
  std::atomic<int> spin_sink{0};
  for (int i = 0; i < 4000; ++i) {
    std::promise<void> entered;
    auto ready = entered.get_future();
    std::atomic<bool> release{false};
    looper.Post([&]() {
      entered.set_value();
      while (!release.load(std::memory_order_acquire)) {
        std::this_thread::yield();
      }
    });
    ready.wait();
    auto completed = std::make_shared<std::promise<void>>();
    auto done = completed->get_future();
    release.store(true, std::memory_order_release);
    for (int spin = 0; spin < (i & 255); ++spin) {
      spin_sink.store(spin, std::memory_order_relaxed);
    }
    looper.Post([completed]() { completed->set_value(); });
    done.wait();
  }
  looper.Stop();
  worker.join();
}

TEST(ThreadLooperTest, StopsAcrossIdleBoundaryComplete) {
  for (int i = 0; i < 500; ++i) {
    ThreadLooper looper;
    std::promise<void> entered;
    auto ready = entered.get_future();
    std::promise<void> release;
    auto released = release.get_future();
    looper.Post([&]() {
      entered.set_value();
      released.wait();
    });
    std::thread worker([&]() { looper.Run(); });
    ready.wait();
    release.set_value();
    looper.Stop();
    worker.join();
  }
}

TEST(ThreadLooperTest, ConcurrentProducersExecuteEveryTask) {
  ThreadLooper looper;
  constexpr int kProducers = 8;
  constexpr int kTasks = 1000;
  std::vector<int> completed(kProducers);
  std::thread worker([&]() { looper.Run(); });
  std::vector<std::thread> producers;
  for (int producer = 0; producer < kProducers; ++producer) {
    producers.emplace_back([&, producer]() {
      for (int task = 0; task < kTasks; ++task) {
        looper.Post([&, producer]() { ++completed[producer]; });
      }
    });
  }
  for (auto& producer : producers) {
    producer.join();
  }
  looper.Post([&]() { looper.Stop(); });
  worker.join();
  EXPECT_EQ(completed, std::vector<int>(kProducers, kTasks));
}

}  // namespace thread
}  // namespace debugrouter
