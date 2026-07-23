// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/work_thread_executor.h"

#include <future>
#include <memory>

#include "gtest/gtest.h"

namespace debugrouter {
namespace base {
namespace {

TEST(WorkThreadExecutorTestSuite, SelfShutdownFromWorkerReturns) {
  auto executor = std::make_shared<WorkThreadExecutor>();
  executor->init();

  auto done = std::make_shared<std::promise<void>>();
  std::future<void> finished = done->get_future();

  executor->submit([executor, done]() mutable {
    executor->shutdown();
    done->set_value();
  });

  EXPECT_EQ(finished.wait_for(std::chrono::seconds(2)),
            std::future_status::ready);
}

}  // namespace
}  // namespace base
}  // namespace debugrouter
