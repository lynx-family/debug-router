// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_CORE_MESSAGE_TRANSCEIVER_H_
#define DEBUGROUTER_NATIVE_CORE_MESSAGE_TRANSCEIVER_H_

#include <memory>
#include <string>

#include "debug_router/native/core/debug_router_state_listener.h"

namespace debugrouter {
namespace core {

class MessageTransceiver;

class MessageTransceiverDelegate {
 public:
  virtual void OnOpen(
      const std::shared_ptr<MessageTransceiver> &transceiver) = 0;
  virtual void OnClosed(
      const std::shared_ptr<MessageTransceiver> &transceiver) = 0;
  virtual void OnFailure(const std::shared_ptr<MessageTransceiver> &transceiver,
                         const std::string &error_message, int error_code) = 0;
  virtual void OnMessage(
      const std::string &message,
      const std::shared_ptr<MessageTransceiver> &transceiver) = 0;
  virtual void OnInit(const std::shared_ptr<MessageTransceiver> &transceiver,
                      int32_t code, const std::string &info) = 0;
};

class MessageTransceiver
    : public std::enable_shared_from_this<MessageTransceiver> {
 public:
  MessageTransceiver();

  virtual void Init(){};
  virtual bool Connect(const std::string &url) = 0;
  virtual void Disconnect() = 0;
  virtual void Send(const std::string &data) = 0;
  virtual ConnectionType GetType() = 0;
  virtual void HandleReceivedMessage(const std::string &message);
  virtual void SetDelegate(MessageTransceiverDelegate *delegate);
  virtual MessageTransceiverDelegate *delegate();

 private:
  MessageTransceiverDelegate *delegate_ = nullptr;
};

}  // namespace core
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_CORE_MESSAGE_TRANSCEIVER_H_
