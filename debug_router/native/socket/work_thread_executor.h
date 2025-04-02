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
  virtual ~WorkThreadExecutor();

  void init();
  void submit(std::function<void()> task);
  void shutdown();

 private:
  void run();

  std::atomic<bool> is_shut_down;
  std::unique_ptr<std::thread> worker;
  std::queue<std::function<void()>> tasks;
  std::mutex task_mtx;
  std::condition_variable cond;
  // If WorkThreadExecutor automatically destroys itself after reaching
  // detach(), the run function in the thread will crash because it tries to
  // lock the variable that has been destroyed.
  //
  // Therefore, this std::shared_ptr<bool> alive_flag can be used to show
  // whether the object has been destroyed. If it has been destroyed, exit early
  // to avoid crash.
  std::shared_ptr<bool> alive_flag;
};

}  // namespace base
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_WORK_THREAD_EXECUTOR_H
