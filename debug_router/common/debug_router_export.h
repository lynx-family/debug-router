// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_COMMON_DEBUG_ROUTER_EXPORT_H_
#define DEBUGROUTER_COMMON_DEBUG_ROUTER_EXPORT_H_

#ifdef _WIN32
#ifndef DEBUG_ROUTER_EXPORTS
#define DEBUG_ROUTER_EXPORT __declspec(dllimport)
#else
#define DEBUG_ROUTER_EXPORT __declspec(dllexport)
#endif
#else
#define DEBUG_ROUTER_EXPORT __attribute__((visibility("default")))
#endif

#endif  // DEBUGROUTER_COMMON_DEBUG_ROUTER_EXPORT_H_
