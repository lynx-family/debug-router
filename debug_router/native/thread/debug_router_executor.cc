// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/thread/debug_router_executor.h"

#include <iostream>
#include <utility>

namespace debugrouter {
namespace thread {

DebugRouterExecutor::DebugRouterExecutor()
    : is_running_(false), looper_(std::make_shared<ThreadLooper>()) {}

DebugRouterExecutor &DebugRouterExecutor::GetInstance() {
  static base::NoDestructor<DebugRouterExecutor> instance;
  return *instance;
}

void DebugRouterExecutor::Start() {
  if (thread_.joinable()) {
    thread_.join();
  }
  if (!is_running_) {
    is_running_ = true;
    thread_ = std::thread([=]() { looper_->Run(); });
  }
}

void DebugRouterExecutor::Quit() {
  is_running_ = false;
  looper_->Stop();
  if (thread_.joinable()) {
    thread_.join();
  }
}

void DebugRouterExecutor::Post(std::function<void()> work, bool run_now) {
  if (run_now && std::this_thread::get_id() == thread_.get_id()) {
    work();
    return;
  }
  looper_->Post(work);
}

ThreadLooper::ThreadLooper() : keep_running_(true) {}

void ThreadLooper::Run() {
  while (true) {
    std::function<void()> work;
    {
      std::unique_lock<std::mutex> lock(queue_lock_);
      condition_.wait(lock,
                      [this]() { return !keep_running_ || !queue_.empty(); });
      if (!keep_running_) {
        return;
      }
      work = std::move(queue_.front());
      queue_.pop();
    }
    work();
  }
}

void ThreadLooper::Stop() {
  {
    std::lock_guard<std::mutex> lock(queue_lock_);
    keep_running_ = false;
  }
  condition_.notify_one();
}

void ThreadLooper::Post(std::function<void()> work) {
  {
    std::lock_guard<std::mutex> lock(queue_lock_);
    queue_.push(std::move(work));
  }
  condition_.notify_one();
}

}  // namespace thread
}  // namespace debugrouter
