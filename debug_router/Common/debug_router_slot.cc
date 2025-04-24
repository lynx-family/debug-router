// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/Common/debug_router_slot.h"

#include <unordered_map>

#include "debug_router/Common/debug_router.h"
#include "debug_router/native/processor/message_assembler.h"
#include "json/reader.h"

namespace debugrouter {
namespace common {

DebugRouterSlot::DebugRouterSlot()
    : plugged_(false), session_id_(0), type_("") {}

int32_t DebugRouterSlot::Plug() {
  Pull();
  session_id_ = DebugRouter::GetInstance().Plug(shared_from_this());
  plugged_ = true;
  return session_id_;
}

void DebugRouterSlot::Pull() {
  if (plugged_) {
    DebugRouter::GetInstance().Pull(session_id_);
    plugged_ = false;
  }
}

void DebugRouterSlot::SendAsync(const std::string &message) {
  DebugRouter::GetInstance().SendAsync(message);
}

void DebugRouterSlot::SendDataAsync(const std::string &data,
                                    const std::string &type) {
  DebugRouter::GetInstance().SendDataAsync(data, type, session_id_);
}

std::string DebugRouterSlot::GetTemplateUrl() const {
  auto sp_delegate = delegate_.lock();
  return sp_delegate ? sp_delegate->GetTemplateUrl() : "___UNKNOWN___";
}

void DebugRouterSlot::OnMessage(const std::string &message,
                                const std::string &type) {
  auto sp_delegate = delegate_.lock();
  if (sp_delegate) {
    sp_delegate->OnMessage(message, type);
  }
}

void DebugRouterSlot::DispatchDocumentUpdated() {
  std::string data = debugrouter::processor::MessageAssembler::
      AssembleDispatchDocumentUpdated();
  SendDataAsync(data, "CDP");
}

void DebugRouterSlot::DispatchFrameNavigated(const std::string &url) {
  std::string data =
      debugrouter::processor::MessageAssembler::AssembleDispatchFrameNavigated(
          url);
  SendDataAsync(data, "CDP");
}

void DebugRouterSlot::ClearScreenCastCache() {}

void DebugRouterSlot::DispatchScreencastVisibilityChanged(bool status) {
  std::string data = debugrouter::processor::MessageAssembler::
      AssembleDispatchScreencastVisibilityChanged(status);
  SendDataAsync(data, "CDP");
}

void DebugRouterSlot::SendScreenCast(
    const std::string &data,
    const std::unordered_map<std::string, float> &metadata) {
  auto cdp_data =
      debugrouter::processor::MessageAssembler::AssembleScreenCastFrame(
          session_id_, data, metadata);
  SendDataAsync(cdp_data, "CDP");
}

void DebugRouterSlot::SetDelegate(
    const std::shared_ptr<DebugRouterSlotDelegate> &delegate) {
  delegate_ = delegate;
}

void DebugRouterSlot::SetType(const std::string &type) { type_ = type; }

const std::string &DebugRouterSlot::GetType() { return type_; }

}  // namespace common
}  // namespace debugrouter
