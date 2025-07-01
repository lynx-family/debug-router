// Copyright 2013 The Flutter Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
// Copyright 2022 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_DELAYED_TASK_H_
#define DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_DELAYED_TASK_H_

#include <deque>
#include <functional>
#include <queue>

#include "debug_router/native/harmony/base/closure.h"
#include "debug_router/native/harmony/base/fml/task_source_grade.h"
#include "debug_router/native/harmony/base/fml/time/time_point.h"

namespace debugrouter {
namespace fml {

class DelayedTask {
 public:
  DelayedTask(size_t order, base::closure task, fml::TimePoint target_time,
              fml::TaskSourceGrade task_source_grade);

  ~DelayedTask();

  DelayedTask(const DelayedTask&) = delete;
  DelayedTask& operator=(const DelayedTask&) = delete;
  DelayedTask(DelayedTask&&) = default;
  DelayedTask& operator=(DelayedTask&&) = default;

  // after invoke this func, task_ will become nullptr!
  base::closure GetTask() const;

  fml::TimePoint GetTargetTime() const;

  fml::TaskSourceGrade GetTaskSourceGrade() const;

  bool operator>(const DelayedTask& other) const;

 private:
  size_t order_;
  mutable base::closure task_;
  fml::TimePoint target_time_;
  fml::TaskSourceGrade task_source_grade_;
};

using DelayedTaskQueue =
    std::priority_queue<DelayedTask, std::deque<DelayedTask>,
                        std::greater<DelayedTask>>;

}  // namespace fml
}  // namespace debugrouter

#endif  // DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_DELAYED_TASK_H_
