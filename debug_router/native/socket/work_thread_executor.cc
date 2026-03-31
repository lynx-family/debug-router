// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/work_thread_executor.h"

#include "debug_router/native/log/logging.h"

namespace debugrouter {
namespace base {

WorkThreadExecutor::WorkThreadExecutor()
    : is_shut_down(false), alive_flag(std::make_shared<bool>(true)) {}

void WorkThreadExecutor::init() {
  std::lock_guard<std::mutex> lock(task_mtx);
  if (!worker) {
    worker = std::make_unique<std::thread>([this]() { run(); });
  }
}

WorkThreadExecutor::~WorkThreadExecutor() { shutdown(); }

void WorkThreadExecutor::submit(std::function<void()> task) {
  if (is_shut_down) {
    return;
  }
  std::lock_guard<std::mutex> lock(task_mtx);
  if (is_shut_down) {
    return;
  }
  tasks.push(task);
  cond.notify_one();
}

void WorkThreadExecutor::shutdown() {
  std::shared_ptr<std::thread> worker_ptr;
  {
    std::lock_guard<std::mutex> lock(task_mtx);
    if (is_shut_down) {
      return;
    }
    is_shut_down = true;
    std::queue<std::function<void()>> empty;
    tasks.swap(empty);
    worker_ptr = std::move(worker);  // take ownership of worker
  }
  cond.notify_all();

  if (worker_ptr && worker_ptr->joinable()) {
#if __cpp_exceptions >= 199711L
    try {
#endif
      if (worker_ptr->get_id() != std::this_thread::get_id()) {
        worker_ptr->join();
        LOGI("WorkThreadExecutor::shutdown worker->join() success.");
      } else {
        worker_ptr->detach();
        LOGI("WorkThreadExecutor::shutdown worker->detach() success.");
      }
#if __cpp_exceptions >= 199711L
    } catch (const std::exception& e) {
      LOGE("WorkThreadExecutor::shutdown worker->detach() failed, "
           << e.what());
    }
#endif
  }
  LOGI("WorkThreadExecutor::shutdown success.");
}

void WorkThreadExecutor::run() {
  std::weak_ptr<bool> weak_flag = alive_flag;
  while (true) {
    auto flag = weak_flag.lock();
    if (!flag) {
      break;
    }
    if (is_shut_down) {
      break;
    }
    std::unique_lock<std::mutex> lock(task_mtx);
    cond.wait(lock, [this] { return !tasks.empty() || is_shut_down; });
    if (is_shut_down) {
      break;
    }
    if (!tasks.empty()) {
      auto task = tasks.front();
      tasks.pop();
      lock.unlock();
      if (is_shut_down) {
        break;
      }
      task();
      LOGI("WorkThreadExecutor::run task() success.");
    }
  }
}

}  // namespace base
}  // namespace debugrouter
