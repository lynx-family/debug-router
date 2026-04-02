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
// WorkThreadExecutor is a single-worker serial executor.
//
// NOTE: The worker thread is detached. `shutdown()` signals the worker to exit
// and drops pending tasks, but it does NOT wait for the currently running task
// to finish.
//
// Usage contract:
// - Call `init()` before `submit()`.
// - After `shutdown()`, the executor cannot be restarted; further `init()` or
//   `submit()` calls are no-ops.
// - Tasks MUST NOT capture a bare `this`, raw pointers, or references that may
//   become invalid before execution. Prefer capturing `std::shared_ptr` to keep
//   the target alive, or capture a `std::weak_ptr` and lock it inside the task.
// - Avoid capturing references to stack variables (including references/Views
//   like `std::string_view` or `span` pointing to stack memory).
// - Keep tasks short and non-blocking. Avoid long-running CPU loops or blocking
//   I/O unless you can guarantee timely cancellation/timeout handling.

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
