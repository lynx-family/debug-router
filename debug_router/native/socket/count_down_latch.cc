// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/count_down_latch.h"

namespace debugrouter {
namespace socket_server {
CountDownLatch::CountDownLatch(uint32_t count) : count_(count) {}

void CountDownLatch::CountDown() {
  std::lock_guard<std::mutex> guard(mutex_);
  if (count_ == 0) {
    return;
  }
  count_--;
  if (count_ == 0) {
    condition_variable_.notify_all();
  }
}

void CountDownLatch::Await() {
  std::unique_lock<std::mutex> lock(mutex_);
  while (count_ != 0) {
    condition_variable_.wait(lock);
  }
}

}  // namespace socket_server
}  // namespace debugrouter
