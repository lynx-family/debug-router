// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_MESSAGE_HANDLER_H_
#define DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_MESSAGE_HANDLER_H_

#include <string>

namespace debugrouter {
namespace core {
/**
 * MessageHandler is used to process messages received by DebugRouter.
 *
 * We can use:
 *
 * DebugRouterCore::AddMessageHandler
 *
 * to add a MessageHandler for processing specific messages.
 */
class DebugRouterMessageHandler {
 public:
  virtual ~DebugRouterMessageHandler() {}

  /**
   * DebugRouter dispatches messages based on the MessageHandler's name.
   *
   * When a MessageHandler's name matches the received message, the
   * MessageHandler's handle method will be called to process this message.
   *
   * When the handler needs to return additional results asynchronously,
   * you can use:
   *
   * DebugRouterEventSender::sender
   *
   * @param params Handler's parameters: resolved from the message
   * @return Returns the handler's result
   */
  virtual std::string Handle(std::string params) = 0;

  /**
   * MessageHandler's name
   *
   * Unique identifier for the MessageHandler.
   *
   * It indicates which messages this handler can process.
   */
  virtual std::string GetName() const = 0;
};

}  // namespace core
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_MESSAGE_HANDLER_H_
