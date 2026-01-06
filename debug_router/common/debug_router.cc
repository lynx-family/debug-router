// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/common/debug_router.h"

#include <chrono>
#include <memory>

#include "debug_router/common/debug_router_slot.h"
#include "debug_router/common/native_slot_delegate.h"
#include "debug_router/native/base/no_destructor.h"
#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/core/debug_router_state_listener.h"

namespace debugrouter {
namespace common {

class DebugRouterStateListenerDelegate : public core::DebugRouterStateListener {
 public:
  explicit DebugRouterStateListenerDelegate(
      const std::shared_ptr<common::DebugRouterStateListener> listener)
      : listener_(listener) {}
  DebugRouterStateListenerDelegate() = default;
  virtual ~DebugRouterStateListenerDelegate() = default;

  void OnOpen(core::ConnectionType type) override {
    ConnectionType type_ = ConnectionType::Unknown;
    switch (type) {
      case core::ConnectionType::kWebSocket:
        type_ = ConnectionType::WebSocket;
        break;
      case core::ConnectionType::kUsb:
        type_ = ConnectionType::USB;
        break;
      default:
        break;
    }
    listener_->OnOpen(type_);
  }
  void OnClose(int32_t code, const std::string &reason) override {
    listener_->OnClose(code, reason);
  }
  void OnMessage(const std::string &message) override {
    listener_->OnMessage(message);
  }
  void OnError(const std::string &error) override { listener_->OnError(error); }

 private:
  std::shared_ptr<common::DebugRouterStateListener> listener_;
};

class DebugRouterGlobalHandlerDelegate : public core::DebugRouterGlobalHandler {
 public:
  explicit DebugRouterGlobalHandlerDelegate(
      common::DebugRouterGlobalHandler *handler)
      : handler_(handler) {}
  void OpenCard(const std::string &url) override { handler_->OpenCard(url); }
  void OnMessage(const std::string &message, const std::string &type) override {
    handler_->OnMessage(message, type);
  }

 private:
  common::DebugRouterGlobalHandler *handler_;
};

class DebugRouterSessionHandlerDelegate
    : public core::DebugRouterSessionHandler {
 public:
  explicit DebugRouterSessionHandlerDelegate(
      common::DebugRouterSessionHandler *handler)
      : handler_(handler) {}
  void OnSessionCreate(int session_id, const std::string &url) override {
    handler_->OnSessionCreate(session_id, url);
  }
  void OnSessionDestroy(int session_id) override {
    handler_->OnSessionDestroy(session_id);
  }
  void OnMessage(const std::string &message, const std::string &type,
                 int session_id) override {
    handler_->OnMessage(message, type, session_id);
  }

 private:
  common::DebugRouterSessionHandler *handler_;
};

DebugRouter &DebugRouter::GetInstance() {
  static base::NoDestructor<DebugRouter> instance;
  return *instance;
}

DebugRouter::DebugRouter() { core::DebugRouterCore::GetInstance(); }

void DebugRouter::ConnectAsync(const std::string &url,
                               const std::string &room) {
  core::DebugRouterCore::GetInstance().ConnectAsync(url, room);
}

void DebugRouter::DisconnectAsync() {
  core::DebugRouterCore::GetInstance().DisconnectAsync();
}

void DebugRouter::SendAsync(const std::string &message) {
  core::DebugRouterCore::GetInstance().SendAsync(message);
}

void DebugRouter::SendDataAsync(const std::string &data,
                                const std::string &type, int32_t session) {
  core::DebugRouterCore::GetInstance().SendDataAsync(data, type, session, -1,
                                                     false);
}

void DebugRouter::SendDataAsync(const std::string &data,
                                const std::string &type, int32_t session,
                                bool is_object) {
  core::DebugRouterCore::GetInstance().SendDataAsync(data, type, session, -1,
                                                     is_object);
}

int32_t DebugRouter::Plug(const std::shared_ptr<DebugRouterSlot> &slot) {
  std::shared_ptr<core::NativeSlot> native_slot =
      std::make_shared<NativeSlotDelegate>(slot);
  return core::DebugRouterCore::GetInstance().Plug(native_slot);
}

void DebugRouter::Pull(int32_t session_id_) {
  core::DebugRouterCore::GetInstance().Pull(session_id_);
}

void DebugRouter::AddGlobalHandler(DebugRouterGlobalHandler *handler) {
  DebugRouterGlobalHandlerDelegate *common_global_handler =
      new DebugRouterGlobalHandlerDelegate(handler);
  int handler_id = core::DebugRouterCore::GetInstance().AddGlobalHandler(
      common_global_handler);
  global_handlers_map_[handler] = handler_id;
}

bool DebugRouter::RemoveGlobalHandler(DebugRouterGlobalHandler *handler) {
  int handler_id = global_handlers_map_[handler];
  if (!handler_id) {
    return false;
  }
  return core::DebugRouterCore::GetInstance().RemoveGlobalHandler(handler_id);
}

void DebugRouter::AddSessionHandler(DebugRouterSessionHandler *handler) {
  DebugRouterSessionHandlerDelegate *common_session_handler =
      new DebugRouterSessionHandlerDelegate(handler);
  int handler_id = core::DebugRouterCore::GetInstance().AddSessionHandler(
      common_session_handler);
  session_handlers_map_[handler] = handler_id;
}

bool DebugRouter::RemoveSessionHandler(DebugRouterSessionHandler *handler) {
  if (!handler) {
    return false;
  }
  int handler_id = session_handlers_map_[handler];
  if (!handler_id) {
    return false;
  }
  return core::DebugRouterCore::GetInstance().RemoveSessionHandler(handler_id);
}

bool DebugRouter::IsValidSchema(const std::string &schema) {
  return core::DebugRouterCore::GetInstance().IsValidSchema(schema);
}

bool DebugRouter::HandleSchema(const std::string &schema) {
  return core::DebugRouterCore::GetInstance().HandleSchema(schema);
}

void DebugRouter::AddStateListener(
    const std::shared_ptr<DebugRouterStateListener> &listener) {
  std::shared_ptr<DebugRouterStateListenerDelegate> common_listener =
      std::make_shared<DebugRouterStateListenerDelegate>(listener);
  core::DebugRouterCore::GetInstance().AddStateListener(common_listener);
}

bool DebugRouter::IsConnected() {
  return core::DebugRouterCore::GetInstance().IsConnected();
}

void DebugRouter::SetAppInfo(
    const std::unordered_map<std::string, std::string> &app_info) {
  core::DebugRouterCore::GetInstance().SetAppInfo(app_info);
}

void DebugRouter::SetAppInfo(const std::string &key, const std::string &value) {
  core::DebugRouterCore::GetInstance().SetAppInfo(key, value);
}

std::string DebugRouter::GetAppInfoByKey(const std::string &key) {
  return core::DebugRouterCore::GetInstance().GetAppInfoByKey(key);
}

void DebugRouter::EnableAllSessions() {
  core::DebugRouterCore::GetInstance().EnableAllSessions();
}

void DebugRouter::EnableSingleSession(int32_t session_id) {
  core::DebugRouterCore::GetInstance().EnableSingleSession(session_id);
}

}  // namespace common
}  // namespace debugrouter
