// Copyright 2013 The Flutter Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
// Copyright 2022 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_WAKEABLE_H_
#define DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_WAKEABLE_H_

#include "debug_router/native/harmony/base/fml/time/time_point.h"

namespace debugrouter {
namespace fml {

/// Interface over the ability to \p WakeUp a \p fml::MessageLoopImpl.
/// \see fml::MessageLoopTaskQueues
class Wakeable {
 public:
  virtual ~Wakeable() {}

  virtual void WakeUp(fml::TimePoint time_point, bool is_woken_by_vsync) = 0;
};

}  // namespace fml
}  // namespace debugrouter

namespace fml {
using debugrouter::fml::Wakeable;
}  // namespace fml

#endif  // DEBUGROUTER_HARMONY_DEBUGROUTER_SRC_MAIN_BASE_FML_WAKEABLE_H_
