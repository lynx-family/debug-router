// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_PROCESSOR_STATE_LISTENER_H_
#define DEBUGROUTER_NATIVE_PROCESSOR_STATE_LISTENER_H_

#include <string>

namespace debugrouter {
namespace processor {

class StateListener {
 public:
  virtual void onOpen() = 0;
  virtual void onClosed() = 0;
  virtual void onError(const std::string &error) = 0;
  virtual void onMessage(const std::string &message) = 0;
};

}  // namespace processor
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_PROCESSOR_STATE_LISTENER_H_
