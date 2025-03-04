// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/core/message_transceiver.h"

namespace debugrouter {
namespace core {
MessageTransceiver::MessageTransceiver() {}

void MessageTransceiver::HandleReceivedMessage(const std::string &message) {
  if (delegate_) {
    delegate_->OnMessage(message, shared_from_this());
  }
}

void MessageTransceiver::SetDelegate(MessageTransceiverDelegate *delegate) {
  delegate_ = delegate;
}

MessageTransceiverDelegate *MessageTransceiver::delegate() { return delegate_; }

}  // namespace core
}  // namespace debugrouter
