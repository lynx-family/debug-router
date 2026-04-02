// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_WORK_THREAD_EXECUTOR_H_
#define DEBUGROUTER_NATIVE_SOCKET_WORK_THREAD_EXECUTOR_H_

#include <atomic>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <queue>
#include <thread>

namespace debugrouter {
namespace base {
class WorkThreadExecutor {
 public:
  WorkThreadExecutor();
  virtual ~WorkThreadExecutor();

  void init();
  void submit(std::function<void()> task);
  void shutdown();

 private:
  struct SharedState {
    std::atomic<bool> is_shut_down{false};
    std::queue<std::function<void()>> tasks;
    std::mutex task_mtx;
    std::condition_variable cond;
  };

  static void run(std::shared_ptr<SharedState> state);

  std::shared_ptr<SharedState> state_;
  std::unique_ptr<std::thread> worker;
};

}  // namespace base
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_WORK_THREAD_EXECUTOR_H_
