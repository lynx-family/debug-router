// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router_core.h"

#include <atomic>
#include <mutex>

#include "debug_router/native/base/no_destructor.h"
#include "debug_router/native/core/debug_router_config.h"
#include "debug_router/native/core/debug_router_message_handler.h"
#include "debug_router/native/core/debug_router_state_listener.h"
#include "debug_router/native/core/native_slot.h"
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
    std::lock_guard<std::recursive_mutex> lock(
        DebugRouterCore::GetInstance().slots_mutex_);
    const auto &slots = DebugRouterCore::GetInstance().slots_;
    if (!slots.empty()) {
      for (auto it = slots.begin(); it != slots.end(); ++it) {
        Json::Value session_info;
        session_info["type"] = it->second->GetType();
        session_info["url"] = it->second->GetUrl();
        session_list[it->first] = session_info.toStyledString();
      }
    }
    return session_list;
  }

  std::string HandleAppAction(const std::string &method,
                              const std::string &params) override {
    DebugRouterMessageHandler *handler =
        DebugRouterCore::GetInstance().message_handlers_[method];
    if (handler) {
      LOGI("DebugRouterCore: handle exists: " << method);
      return handler->Handle(params);
    } else {
      LOGI("DebugRouterCore: handle does not exists: " << method);
      return "{\"code\":-2,\"message\":\"not implemented\"}";
    }
  }

  void OnMessage(const std::string &type, int session_id,
                 const std::string &message) override {
    if (session_id < 0) {
      const auto &global_handler_map =
          DebugRouterCore::GetInstance().global_handler_map_;
      for (auto it : global_handler_map) {
        it.second->OnMessage(message, type);
      }
      return;
    }

    const auto &session_handler_map =
        DebugRouterCore::GetInstance().session_handler_map_;
    std::lock_guard<std::recursive_mutex> lock(
        DebugRouterCore::GetInstance().slots_mutex_);
    const auto &slots = DebugRouterCore::GetInstance().slots_;
    for (auto it : session_handler_map) {
      it.second->OnMessage(message, type, session_id);
    }

    if (!slots.empty()) {
      auto it = slots.find(session_id);
      if (it != slots.end()) {
        it->second->OnMessage(message, type);
      }
    }
  }

  void SendMessage(const std::string &message) override {
    DebugRouterCore::GetInstance().Send(message);
  }

  void OpenCard(const std::string &url) override {
    const auto &global_handler_map_ =
        DebugRouterCore::GetInstance().global_handler_map_;
    for (auto it : global_handler_map_) {
      it.second->OpenCard(url);
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
      processor_(nullptr),
      retry_times_(0),
      handler_count_(1) {
  message_transceivers_.push_back(std::make_shared<net::WebSocketClient>());
  message_transceivers_.push_back(std::make_shared<net::SocketServerClient>());

  for (auto it = message_transceivers_.begin();
       it != message_transceivers_.end(); ++it) {
    (*it)->Init();
    (*it)->SetDelegate(this);
  }
  std::unique_ptr<processor::MessageHandler> handler =
      std::make_unique<MessageHandlerCore>();
  processor_ = std::make_unique<processor::Processor>(std::move(handler));
  thread::DebugRouterExecutor::GetInstance().Start();
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
    LOGI("DebugRouterCore::Reconnect.");
    Connect(server_url_, room_id_, true);
  }
}

void DebugRouterCore::Connect(const std::string &url, const std::string &room,
                              bool is_reconnect) {
  if (!is_reconnect) {
    retry_times_.store(0, std::memory_order_relaxed);
  }
  LOGI(
      "connect. retry times: " << retry_times_.load(std::memory_order_relaxed));
  Disconnect();
  connection_state_.store(CONNECTING, std::memory_order_relaxed);
  for (auto it = message_transceivers_.begin();
       it != message_transceivers_.end(); ++it) {
    if ((*it)->Connect(url)) {
      break;
    }
  }
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
  std::lock_guard<std::recursive_mutex> lock(slots_mutex_);
  max_session_id_++;
  slots_[max_session_id_] = slot;
  LOGI("plug session: " << max_session_id_);
  if (connection_state_.load(std::memory_order_relaxed) == CONNECTED) {
    processor_->FlushSessionList();
  }
  NotifyConnectStateByMessage(GetConnectionState());
  for (auto it : session_handler_map_) {
    it.second->OnSessionCreate(max_session_id_, slot->GetUrl());
  }
  return max_session_id_;
}

int32_t DebugRouterCore::GetUSBPort() {
  return usb_port_.load(std::memory_order_relaxed);
}

void DebugRouterCore::Pull(int32_t session_id_) {
  LOGI("pull session: " << session_id_);
  std::lock_guard<std::recursive_mutex> lock(slots_mutex_);
  slots_.erase(session_id_);
  if (connection_state_.load(std::memory_order_relaxed) == CONNECTED) {
    processor_->FlushSessionList();
  }
  for (auto it : session_handler_map_) {
    it.second->OnSessionDestroy(session_id_);
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

  for (auto it = state_listeners_.begin(); it != state_listeners_.end(); it++) {
    LOGI("do state_listeners_ onopen.");
    (*it)->OnOpen(connect_type);
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
  if (retry_times_.load(std::memory_order_relaxed) >= 3) {
    for (auto it = state_listeners_.begin(); it != state_listeners_.end();
         it++) {
      LOGI("do state_listeners_ onclose.");
      (*it)->OnClose(-1, "unknown reason");
    }
  }

  if (transceiver->GetType() == ConnectionType::kWebSocket) {
    if (current_transceiver_ == nullptr ||
        current_transceiver_->GetType() == ConnectionType::kWebSocket) {
      std::string result = DebugRouterConfigs::GetInstance().GetConfig(
          kForbidReconnectWhenClose, "false");
      if (result == "true") {
        LOGI("onClosed: forbid reconnect");
        return;
      }
      LOGI("onClosed: try to reconnect");
      TryToReconnect();
    }
  }
}

void DebugRouterCore::OnFailure(
    const std::shared_ptr<MessageTransceiver> &transceiver) {
  LOGI("DebugRouterCore: onFailure.");
  if ((current_transceiver_ != nullptr &&
       transceiver != current_transceiver_) ||
      connection_state_.load(std::memory_order_relaxed) == DISCONNECTED) {
    return;
  }
  connection_state_.store(DISCONNECTED, std::memory_order_relaxed);
  current_transceiver_ = nullptr;
  NotifyConnectStateByMessage(DISCONNECTED);
  if (retry_times_.load(std::memory_order_relaxed) >= 3) {
    for (auto it = state_listeners_.begin(); it != state_listeners_.end();
         it++) {
      // TODO(zhoumingsong.smile): add more details
      LOGI("do state_listeners_ onfailure.");
      (*it)->OnError("unknown error");
    }
  }

  if (transceiver->GetType() == ConnectionType::kWebSocket) {
    if (current_transceiver_ == nullptr ||
        current_transceiver_->GetType() == ConnectionType::kWebSocket) {
      LOGI("onFailure: try to reconnect");
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
  LOGI("DebugRouter OnMessage.");
  processor_->Process(message);
  for (auto it = state_listeners_.begin(); it != state_listeners_.end(); it++) {
    LOGI("do state_listeners_ onmessage.");
    (*it)->OnMessage(message);
  }
}

DebugRouterCore::~DebugRouterCore() {
  // TODO(zhoumingsong.smile): Stop websocketClient's thread
  // It's not a good way to do this
}

int DebugRouterCore::AddGlobalHandler(DebugRouterGlobalHandler *handler) {
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
  DebugRouterGlobalHandler *handler = global_handler_map_[handler_id];
  if (handler) {
    global_handler_map_.erase(handler_id);
    return true;
  }
  return false;
}

void DebugRouterCore::AddMessageHandler(DebugRouterMessageHandler *handler) {
  if (!handler) {
    return;
  }
  std::string handler_name = handler->GetName();
  if (message_handlers_.find(handler_name) == message_handlers_.end()) {
    LOGI("DebugRouterCore: add a new message handler successfully.");
  } else {
    LOGI("DebugRouterCore: " << handler_name << " handler has been override.");
  }
  message_handlers_[handler_name] = handler;
}

bool DebugRouterCore::RemoveMessageHandler(const std::string &handler_name) {
  size_t erased_count = message_handlers_.erase(handler_name);
  return erased_count > 0;
}

int DebugRouterCore::AddSessionHandler(DebugRouterSessionHandler *handler) {
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
  DebugRouterSessionHandler *handler = session_handler_map_[handler_id];
  if (handler) {
    session_handler_map_.erase(handler_id);
    return true;
  }
  return false;
}

bool DebugRouterCore::IsValidSchema(const std::string &schema) {
  return schema.find("remote_debug_lynx") != std::string::npos;
}

std::string DebugRouterCore::GetRoomId() { return room_id_; }
std::string DebugRouterCore::GetServerUrl() { return server_url_; }

bool DebugRouterCore::HandleSchema(const std::string &schema) {
  std::string url, room;
  int32_t query_index = static_cast<int32_t>(schema.find('?'));
  if (query_index == std::string::npos) {
    LOGE("Invalid schema:" << schema);
    return false;
  }
  std::string path = schema.substr(0, query_index);
  int32_t cmd_index = static_cast<int32_t>(path.find_last_of('/'));
  if (cmd_index == std::string::npos) {
    LOGE("Invalid schema:" << schema);
    return false;
  }
  std::string cmd = path.substr(cmd_index + 1, path.size() - cmd_index - 1);
  if (!cmd.compare("enable")) {
    std::string query =
        schema.substr(query_index + 1, schema.size() - query_index - 1);
    bool break_flag = true;
    while (break_flag) {
      int32_t param_index = static_cast<int32_t>(query.find('&'));
      if (param_index == std::string::npos) {
        param_index = static_cast<int32_t>(query.find('#'));
        if (param_index == std::string::npos) {
          param_index = static_cast<int32_t>(query.size());
        } else {
          param_index = 0;
        }
        break_flag = false;
      }

      std::string param = query.substr(0, param_index);
      int32_t key_index = static_cast<int32_t>(param.find('='));
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
      LOGE("invalid schema" << schema);
      return false;
    }
    ConnectAsync(url, room);
    return true;
  } else if (!cmd.compare("disable")) {
    DisconnectAsync();
    return true;
  } else {
    return false;
  }
}

void DebugRouterCore::AddStateListener(
    const std::shared_ptr<DebugRouterStateListener> &listener) {
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
  LOGI("notify connect state: " << state_msg);
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

}  // namespace core
}  // namespace debugrouter
