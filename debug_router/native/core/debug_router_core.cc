// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/core/debug_router_core.h"

#include <chrono>
#include <thread>

#include "debug_router/native/base/no_destructor.h"
#include "debug_router/native/core/debug_router_config.h"
#include "debug_router/native/core/debug_router_message_handler.h"
#include "debug_router/native/core/debug_router_state_listener.h"
#include "debug_router/native/core/native_slot.h"
#include "debug_router/native/core/util.h"
#include "debug_router/native/log/logging.h"
#include "debug_router/native/net/socket_server_client.h"
#include "debug_router/native/net/websocket_client.h"
#include "debug_router/native/processor/message_handler.h"
#include "debug_router/native/processor/processor.h"
#include "debug_router/native/thread/debug_router_executor.h"
#include "json/value.h"

namespace debugrouter {

namespace core {

class MessageHandlerCore : public processor::MessageHandler {
 public:
  MessageHandlerCore() {}

  std::string GetRoomId() override {
    return DebugRouterCore::GetInstance().room_id_;
  }

  std::unordered_map<std::string, std::string> GetClientInfo() override {
    return DebugRouterCore::GetInstance().app_info_;
  }

  std::unordered_map<int, std::string> GetSessionList() override {
    std::unordered_map<int, std::string> session_list;
    auto &core = DebugRouterCore::GetInstance();
    const bool enable_all_sessions =
        core.enable_all_sessions_.load(std::memory_order_relaxed);
    std::unordered_set<int32_t> enabled_session_ids;
    if (!enable_all_sessions) {
      std::shared_lock lock(core.enabled_sessions_mutex_);
      enabled_session_ids = core.enabled_session_ids_;
    }

    std::shared_lock lock(core.slots_mutex_);
    for (const auto &slot : core.slots_) {
      if (!enable_all_sessions && enabled_session_ids.count(slot.first) == 0) {
        continue;
      }
      Json::Value session_info;
      session_info["type"] = slot.second->GetType();
      session_info["url"] = slot.second->GetUrl();
      session_list[slot.first] = session_info.toStyledString();
    }
    return session_list;
  }

  std::string HandleAppAction(const std::string &method,
                              const std::string &params) override {
    DebugRouterMessageHandler *handler =
        DebugRouterCore::GetInstance().message_handlers_[method];
    if (handler) {
      return handler->Handle(params);
    } else {
      LOGW("DebugRouterCore: handler not found, method=" << method);
      return "{\"code\":-2,\"message\":\"not implemented\"}";
    }
  }

  void OnMessage(const std::string &type, int session_id,
                 const std::string &message) override {
    if (session_id < 0) {
      std::vector<DebugRouterGlobalHandler *> handlers;
      {
        std::shared_lock lock(
            DebugRouterCore::GetInstance().global_handler_mutex_);
        const auto &global_handler_map =
            DebugRouterCore::GetInstance().global_handler_map_;
        handlers.reserve(global_handler_map.size());
        for (auto it : global_handler_map) {
          handlers.push_back(it.second);
        }
      }
      for (auto *handler : handlers) {
        handler->OnMessage(message, type);
      }
      return;
    }

    // Defensive second-layer filtering: transport-level filtering should
    // already drop inactive session-bound messages, but keep this guard here
    // so raw/custom paths cannot accidentally fan out inactive session_id > 0
    // payloads to handlers if they bypass the transport helper.
    if (!DebugRouterCore::GetInstance().isEnableAllSessions() &&
        session_id > 0 &&
        !DebugRouterCore::GetInstance().isActiveSession(session_id)) {
      return;
    }

    {
      std::vector<DebugRouterSessionHandler *> handlers;
      {
        std::shared_lock lock(
            DebugRouterCore::GetInstance().session_handler_mutex_);
        const auto &session_handler_map =
            DebugRouterCore::GetInstance().session_handler_map_;
        handlers.reserve(session_handler_map.size());
        for (auto it : session_handler_map) {
          handlers.push_back(it.second);
        }
      }
      for (auto *handler : handlers) {
        handler->OnMessage(message, type, session_id);
      }
    }

    // Never hold slots_mutex_ while invoking app callbacks.
    // Otherwise Pull(session) may block on UI thread and trigger ANR if the
    // callback is slow / re-enters DebugRouter.
    std::shared_ptr<core::NativeSlot> slot;
    {
      std::shared_lock lock(DebugRouterCore::GetInstance().slots_mutex_);
      const auto &slots = DebugRouterCore::GetInstance().slots_;
      auto it = slots.find(session_id);
      if (it != slots.end()) {
        slot = it->second;
      }
    }
    if (slot) {
      slot->OnMessage(message, type);
    }
  }

  void SendMessage(const std::string &message) override {
    DebugRouterCore::GetInstance().Send(message);
  }

  void OpenCard(const std::string &url) override {
    std::vector<DebugRouterGlobalHandler *> handlers;
    {
      std::shared_lock lock(
          DebugRouterCore::GetInstance().global_handler_mutex_);
      const auto &global_handler_map_ =
          DebugRouterCore::GetInstance().global_handler_map_;
      handlers.reserve(global_handler_map_.size());
      for (auto it : global_handler_map_) {
        handlers.push_back(it.second);
      }
    }
    for (auto *handler : handlers) {
      handler->OpenCard(url);
    }
  }

  void ChangeRoomServer(const std::string &url,
                        const std::string &room) override {
    DebugRouterCore::GetInstance().Connect(url, room);
  }

  void ReportError(const std::string &error) override {}
};

DebugRouterCore &DebugRouterCore::GetInstance() {
  static base::NoDestructor<DebugRouterCore> instance;
  return *instance;
}

DebugRouterCore::DebugRouterCore()
    : connection_state_(DISCONNECTED),
      current_transceiver_(nullptr),
      max_session_id_(0),
      report_(nullptr),
      processor_(nullptr),
      retry_times_(0),
      handler_count_(1),
      is_first_connect_(UNINIT) {
#if ENABLE_MESSAGE_IMPL
  size_t transceiver_count = 0;
  message_transceivers_[transceiver_count++] =
      std::make_shared<net::WebSocketClient>();
  message_transceivers_[transceiver_count++] =
      std::make_shared<net::SocketServerClient>();
#endif
  for (size_t i = 0; i < kTransceiverCount; ++i) {
    message_transceivers_[i]->Init();
    message_transceivers_[i]->SetDelegate(this);
  }
  std::unique_ptr<processor::MessageHandler> handler =
      std::make_unique<MessageHandlerCore>();
  processor_ = std::make_unique<processor::Processor>(std::move(handler));
  thread::DebugRouterExecutor::GetInstance().Start();
}

void DebugRouterCore::SetReportDelegate(
    std::unique_ptr<report::DebugRouterNativeReport> report) {
  report_ = std::move(report);
}

void DebugRouterCore::Connect(const std::string &url, const std::string &room) {
  Connect(url, room, false);
}

ConnectionState DebugRouterCore::GetConnectionState() {
  return connection_state_.load(std::memory_order_relaxed);
}

void DebugRouterCore::Disconnect() {
  if (connection_state_.load(std::memory_order_relaxed) != DISCONNECTED) {
    LOGI("Disconnect");
    if (current_transceiver_) {
      current_transceiver_->Disconnect();
      current_transceiver_ = nullptr;
    }
  }
}

void DebugRouterCore::ConnectAsync(const std::string &url,
                                   const std::string &room) {
  thread::DebugRouterExecutor::GetInstance().Post(
      [=]() { Connect(url, room); });
}

void DebugRouterCore::DisconnectAsync() {
  thread::DebugRouterExecutor::GetInstance().Post([=]() { Disconnect(); });
}

void DebugRouterCore::Reconnect() {
  if (!server_url_.empty() && !room_id_.empty()) {
    LOGW("Reconnect, retry_times="
         << retry_times_.load(std::memory_order_relaxed)
         << ", url=" << server_url_ << ", room=" << room_id_);
    Connect(server_url_, room_id_, true);
  }
}

void DebugRouterCore::Connect(const std::string &url, const std::string &room,
                              bool is_reconnect) {
  std::string curr_host_ = "";
  std::size_t pos = url.find("page/android");
  if (pos != std::string::npos) {
    curr_host_ = url.substr(0, pos + 12);
  }
  LOGI("Connect, reconnect=" << is_reconnect << ", url=" << url
                             << ", room=" << room << ", last_host=" << host_url_
                             << ", last_room=" << GetRoomId());

  Json::Value catagaryJson;
  catagaryJson["url"] = url;
  catagaryJson["room"] = room;
  if (room == GetRoomId() && curr_host_ == host_url_ &&
      GetConnectionState() != DISCONNECTED) {
    catagaryJson["attribution"] = "User Incorrect Call";
    std::string catagary = catagaryJson.toStyledString();
    LOGW("Connect skipped, same host and room are already active");
    Report("RedundantConnect", catagary, "", "");
    return;
  }

  // report all connect event.
  std::string catagary = catagaryJson.toStyledString();
  if (is_reconnect) {
    LOGI("is_reconnect");
    Report("Reconnect", catagary, "", "");
  } else {
    LOGI("is_first_connect");
    is_first_connect_.store(FIRST_CONNECT);
    retry_times_.store(0, std::memory_order_relaxed);
    Report("Connect", catagary, "", "");
  }

  LOGI(
      "connect. retry times: " << retry_times_.load(std::memory_order_relaxed));
  Disconnect();
  connection_state_.store(CONNECTING, std::memory_order_relaxed);
  for (size_t i = 0; i < kTransceiverCount; ++i) {
    if (message_transceivers_[i]->Connect(url)) {
      break;
    }
  }
  host_url_ = curr_host_;
  server_url_ = url;
  room_id_ = room;
}

void DebugRouterCore::Send(const std::string &message) {
  if (connection_state_.load(std::memory_order_relaxed) == CONNECTED) {
    current_transceiver_->Send(message);
  }
}

void DebugRouterCore::SendAsync(const std::string &message) {
  if (connection_state_.load(std::memory_order_relaxed) != CONNECTED) {
    return;
  }
  thread::DebugRouterExecutor::GetInstance().Post([=]() { Send(message); });
}

void DebugRouterCore::SendData(const std::string &data, const std::string &type,
                               int32_t session, int32_t mark, bool is_object) {
  if (connection_state_.load(std::memory_order_relaxed) == CONNECTED) {
    if (!enable_all_sessions_.load(std::memory_order_relaxed) && session > 0 &&
        !isActiveSession(session)) {
      return;
    }
    std::string message =
        processor_->WrapCustomizedMessage(type, session, data, mark, is_object);
    Send(message);
  }
}

void DebugRouterCore::SendDataAsync(const std::string &data,
                                    const std::string &type, int32_t session,
                                    int32_t mark, bool is_object) {
  if (connection_state_.load(std::memory_order_relaxed) != CONNECTED) {
    return;
  }
  thread::DebugRouterExecutor::GetInstance().Post(
      [=]() { SendData(data, type, session, mark, is_object); });
}

int32_t DebugRouterCore::Plug(const std::shared_ptr<core::NativeSlot> &slot) {
  {
    std::unique_lock lock(slots_mutex_);
    max_session_id_++;
    slots_[max_session_id_] = slot;
  }
  LOGI("plug session: " << max_session_id_);
  if (connection_state_.load(std::memory_order_relaxed) == CONNECTED) {
    processor_->FlushSessionList();
  }
  NotifyConnectStateByMessage(GetConnectionState());
  {
    std::vector<DebugRouterSessionHandler *> handlers;
    {
      std::shared_lock lock(session_handler_mutex_);
      handlers.reserve(session_handler_map_.size());
      for (auto it : session_handler_map_) {
        handlers.push_back(it.second);
      }
    }
    for (auto *handler : handlers) {
      handler->OnSessionCreate(max_session_id_, slot->GetUrl());
    }
  }
  return max_session_id_;
}

int32_t DebugRouterCore::GetUSBPort() {
  return usb_port_.load(std::memory_order_relaxed);
}

void DebugRouterCore::Pull(int32_t session_id_) {
  LOGI("pull session: " << session_id_);
  if (!enable_all_sessions_.load(std::memory_order_relaxed)) {
    std::unique_lock lock(enabled_sessions_mutex_);
    enabled_session_ids_.erase(session_id_);
  }
  // Server availability no longer depends on enabled-session ids. Pull() only
  // updates the filter set used by isActiveSession().
  {
    std::unique_lock lock(slots_mutex_);
    slots_.erase(session_id_);
  }
  if (connection_state_.load(std::memory_order_relaxed) == CONNECTED) {
    processor_->FlushSessionList();
  }
  {
    std::vector<DebugRouterSessionHandler *> handlers;
    {
      std::shared_lock lock(session_handler_mutex_);
      handlers.reserve(session_handler_map_.size());
      for (auto it : session_handler_map_) {
        handlers.push_back(it.second);
      }
    }
    for (auto *handler : handlers) {
      handler->OnSessionDestroy(session_id_);
    }
  }
}

void DebugRouterCore::OnInit(
    const std::shared_ptr<MessageTransceiver> &transceiver, int32_t code,
    const std::string &info) {
  if (code != 0) {
    return;
  }
  std::string::size_type index = info.find("port:");
  if (index == std::string::npos) {
    return;
  }
  std::string port = info.substr(index + 5);
  LOGI("OnInit usb port: " << port);
  usb_port_.store(std::stoi(port), std::memory_order_relaxed);
}

void DebugRouterCore::Report(const std::string &eventName,
                             const std::string &category,
                             const std::string &metric,
                             const std::string &extra) {
  if (report_ != nullptr) {
    report_->report(eventName, category, metric, extra);
  }
}

void DebugRouterCore::OnOpen(
    const std::shared_ptr<MessageTransceiver> &transceiver) {
  if (connection_state_.load(std::memory_order_relaxed) == CONNECTED) {
    if (current_transceiver_ == transceiver) {
      return;
    } else if (current_transceiver_ != nullptr) {
      current_transceiver_->Disconnect();
    }
  }
  LOGI("DebugRouterCore: onOpen.");
  current_transceiver_ = transceiver;
  connection_state_.store(CONNECTED, std::memory_order_relaxed);
  NotifyConnectStateByMessage(CONNECTED);
  ConnectionType connect_type = current_transceiver_->GetType();
  if (connect_type == ConnectionType::kUsb) {
    host_url_ = "";
    server_url_ = "";
    room_id_ = "";
    Json::Value catagaryJson;
    catagaryJson["connect_type"] = "usb";
    std::string catagary = catagaryJson.toStyledString();
    Report("OnOpen", catagary, "", "");
  } else if (is_first_connect_.load() == FIRST_CONNECT) {
    Json::Value catagaryJson;
    catagaryJson["connect_type"] = "websocket";
    catagaryJson["is_first_connect"] = "true";
    std::string catagary = catagaryJson.toStyledString();
    Report("OnOpen", catagary, "", "");
    is_first_connect_.store(NON_FIRST_CONNECT);
  } else {
    Json::Value catagaryJson;
    catagaryJson["connect_type"] = "websocket";
    catagaryJson["is_first_connect"] = "false";
    std::string catagary = catagaryJson.toStyledString();
    Report("OnOpen", catagary, "", "");
  }

  std::vector<std::shared_ptr<DebugRouterStateListener>> listeners;
  {
    std::shared_lock lock(state_listeners_mutex_);
    listeners = state_listeners_;
  }

  for (const auto &listener : listeners) {
    listener->OnOpen(connect_type);
  }
}

void DebugRouterCore::OnClosed(
    const std::shared_ptr<MessageTransceiver> &transceiver) {
  LOGI("DebugRouterCore: onClosed.");
  if (transceiver != current_transceiver_ ||
      connection_state_.load(std::memory_order_relaxed) == DISCONNECTED) {
    return;
  }
  connection_state_.store(DISCONNECTED, std::memory_order_relaxed);
  current_transceiver_ = nullptr;
  NotifyConnectStateByMessage(DISCONNECTED);
  if (transceiver->GetType() == ConnectionType::kUsb ||
      (transceiver->GetType() == ConnectionType::kWebSocket &&
       retry_times_.load(std::memory_order_relaxed) >= 3)) {
    std::vector<std::shared_ptr<DebugRouterStateListener>> listeners;
    {
      std::shared_lock lock(state_listeners_mutex_);
      listeners = state_listeners_;
    }

    for (const auto &listener : listeners) {
      listener->OnClose(-1, "unknown reason");
    }
  }

  if (transceiver->GetType() == ConnectionType::kWebSocket) {
    if (current_transceiver_ == nullptr ||
        current_transceiver_->GetType() == ConnectionType::kWebSocket) {
      std::string result = DebugRouterConfigs::GetInstance().GetConfig(
          kForbidReconnectWhenClose, "false");
      if (result == "true") {
        LOGW("Reconnect skipped after close by config");
        return;
      }
      TryToReconnect();
    }
  }
}

void DebugRouterCore::OnFailure(
    const std::shared_ptr<MessageTransceiver> &transceiver,
    const std::string &error_message, int error_code) {
  LOGI("DebugRouterCore: onFailure. errorcode: " << error_code);
  if ((current_transceiver_ != nullptr &&
       transceiver != current_transceiver_) ||
      connection_state_.load(std::memory_order_relaxed) == DISCONNECTED) {
    return;
  }

  if (current_transceiver_ != nullptr) {
    if (current_transceiver_->GetType() == ConnectionType::kUsb) {
      Json::Value catagaryJson;
      catagaryJson["connect_type"] = "usb";
      catagaryJson["error_code"] = error_code;
      catagaryJson["error_msg"] = error_message;
      std::string catagary = catagaryJson.toStyledString();
      Report("OnFailure", catagary, "", "");
    } else {
      Json::Value catagaryJson;
      catagaryJson["connect_type"] = "websocket";
      catagaryJson["error_code"] = error_code;
      catagaryJson["error_msg"] = error_message;
      std::string catagary = catagaryJson.toStyledString();
      Report("OnFailure", catagary, "", "");
    }
  } else {
    Json::Value catagaryJson;
    catagaryJson["connect_type"] = "none";
    catagaryJson["error_code"] = error_code;
    if (is_first_connect_.load() == FIRST_CONNECT) {
      is_first_connect_.store(NON_FIRST_CONNECT);
      catagaryJson["is_websocket_first_connect"] = "true";
    }
    catagaryJson["error_msg"] = error_message;
    std::string catagary = catagaryJson.toStyledString();
    Report("OnFailure", catagary, "", "");
  }
  connection_state_.store(DISCONNECTED, std::memory_order_relaxed);
  current_transceiver_ = nullptr;
  NotifyConnectStateByMessage(DISCONNECTED);

  if (transceiver->GetType() == ConnectionType::kUsb ||
      (transceiver->GetType() == ConnectionType::kWebSocket &&
       retry_times_.load(std::memory_order_relaxed) >= 3)) {
    std::vector<std::shared_ptr<DebugRouterStateListener>> listeners;
    {
      std::shared_lock lock(state_listeners_mutex_);
      listeners = state_listeners_;
    }

    for (const auto &listener : listeners) {
      // TODO(zhoumingsong.smile): add more details
      listener->OnError(error_message);
    }
  }

  if (transceiver->GetType() == ConnectionType::kWebSocket) {
    if (current_transceiver_ == nullptr ||
        current_transceiver_->GetType() == ConnectionType::kWebSocket) {
      TryToReconnect();
    }
  }
}

void DebugRouterCore::OnMessage(
    const std::string &message,
    const std::shared_ptr<MessageTransceiver> &transceiver) {
  if (transceiver != current_transceiver_) {
    return;
  }
  processor_->Process(message);

  std::vector<std::shared_ptr<DebugRouterStateListener>> listeners;
  {
    std::shared_lock lock(state_listeners_mutex_);
    listeners = state_listeners_;
  }

  for (const auto &listener : listeners) {
    listener->OnMessage(message);
  }
}

DebugRouterCore::~DebugRouterCore() {
  // TODO(zhoumingsong.smile): Stop websocketClient's thread
  // It's not a good way to do this
}

int DebugRouterCore::AddGlobalHandler(DebugRouterGlobalHandler *handler) {
  std::unique_lock lock(global_handler_mutex_);
  for (auto key : global_handler_map_) {
    if (key.second == handler) {
      return key.first;
    }
  }
  int handler_id = handler_count_.fetch_add(1, std::memory_order_relaxed);
  global_handler_map_[handler_id] = handler;
  return handler_id;
}

bool DebugRouterCore::RemoveGlobalHandler(int handler_id) {
  std::unique_lock lock(global_handler_mutex_);
  auto it = global_handler_map_.find(handler_id);
  if (it != global_handler_map_.end()) {
    global_handler_map_.erase(it);
    return true;
  }
  return false;
}

void DebugRouterCore::AddMessageHandler(DebugRouterMessageHandler *handler) {
  if (!handler) {
    return;
  }
  std::string handler_name = handler->GetName();
  if (message_handlers_.find(handler_name) != message_handlers_.end()) {
    LOGW("DebugRouterCore: " << handler_name << " handler has been override.");
  }
  message_handlers_[handler_name] = handler;
}

bool DebugRouterCore::RemoveMessageHandler(const std::string &handler_name) {
  size_t erased_count = message_handlers_.erase(handler_name);
  return erased_count > 0;
}

int DebugRouterCore::AddSessionHandler(DebugRouterSessionHandler *handler) {
  std::unique_lock lock(session_handler_mutex_);
  for (auto key : session_handler_map_) {
    if (key.second == handler) {
      return key.first;
    }
  }
  int handler_id = handler_count_.fetch_add(1, std::memory_order_relaxed);
  session_handler_map_[handler_id] = handler;
  return handler_id;
}

bool DebugRouterCore::RemoveSessionHandler(int handler_id) {
  std::unique_lock lock(session_handler_mutex_);
  auto it = session_handler_map_.find(handler_id);
  if (it != session_handler_map_.end()) {
    session_handler_map_.erase(it);
    return true;
  }
  return false;
}

bool DebugRouterCore::IsValidSchema(const std::string &schema) {
  return schema.find("remote_debug_lynx") != std::string::npos;
}

std::string DebugRouterCore::GetRoomId() { return room_id_; }
std::string DebugRouterCore::GetServerUrl() { return server_url_; }

bool DebugRouterCore::HandleSchema(const std::string &encode_schema) {
  std::string url, room;
  std::string schema = util::decodeURIComponent(encode_schema);
  Json::Value catagaryJson;
  catagaryJson["schema"] = schema;
  std::string catagary = catagaryJson.toStyledString();
  Report("HandleSchema", catagary, "", "");
  size_t query_index = schema.find('?');
  if (query_index == std::string::npos) {
    catagaryJson["attribution"] = "User Incorrect Useage";
    catagary = catagaryJson.toStyledString();
    Report("InvalidSchema", catagary, "", "");
    LOGE("Invalid schema:" << schema);
    return false;
  }
  std::string path = schema.substr(0, query_index);
  size_t cmd_index = path.find_last_of('/');
  if (cmd_index == std::string::npos) {
    catagaryJson["attribution"] = "User Incorrect Useage";
    catagary = catagaryJson.toStyledString();
    Report("InvalidSchema", catagary, "", "");
    LOGE("Invalid schema:" << schema);
    return false;
  }
  std::string cmd = path.substr(cmd_index + 1, path.size() - cmd_index - 1);
  if (!cmd.compare("enable")) {
    std::string query =
        schema.substr(query_index + 1, schema.size() - query_index - 1);
    bool break_flag = true;
    while (break_flag) {
      size_t param_index = query.find('&');
      if (param_index == std::string::npos) {
        param_index = query.find('#');
        if (param_index == std::string::npos) {
          param_index = query.size();
        } else {
          param_index = 0;
        }
        break_flag = false;
      }

      std::string param = query.substr(0, param_index);
      size_t key_index = param.find('=');
      if (key_index != std::string::npos) {
        std::string key = param.substr(0, key_index);
        std::string value =
            param.substr(key_index + 1, param.size() - key_index - 1);
        if (!key.compare("url")) {
          url = std::move(value);
        } else if (!key.compare("room")) {
          room = std::move(value);
        }
      }
      if (param_index + 1 < query.size()) {
        query = query.substr(param_index + 1, query.size() - param_index - 1);
      }
    }

    if (url.empty()) {
      catagaryJson["attribution"] = "User Incorrect Useage";
      catagary = catagaryJson.toStyledString();
      Report("InvalidSchema", catagary, "", "");
      LOGE("invalid schema" << schema);
      return false;
    }
    ConnectAsync(url, room);
    return true;
  } else if (!cmd.compare("disable")) {
    DisconnectAsync();
    return true;
  } else {
    catagaryJson["attribution"] = "User Incorrect Useage";
    catagary = catagaryJson.toStyledString();
    Report("InvalidSchema", catagary, "", "");
    return false;
  }
}

void DebugRouterCore::AddStateListener(
    const std::shared_ptr<DebugRouterStateListener> &listener) {
  if (listener == nullptr) {
    return;
  }
  std::unique_lock lock(state_listeners_mutex_);
  state_listeners_.push_back(listener);
}

void DebugRouterCore::TryToReconnect() {
  if (retry_times_.load(std::memory_order_relaxed) < 3) {
    retry_times_.fetch_add(1);
    LOGI("try to reconnect: " << retry_times_.load(std::memory_order_relaxed));

    thread::DebugRouterExecutor::GetInstance().Post([=]() {
      std::this_thread::sleep_for(std::chrono::milliseconds(2000));
      Reconnect();
    });
  }
}

bool DebugRouterCore::IsConnected() {
  return connection_state_.load(std::memory_order_relaxed) == CONNECTED;
}

void DebugRouterCore::SetAppInfo(
    const std::unordered_map<std::string, std::string> &app_info) {
  for (auto it = app_info.begin(); it != app_info.end(); ++it) {
    app_info_[it->first] = it->second;
  }
}

void DebugRouterCore::SetAppInfo(const std::string &key,
                                 const std::string &value) {
  app_info_[key] = value;
}

std::string DebugRouterCore::GetAppInfoByKey(const std::string &key) {
  auto it = app_info_.find(key);
  if (it != app_info_.end()) {
    return it->second;
  }
  return "";
}

void DebugRouterCore::NotifyConnectStateByMessage(ConnectionState state) {
  std::string state_msg = GetConnectionStateMsg(state);
  if (state_msg.empty()) {
    return;
  }
  processor_->Process(state_msg);
}

std::string DebugRouterCore::GetConnectionStateMsg(ConnectionState state) {
  if (state == CONNECTED) {
    return "{\"event\": \"Customized\",\"data\": {\"type\": "
           "\"DebugRouter\",\"data\": "
           "{\"client_id\": -1,\"session_id\": -1,\"message\": {\"id\": "
           "-1,\"method\": "
           "\"DebugRouter.State\",\"params\": {\"ConnectState\": "
           "1}}},\"sender\": "
           "-1}}";
  } else if (state == DISCONNECTED) {
    return "{\"event\": \"Customized\",\"data\": {\"type\": "
           "\"DebugRouter\",\"data\": "
           "{\"client_id\": -1,\"session_id\": -1,\"message\": {\"id\": "
           "-1,\"method\": "
           "\"DebugRouter.State\",\"params\": {\"ConnectState\": "
           "0}}},\"sender\": "
           "-1}}";
  } else {
    return "";
  }
}

bool DebugRouterCore::ShouldServerRun() {
  return enable_all_sessions_.load(std::memory_order_relaxed) ||
         debug_channel_enabled_.load(std::memory_order_relaxed);
}

void DebugRouterCore::UpdateServerState() {
  server_state_update_dirty_.store(true, std::memory_order_relaxed);
  if (server_state_update_scheduled_.exchange(true,
                                              std::memory_order_relaxed)) {
    return;
  }
  thread::DebugRouterExecutor::GetInstance().Post(
      [this]() {
        for (;;) {
          server_state_update_dirty_.store(false, std::memory_order_relaxed);
          const bool should_run = ShouldServerRun();
          const bool was_running =
              server_running_.exchange(should_run, std::memory_order_relaxed);
          if (was_running != should_run) {
            if (!should_run && current_transceiver_ != nullptr &&
                current_transceiver_->GetType() == ConnectionType::kUsb) {
              // DisableDebugChannel only gates the local USB debug server.
              // Force the current USB transport through the core OnClosed()
              // path so protocol listeners and native state_listeners_ stay in
              // sync. Active websocket connections are not owned by
              // StopServer() and are intentionally left untouched here.
              auto current_transceiver = current_transceiver_;
              OnClosed(current_transceiver);
              current_transceiver->Disconnect();
            }
            for (size_t i = 0; i < kTransceiverCount; ++i) {
              if (should_run) {
                message_transceivers_[i]->StartServer();
              } else {
                message_transceivers_[i]->StopServer();
              }
            }
          }

          if (!server_state_update_dirty_.load(std::memory_order_relaxed)) {
            server_state_update_scheduled_.store(false,
                                                 std::memory_order_relaxed);
            if (!server_state_update_dirty_.load(std::memory_order_relaxed)) {
              break;
            }
            if (server_state_update_scheduled_.exchange(
                    true, std::memory_order_relaxed)) {
              break;
            }
          }
        }
      },
      /*run_now=*/false);
}

void DebugRouterCore::EnableAllSessions() {
  if (enable_all_sessions_.exchange(true, std::memory_order_relaxed)) {
    return;
  }
  LOGI("enableAllSessions");
  UpdateServerState();
}

void DebugRouterCore::EnableSingleSession(int32_t session_id) {
  // if enable all sessions, then no need to enable single session.
  if (enable_all_sessions_.load(std::memory_order_relaxed)) {
    return;
  }
  if (session_id <= 0) {
    LOGW("enableSingleSession ignored invalid session id: " << session_id);
    return;
  }
  LOGI("enableSingleSession: " << session_id);
  {
    std::unique_lock lock(enabled_sessions_mutex_);
    enabled_session_ids_.insert(session_id);
  }
}

bool DebugRouterCore::isActiveSession(int32_t session_id) {
  if (enable_all_sessions_.load(std::memory_order_relaxed)) {
    return true;
  }
  bool is_active = false;
  {
    std::shared_lock lock(enabled_sessions_mutex_);
    is_active = enabled_session_ids_.count(session_id) > 0;
  }
  return is_active;
}

bool DebugRouterCore::isEnableAllSessions() {
  return enable_all_sessions_.load(std::memory_order_relaxed);
}

void DebugRouterCore::EnableDebugChannel() {
  if (debug_channel_enabled_.exchange(true, std::memory_order_relaxed)) {
    return;
  }
  LOGI("EnableDebugChannel");
  UpdateServerState();
}

void DebugRouterCore::DisableDebugChannel() {
  if (!debug_channel_enabled_.exchange(false, std::memory_order_relaxed)) {
    return;
  }
  LOGI("DisableDebugChannel");
  if (!enable_all_sessions_.load(std::memory_order_relaxed) &&
      current_transceiver_ != nullptr &&
      current_transceiver_->GetType() == ConnectionType::kUsb) {
    connection_state_.store(DISCONNECTED, std::memory_order_relaxed);
  }
  UpdateServerState();
}

bool DebugRouterCore::IsDebugChannelEnabled() {
  return debug_channel_enabled_.load(std::memory_order_relaxed);
}

}  // namespace core
}  // namespace debugrouter
