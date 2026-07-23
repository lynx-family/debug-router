// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/work_thread_executor.h"

#include "debug_router/native/log/logging.h"

namespace debugrouter {
namespace base {

WorkThreadExecutor::WorkThreadExecutor()
    : state_(std::make_shared<SharedState>()) {}

void WorkThreadExecutor::init() {
  if (state_->is_shut_down.load(std::memory_order_acquire)) {
    return;
  }
  std::lock_guard<std::mutex> lock(state_->task_mtx);
  if (state_->is_shut_down.load(std::memory_order_acquire)) {
    return;
  }
  if (!worker) {
    worker = std::make_unique<std::thread>(
        [state = state_]() { WorkThreadExecutor::run(state); });
  }
}

WorkThreadExecutor::~WorkThreadExecutor() { shutdown(); }

void WorkThreadExecutor::submit(std::function<void()> task) {
  if (state_->is_shut_down.load(std::memory_order_acquire)) {
    return;
  }
  std::lock_guard<std::mutex> lock(state_->task_mtx);
  if (state_->is_shut_down.load(std::memory_order_acquire)) {
    return;
  }
  state_->tasks.push(std::move(task));
  state_->cond.notify_one();
}

void WorkThreadExecutor::shutdown() {
  bool expected = false;
  if (!state_->is_shut_down.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel,
          std::memory_order_acquire)) {
    return;
  }

  std::unique_ptr<std::thread> worker_ptr;
  {
    std::lock_guard<std::mutex> lock(state_->task_mtx);
    std::queue<std::function<void()>> empty;
    state_->tasks.swap(empty);
    worker_ptr = std::move(worker);
  }
  state_->cond.notify_all();

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

void WorkThreadExecutor::run(const std::shared_ptr<SharedState>& state) {
  while (true) {
    if (state->is_shut_down.load(std::memory_order_acquire)) {
      break;
    }

    std::function<void()> task;
    {
      std::unique_lock<std::mutex> lock(state->task_mtx);
      state->cond.wait(lock, [state] {
        return !state->tasks.empty() ||
               state->is_shut_down.load(std::memory_order_acquire);
      });
      if (state->is_shut_down.load(std::memory_order_acquire)) {
        break;
      }
      if (state->tasks.empty()) {
        continue;
      }
      task = std::move(state->tasks.front());
      state->tasks.pop();
    }

#if __cpp_exceptions >= 199711L
    try {
#endif
      task();
      LOGI("WorkThreadExecutor::run task() success.");
#if __cpp_exceptions >= 199711L
    } catch (const std::exception& e) {
      LOGE("WorkThreadExecutor::run task() failed, " << e.what());
    } catch (...) {
      LOGE("WorkThreadExecutor::run task() failed with unknown exception");
    }
#endif
  }
}

}  // namespace base
}  // namespace debugrouter
