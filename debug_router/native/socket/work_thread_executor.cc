// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/work_thread_executor.h"

namespace debugrouter {
namespace base {

WorkThreadExecutor::WorkThreadExecutor() : is_shut_down(false) {
  worker = std::make_unique<std::thread>([this]() { run(); });
}

WorkThreadExecutor::~WorkThreadExecutor() { shutdown(); }

void WorkThreadExecutor::submit(std::function<void()> task) {
  if (is_shut_down) {
    return;
  }
  std::lock_guard<std::mutex> lock(task_mtx);
  tasks.push(task);
  cond.notify_one();
}

void WorkThreadExecutor::shutdown() {
  std::lock_guard<std::mutex> lock(worker_mtx);
  is_shut_down = true;
  cond.notify_one();
  if (worker) {
    if (worker->joinable()) {
      worker->join();
    }
    worker.reset();
  }
}

void WorkThreadExecutor::run() {
  while (!is_shut_down) {
    std::unique_lock<std::mutex> lock(task_mtx);
    cond.wait(lock, [this] { return !tasks.empty() || is_shut_down; });
    if (!tasks.empty()) {
      auto task = tasks.front();
      tasks.pop();
      lock.unlock();
      task();
    }
  }
}

}  // namespace base
}  // namespace debugrouter
