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
  if (state_->is_shut_down) {
    return;
  }
  std::lock_guard<std::mutex> lock(state_->task_mtx);
  if (state_->is_shut_down) {
    return;
  }
  if (!worker) {
    worker = std::make_unique<std::thread>(
        [state = state_]() { WorkThreadExecutor::run(state); });
  }
}

WorkThreadExecutor::~WorkThreadExecutor() { shutdown(); }

void WorkThreadExecutor::submit(std::function<void()> task) {
  if (state_->is_shut_down) {
    return;
  }
  std::lock_guard<std::mutex> lock(state_->task_mtx);
  if (state_->is_shut_down) {
    return;
  }
  state_->tasks.push(task);
  state_->cond.notify_one();
}

void WorkThreadExecutor::shutdown() {
  std::shared_ptr<std::thread> worker_ptr;
  {
    std::lock_guard<std::mutex> lock(state_->task_mtx);
    if (state_->is_shut_down) {
      return;
    }
    state_->is_shut_down = true;
    std::queue<std::function<void()>> empty;
    state_->tasks.swap(empty);
    worker_ptr = std::move(worker);
  }
  state_->cond.notify_all();

  if (worker_ptr && worker_ptr->joinable()) {
    // Use detach() instead of join() to avoid deadlock:
    // 1. If shutdown() is called from within the worker thread, join() would
    // deadlock
    // 2. SharedState ensures resources remain valid even after
    // WorkThreadExecutor destruction
#if __cpp_exceptions >= 199711L
    try {
#endif
      worker_ptr->detach();
      LOGI("WorkThreadExecutor::shutdown worker->detach() success.");
#if __cpp_exceptions >= 199711L
    } catch (const std::exception& e) {
      LOGE("WorkThreadExecutor::shutdown worker->detach() failed, "
           << e.what());
    }
#endif
  }
  LOGI("WorkThreadExecutor::shutdown success.");
}

void WorkThreadExecutor::run(std::shared_ptr<SharedState> state) {
  while (true) {
    if (state->is_shut_down) {
      break;
    }

    std::function<void()> task;
    bool has_task = false;

    {
      std::unique_lock<std::mutex> lock(state->task_mtx);

      while (true) {
        if (state->is_shut_down) {
          break;
        }
        if (!state->tasks.empty()) {
          break;
        }
        state->cond.wait(lock);
      }

      if (state->is_shut_down) {
        break;
      }

      if (!state->tasks.empty()) {
        task = std::move(state->tasks.front());
        state->tasks.pop();
        has_task = true;
      }
    }

    if (has_task) {
      if (state->is_shut_down) {
        break;
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
}

}  // namespace base
}  // namespace debugrouter
