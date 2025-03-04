// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_THREAD_DEBUG_ROUTER_EXECUTOR_H_
#define DEBUGROUTER_NATIVE_THREAD_DEBUG_ROUTER_EXECUTOR_H_

#include <condition_variable>
#include <functional>
#include <queue>
#include <thread>

#include "debug_router/native/base/no_destructor.h"

namespace debugrouter {
namespace thread {

class ThreadLooper;

/*
 * All the actions inside DebugRouter will be executed on DebugRouterExecutor.
 *
 */
class DebugRouterExecutor {
 public:
  static DebugRouterExecutor &GetInstance();
  void Start();
  void Quit();
  void Post(std::function<void()> work, bool run_now = true);

 private:
  DebugRouterExecutor();
  friend class base::NoDestructor<DebugRouterExecutor>;

  volatile bool is_running_;
  std::thread thread_;
  std::shared_ptr<ThreadLooper> looper_;
};

class ThreadLooper {
 public:
  explicit ThreadLooper();
  ~ThreadLooper() = default;
  void Post(std::function<void()> work);
  void Run();
  void Stop();

 private:
  volatile bool keep_running_;
  std::shared_ptr<std::queue<std::function<void()>>> working_queue_;
  std::shared_ptr<std::queue<std::function<void()>>> incoming_queue_;
  std::mutex incoming_queue_lock_;
  std::condition_variable_any condition_;
  std::mutex condition_lock_;
};

}  // namespace thread
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_THREAD_DEBUG_ROUTER_EXECUTOR_H_
