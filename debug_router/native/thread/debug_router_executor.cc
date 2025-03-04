// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/thread/debug_router_executor.h"

#include <iostream>

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

ThreadLooper::ThreadLooper()
    : keep_running_(true),
      working_queue_(std::make_shared<std::queue<std::function<void()>>>()),
      incoming_queue_(std::make_shared<std::queue<std::function<void()>>>()) {}

void ThreadLooper::Run() {
  while (keep_running_) {
    if (!working_queue_->empty()) {
      auto work = working_queue_->front();
      working_queue_->pop();
      work();
    } else if (!incoming_queue_->empty()) {
      std::lock_guard<std::mutex> lock(incoming_queue_lock_);
      working_queue_.swap(incoming_queue_);
    } else {
      std::unique_lock<std::mutex> lock(condition_lock_);
      condition_.wait(lock);
    }
  }
}

void ThreadLooper::Stop() {
  keep_running_ = false;
  condition_.notify_one();
}

void ThreadLooper::Post(std::function<void()> work) {
  {
    std::lock_guard<std::mutex> lock(incoming_queue_lock_);
    incoming_queue_->push(work);
  }
  condition_.notify_one();
}

}  // namespace thread
}  // namespace debugrouter
