// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/count_down_latch.h"

#include <thread>

#include "gtest/gtest.h"

TEST(CountDownLatchTestSuite, TestZero) {
  debugrouter::socket_server::CountDownLatch latch(0);
  latch.Await();
}

std::mutex mutex_;

void Foo(int &global_count, debugrouter::socket_server::CountDownLatch &latch) {
  std::lock_guard<std::mutex> guard(mutex_);
  global_count++;
  latch.CountDown();
}

TEST(CountDownLatchTestSuite, TestLatch) {
  int global_count = 0;
  int thread_count = 3;
  debugrouter::socket_server::CountDownLatch latch(thread_count);
  for (int i = 0; i < thread_count; i++) {
    std::thread thread(Foo, std::ref(global_count), std::ref(latch));
    thread.detach();
  }
  latch.Await();
  EXPECT_EQ(global_count, thread_count);
}
