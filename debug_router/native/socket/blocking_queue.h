// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_BLOCKING_QUEUE_H_
#define DEBUGROUTER_NATIVE_SOCKET_BLOCKING_QUEUE_H_

#include <condition_variable>
#include <iostream>
#include <mutex>
#include <queue>
#include <string>

namespace debugrouter {
namespace socket_server {

template <typename T>
class BlockingQueue {
 public:
  void put(T&& value) {
    std::unique_lock<std::mutex> lock(mutex_);
    queue_.push(std::move(value));
    cond_var_.notify_one();
  }

  T take() {
    std::unique_lock<std::mutex> lock(mutex_);
    cond_var_.wait(lock, [this] { return !queue_.empty(); });
    T value = queue_.front();
    queue_.pop();
    return value;
  }

  void clear() {
    std::unique_lock<std::mutex> lock(mutex_);
    std::queue<T> empty;
    std::swap(queue_, empty);
  }

 private:
  std::queue<T> queue_;
  mutable std::mutex mutex_;
  std::condition_variable cond_var_;
};

}  // namespace socket_server
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_BLOCKING_QUEUE_H_
