// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/processor/processor.h"

#include "debug_router/native/protocol/events.h"
#include "json/reader.h"

namespace debugrouter {
namespace processor {

Processor::Processor(std::unique_ptr<MessageHandler> message_handler)
    : message_handler_(std::move(message_handler)), is_reconnect_(false) {}

void Processor::Process(const std::string &message) {
  Json::Reader reader;
  Json::Value root;
#if __cpp_exceptions >= 199711L
  try {
#endif
    reader.parse(message, root);
    process(root);
#if __cpp_exceptions >= 199711L
  } catch (const std::exception &e) {
    std::string error_message;
    error_message.append(e.what()).append(":").append(message);
    LOGE("ProcessMessage failed:" << error_message);
    reportError(error_message);
    throw std::runtime_error(error_message);
  }
#endif
}

void Processor::process(const Json::Value &root) {
  std::shared_ptr<protocol::RemoteDebugProtocolBody> body =
      protocol::RemoteDebugProtocol::Parse(root);
  if (!body) {
    return;
  }

  if (body->IsProtocolBody4Init()) {
    auto init_data = body->AsInit();
    client_id_ = init_data->client_id_;
    if (client_id_ > 0) {
      registerDevice();
    }
  } else if (body->IsProtocolBody4Registered()) {
    joinRoom();
  } else if (body->IsProtocolBody4RoomJoined()) {
    sessionList();
  } else if (body->IsProtocolBody4ChangeRoomServer()) {
    auto server_data = body->AsChangeRoomServer();
    changeRoomServer(server_data->url_, server_data->room_id_);
  } else if (body->IsProtocolBody4Custom()) {
    auto custom = body->AsCustom();
    if (custom->Is4CDP()) {
      auto cdp = custom->AsCDP();
      if (cdp->client_id_ == client_id_) {
        processMessage("CDP", cdp->session_id_, cdp->message_);
      }
    } else if (custom->Is4D2RStopAtEntry()) {
      if (custom->client_id_ == client_id_) {
        processMessage(
            protocol::kRemoteDebugProtocolBodyData4Custom4D2RStopAtEntry, -1,
            custom->AsD2RStopAtEntry() ? "true" : "false");
      }
    } else if (custom->Is4D2RStopLepusAtEntry()) {
      if (custom->client_id_ == client_id_) {
        processMessage(
            protocol::kRemoteDebugProtocolBodyData4Custom4D2RStopLepusAtEntry,
            -1, custom->AsD2RStopLepusAtEntry() ? "true" : "false");
      }
    } else if (custom->Is4OpenCard()) {
      openCard(custom->AsOpenCardData()->url);
    } else if (custom->Is4ListSession()) {
      FlushSessionList();
    } else if (custom->Is4MessageHandler()) {
      HandleAppAction(custom);
    } else {
      auto ext = custom->AsExtension();
      if (ext->client_id_ == client_id_) {
        processMessage(custom->type_, ext->session_id_, ext->message_);
      }
    }
  }
}

std::string Processor::wrapStopAtEntryMessage(
    const std::string &type, const std::string &message) const {
  bool stop = (message == "true");
  std::shared_ptr<protocol::RemoteDebugProtocolBody> custom =
      protocol::RemoteDebugProtocol::CreateProtocolBody4Custom(type, client_id_,
                                                               stop);
  return protocol::RemoteDebugProtocol::Stringify(custom);
}

std::string Processor::WrapCustomizedMessage(const std::string &type,
                                             int session_id,
                                             const std::string &message,
                                             int mark, bool isObject) {
  // handle legacy message type
  if (type == protocol::kRemoteDebugProtocolBodyData4Custom4R2DStopAtEntry ||
      type ==
          protocol::kRemoteDebugProtocolBodyData4Custom4R2DStopLepusAtEntry) {
    return wrapStopAtEntryMessage(type, message);
  }

  std::shared_ptr<protocol::CustomData4CDP> cdp_data =
      std::make_shared<protocol::CustomData4CDP>();
  cdp_data->client_id_ = client_id_;
  cdp_data->session_id_ = session_id;
  cdp_data->message_ = message;
  cdp_data->is_object_ = isObject;
  std::shared_ptr<protocol::RemoteDebugProtocolBody> custom =
      protocol::RemoteDebugProtocol::CreateProtocolBody4Custom(type, client_id_,
                                                               cdp_data);
  return protocol::RemoteDebugProtocol::Stringify(custom, mark);
}

void Processor::FlushSessionList() { sessionList(); }

void Processor::SetIsReconnect(bool is_reconnect) {
  is_reconnect_ = is_reconnect;
}

void Processor::registerDevice() {
  if (message_handler_) {
    std::shared_ptr<protocol::RemoteDebugProtocolBody> body =
        protocol::RemoteDebugProtocol::CreateProtocolBody4Register(
            client_id_, message_handler_->GetClientInfo(), is_reconnect_);
    message_handler_->SendMessage(
        protocol::RemoteDebugProtocol::Stringify(body));
  }
}

void Processor::joinRoom() {
  if (message_handler_) {
    std::shared_ptr<protocol::RemoteDebugProtocolBody> body =
        protocol::RemoteDebugProtocol::CreateProtocolBody4JoinRoom(
            message_handler_->GetRoomId());
    message_handler_->SendMessage(
        protocol::RemoteDebugProtocol::Stringify(body));
  }
}

void Processor::reportError(const std::string &error) {
  if (message_handler_) {
    message_handler_->ReportError(error);
  }
}

void Processor::sessionList() {
  if (message_handler_) {
    std::unique_ptr<protocol::CustomData4SessionList> session_list =
        std::make_unique<protocol::CustomData4SessionList>();
    Json::Reader reader;
    Json::Value info;
    for (const auto &pair : message_handler_->GetSessionList()) {
      std::shared_ptr<protocol::SessionInfo> session_info =
          std::make_shared<protocol::SessionInfo>();
      session_info->session_id_ = pair.first;

      std::string url;
      if (reader.parse(pair.second, info)) {
        session_info->type_ = info["type"].asString();
        url = info["url"].asString();
      } else {
        url = pair.second;
      }
      if (url.compare(protocol::kInvalidTempalteUrl) == 0) {
        continue;
      }
      session_info->url_ = url;
      session_list->list_.push_back(session_info);
    }
    std::shared_ptr<protocol::RemoteDebugProtocolBody> body =
        protocol::RemoteDebugProtocol::CreateProtocolBody4Custom(
            protocol::kRemoteDebugProtocolBodyData4Custom4SessionList,
            client_id_, std::move(session_list));
    message_handler_->SendMessage(
        protocol::RemoteDebugProtocol::Stringify(body));
  }
}

void Processor::changeRoomServer(const std::string &url,
                                 const std::string &room) {
  if (message_handler_) {
    std::shared_ptr<protocol::RemoteDebugProtocolBody> body =
        protocol::RemoteDebugProtocol::CreateProtocolBody4ChangeRoomServerAck(
            client_id_);
    message_handler_->SendMessage(
        protocol::RemoteDebugProtocol::Stringify(body));

    message_handler_->ChangeRoomServer(url, room);
  }
}

void Processor::openCard(const std::string &url) {
  if (message_handler_) {
    message_handler_->OpenCard(url);
  }
}

void Processor::HandleAppAction(
    const std::shared_ptr<protocol::RemoteDebugProtocolBodyData4Custom>
        custom_data) {
  std::string result = kDebugRouterErrorMessage;
  auto app_message_data = custom_data->app_protocol_data_->app_message_data_;
  if (message_handler_) {
    result = message_handler_->HandleAppAction(app_message_data->method_,
                                               app_message_data->params_);
    LOGI("MessageHandler: sync result:" << result);
  }
  const std::string method =
      (app_message_data ? app_message_data->method_ : "");
  const int32_t id = (app_message_data ? app_message_data->id_ : -1);

  std::shared_ptr<protocol::AppMessageData> app_message_data_result;
  if (result.find(kDebugRouterErrorMessage) == std::string::npos) {
    app_message_data_result = std::make_shared<protocol::AppMessageData>(
        method, id, result, protocol::kResult);
  } else {
    Json::Value error(Json::objectValue);
    error[protocol::kKeyCode] = kDebugRouterErrorCode;
    error[protocol::kKeyMessage] = kDebugRouterErrorMessage;
    app_message_data_result = std::make_shared<protocol::AppMessageData>(
        method, id, error.toStyledString(), protocol::kError);
  }
  auto app_protocol_data = std::make_shared<protocol::AppProtocolData>(
      client_id_, app_message_data_result);
  auto body_result =
      protocol::RemoteDebugProtocol::CreateProtocolBody4AppMessage(
          protocol::kRemoteDebugProtocolBodyData4Custom4MessageHandler,
          custom_data->client_id_, app_protocol_data);

  message_handler_->SendMessage(
      protocol::RemoteDebugProtocol::Stringify(body_result));
}

void Processor::processMessage(const std::string &type, int session_id,
                               const std::string &message) {
  if (message_handler_) {
    message_handler_->OnMessage(type, session_id, message);
  }
}

}  // namespace processor
}  // namespace debugrouter
