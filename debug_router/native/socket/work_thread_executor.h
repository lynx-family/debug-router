// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_WORK_THREAD_EXECUTOR_H
#define DEBUGROUTER_NATIVE_SOCKET_WORK_THREAD_EXECUTOR_H

#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <queue>
#include <thread>

namespace debugrouter {
namespace base {
class WorkThreadExecutor {
 public:
  WorkThreadExecutor();
  ~WorkThreadExecutor();

  void submit(std::function<void()> task);
  void shutdown();

 private:
  void run();

  std::atomic<bool> is_shut_down;
  std::unique_ptr<std::thread> worker;
  std::queue<std::function<void()>> tasks;
  std::mutex task_mtx;
  std::mutex worker_mtx;
  std::condition_variable cond;
};

}  // namespace base
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_WORK_THREAD_EXECUTOR_H
