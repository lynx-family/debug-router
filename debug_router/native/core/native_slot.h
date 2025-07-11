// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_CORE_NATIVE_SLOT_H_
#define DEBUGROUTER_NATIVE_CORE_NATIVE_SLOT_H_

#include <string>

namespace debugrouter {
namespace core {

class NativeSlot {
 public:
  NativeSlot(const std::string &type, const std::string &url);
  virtual ~NativeSlot() = default;
  std::string GetUrl();
  std::string GetType();
  virtual void OnMessage(const std::string &message,
                         const std::string &type) = 0;

 private:
  std::string url_;
  std::string type_;
};

}  // namespace core
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_CORE_NATIVE_SLOT_H_
