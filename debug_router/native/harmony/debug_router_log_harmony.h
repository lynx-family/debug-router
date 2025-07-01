// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_LOG_HARMONY_H
#define DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_LOG_HARMONY_H

#include "debug_router/native/log/logging.h"

namespace debugrouter {
namespace harmony {

void InitializeHarmonyLogging();
void Log(logging::LogMessage* msg);

}  // namespace harmony
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_HARMONY_DEBUG_ROUTER_LOG_HARMONY_H
