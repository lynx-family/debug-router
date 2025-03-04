// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_PROCESSOR_MESSAGE_HANDLER_H_
#define DEBUGROUTER_NATIVE_PROCESSOR_MESSAGE_HANDLER_H_

#include <string>
#include <unordered_map>

namespace debugrouter {
namespace processor {

class MessageHandler {
 public:
  virtual ~MessageHandler() {}
  virtual std::string GetRoomId() = 0;
  virtual std::unordered_map<std::string, std::string> GetClientInfo() = 0;
  virtual std::unordered_map<int, std::string> GetSessionList() = 0;
  virtual void OnMessage(const std::string &type, int session_id,
                         const std::string &message) = 0;
  virtual void SendMessage(const std::string &message) = 0;
  virtual void OpenCard(const std::string &url) = 0;
  virtual std::string HandleAppAction(const std::string &method,
                                      const std::string &params) = 0;
  virtual void ChangeRoomServer(const std::string &url,
                                const std::string &room) = 0;
  virtual void ReportError(const std::string &error) = 0;
};

}  // namespace processor
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_PROCESSOR_MESSAGE_HANDLER_H_
