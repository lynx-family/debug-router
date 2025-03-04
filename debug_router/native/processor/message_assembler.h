// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_PROCESSOR_MESSAGE_ASSEMBLER_H_
#define DEBUGROUTER_NATIVE_PROCESSOR_MESSAGE_ASSEMBLER_H_

#include <string>
#include <unordered_map>

namespace debugrouter {
namespace processor {

class MessageAssembler {
 public:
  static std::string AssembleDispatchDocumentUpdated();
  static std::string AssembleDispatchFrameNavigated(std::string url);
  static std::string AssembleDispatchScreencastVisibilityChanged(bool status);
  static std::string AssembleScreenCastFrame(
      int session_id, const std::string &data,
      const std::unordered_map<std::string, float> &metadata);
};

}  // namespace processor
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_PROCESSOR_MESSAGE_ASSEMBLER_H_
