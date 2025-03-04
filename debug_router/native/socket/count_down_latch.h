// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_COUNT_DOWN_LATCH_H_
#define DEBUGROUTER_NATIVE_SOCKET_COUNT_DOWN_LATCH_H_

#include <condition_variable>
#include <cstdint>
#include <mutex>

namespace debugrouter {
namespace socket_server {

class CountDownLatch {
 public:
  explicit CountDownLatch(uint32_t count);

  void CountDown();

  void Await();

 private:
  std::mutex mutex_;
  std::condition_variable condition_variable_;
  uint32_t count_;
};

}  // namespace socket_server
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_COUNT_DOWN_LATCH_H_
