// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_REPORT_DEBUG_ROUTER_REPORT_H_
#define DEBUGROUTER_NATIVE_REPORT_DEBUG_ROUTER_REPORT_H_

namespace debugrouter {
namespace report {

class DebugRouterNativeReport {
 public:
  DebugRouterNativeReport() = default;
  virtual ~DebugRouterNativeReport() = default;

  virtual void report(const std::string &eventName, const std::string &category,
                      const std::string &metric, const std::string &extra) = 0;
};

}  // namespace report
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_REPORT_DEBUG_ROUTER_REPORT_H_
