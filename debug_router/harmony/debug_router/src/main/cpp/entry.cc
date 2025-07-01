// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <hilog/log.h>
#include <napi/native_api.h>

#include "debug_router/native/harmony/debug_router_harmony.h"
#include "debug_router/native/harmony/debug_router_log_harmony.h"

EXTERN_C_START static napi_value Init(napi_env env, napi_value exports) {
  debugrouter::harmony::DebugRouterHarmony::Init(env, exports);
  debugrouter::harmony::InitializeHarmonyLogging();
  return exports;
}

EXTERN_C_END

static napi_module debug_router_module = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "debugrouter",
    .nm_priv = ((void *)0),
    .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterEntryModule(void) {
  OH_LOG_Print(LOG_APP, LogLevel::LOG_ERROR, 0xFF00, "DebugRouter",
               "%{public}s", "register debugrouter native arkts module");
  napi_module_register(&debug_router_module);
}
