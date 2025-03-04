// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/processor/message_assembler.h"

#include "debug_router/native/protocol/protocol.h"

namespace debugrouter {
namespace processor {

std::string MessageAssembler::AssembleDispatchDocumentUpdated() {
  Json::Value msg;
  msg["method"] = "DOM.documentUpdated";
  msg["params"] = Json::ValueType::objectValue;
  return msg.toStyledString();
}

std::string MessageAssembler::AssembleDispatchFrameNavigated(std::string url) {
  Json::Value msg;
  msg["method"] = "Page.frameNavigated";
  msg["params"] = Json::ValueType::objectValue;
  msg["params"]["frame"] = Json::ValueType::objectValue;
  msg["params"]["frame"]["url"] = url;
  msg["params"]["frame"]["id"] = "";
  return msg.toStyledString();
}

std::string MessageAssembler::AssembleDispatchScreencastVisibilityChanged(
    bool status) {
  Json::Value msg;
  msg["method"] = "Page.screencastVisibilityChanged";
  msg["params"] = Json::Value(Json::ValueType::objectValue);
  msg["params"]["visible"] = status;
  return msg.toStyledString();
}

std::string MessageAssembler::AssembleScreenCastFrame(
    int session_id, const std::string &data,
    const std::unordered_map<std::string, float> &metadata) {
  Json::Value metadata_;
  Json::Value params_;
  Json::Value content_;
  for (const auto &item : metadata) {
    metadata_[item.first] = item.second;
  }
  params_["data"] = data;
  params_["metadata"] = metadata_;
  params_["sessionId"] = session_id;
  content_["method"] = "Page.screencastFrame";
  content_["params"] = params_;
  return content_.toStyledString();
}

}  // namespace processor
}  // namespace debugrouter
