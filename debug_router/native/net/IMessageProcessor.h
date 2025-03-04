// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_NET_IMESSAGE_PROCESSOR_H_
#define DEBUGROUTER_NATIVE_NET_IMESSAGE_PROCESSOR_H_

#include <string>

#include "debug_router/native/processor/processor.h"

namespace debugrouter {
namespace processor {

class IMessageProcessor {
 public:
  virtual void Process(const std::string &message) = 0;
  virtual std::shared_ptr<debugrouter::processor::Processor> GetProcessor() = 0;

  virtual ~IMessageProcessor() {}
};

}  // namespace processor
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_NET_IMESSAGE_PROCESSOR_H_
