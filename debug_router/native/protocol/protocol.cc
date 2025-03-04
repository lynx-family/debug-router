// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/protocol/protocol.h"

#include "debug_router/native/log/logging.h"

namespace debugrouter {
namespace protocol {

bool RemoteDebugProtocolBody::IsProtocolBody4Init() {
  return event_.compare(kRemoteDebugServerEvent4Init) == 0;
}

std::shared_ptr<RemoteDebugProtocolBodyData4Init>
RemoteDebugProtocolBody::AsInit() {
  return init_data_;
}

bool RemoteDebugProtocolBody::IsProtocolBody4Custom() {
  return event_.compare(kRemoteDebugServerEvent4Custom) == 0;
}

bool RemoteDebugProtocolBody::IsProtocolBody4Register() {
  return event_.compare(kRemoteDebugServerEvent4Register) == 0;
}

std::shared_ptr<RemoteDebugProtocolBodyData4Register>
RemoteDebugProtocolBody::AsRegister() {
  return register_data_;
}

bool RemoteDebugProtocolBody::IsProtocolBody4Registered() {
  return event_.compare(kRemoteDebugServerEvent4Registered) == 0;
}

std::shared_ptr<RemoteDebugProtocolBodyData4Registered>
RemoteDebugProtocolBody::AsRegistered() {
  return registered_data_;
}

bool RemoteDebugProtocolBody::IsProtocolBody4JoinRoom() {
  return event_.compare(kRemoteDebugServerEvent4JoinRoom) == 0;
}

std::shared_ptr<RemoteDebugProtocolBodyData4JoinRoom>
RemoteDebugProtocolBody::AsJoinRoom() {
  return join_room_data_;
}

bool RemoteDebugProtocolBody::IsProtocolBody4RoomJoined() {
  return event_.compare(kRemoteDebugServerEvent4RoomJoined) == 0;
}

std::shared_ptr<RemoteDebugProtocolBodyData4RoomJoined>
RemoteDebugProtocolBody::AsRoomJoined() {
  return room_joined_data_;
}

bool RemoteDebugProtocolBody::IsProtocolBody4ChangeRoomServer() {
  return event_.compare(kRemoteDebugServerEvent4ChangeRoomServer) == 0;
}

std::shared_ptr<RemoteDebugProtocolBodyData4ChangeRoomServer>
RemoteDebugProtocolBody::AsChangeRoomServer() {
  return change_room_server_data_;
}

bool RemoteDebugProtocolBody::IsProtocolBody4ChangeRoomServerAck() {
  return event_.compare(kRemoteDebugServerEvent4ChangeRoomServerAck) == 0;
}

std::shared_ptr<RemoteDebugProtocolBodyData4ChangeRoomServerAck>
RemoteDebugProtocolBody::AsChangeRoomServerAck() {
  return change_room_server_ack_data_;
}

std::shared_ptr<RemoteDebugProtocolBodyData4Custom>
RemoteDebugProtocolBody::AsCustom() {
  return custom_data_;
}

namespace RemoteDebugProtocol {

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Init(
    const RemoteDebugPrococolClientId client_id) {
  std::shared_ptr<RemoteDebugProtocolBodyData4Init> init_data =
      std::make_shared<RemoteDebugProtocolBodyData4Init>();
  init_data->client_id_ = client_id;
  std::shared_ptr<RemoteDebugProtocolBody> init_body =
      std::make_shared<RemoteDebugProtocolBody>(kRemoteDebugServerEvent4Init,
                                                init_data);
  return init_body;
}

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Register(
    RemoteDebugPrococolClientId client_id,
    std::unordered_map<std::string, std::string> client_info,
    bool is_reconnect) {
  std::shared_ptr<RemoteDebugProtocolBodyData4Register> register_data =
      std::make_shared<RemoteDebugProtocolBodyData4Register>();
  register_data->client_id_ = client_id;
  register_data->client_info_ = client_info;
  register_data->is_reconnect_ = is_reconnect;
  std::shared_ptr<RemoteDebugProtocolBody> register_body =
      std::make_shared<RemoteDebugProtocolBody>(
          kRemoteDebugServerEvent4Register, register_data);
  return register_body;
}

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4JoinRoom(
    RemoteDebugProtocolRoomId room_id) {
  std::shared_ptr<RemoteDebugProtocolBodyData4JoinRoom> join_room_data =
      std::make_shared<RemoteDebugProtocolBodyData4JoinRoom>();
  join_room_data->room_id_ = room_id;
  std::shared_ptr<RemoteDebugProtocolBody> join_room_body =
      std::make_shared<RemoteDebugProtocolBody>(
          kRemoteDebugServerEvent4JoinRoom, join_room_data);
  return join_room_body;
}

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4RoomJoined(
    const char *room_id, RemoteDebugPrococolClientId client_id) {
  std::shared_ptr<RemoteDebugProtocolBodyData4RoomJoined> join_room_data =
      std::make_shared<RemoteDebugProtocolBodyData4RoomJoined>();
  join_room_data->room_id_ = room_id;
  std::shared_ptr<RemoteDebugProtocolBody> room_joined_body =
      std::make_shared<RemoteDebugProtocolBody>(
          kRemoteDebugServerEvent4RoomJoined, join_room_data);
  return room_joined_body;
}

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Registerd() {
  std::shared_ptr<RemoteDebugProtocolBodyData4Registered> registered_data =
      std::make_shared<RemoteDebugProtocolBodyData4Registered>();
  std::shared_ptr<RemoteDebugProtocolBody> registered_body =
      std::make_shared<RemoteDebugProtocolBody>(
          kRemoteDebugServerEvent4Registered, registered_data);
  return registered_body;
}

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4ChangeRoomServer(
    RemoteDebugPrococolClientId client_id, RemoteDebugProtocolRoomId room_id,
    const std::string &url) {
  std::shared_ptr<RemoteDebugProtocolBodyData4ChangeRoomServer>
      change_room_server_data =
          std::make_shared<RemoteDebugProtocolBodyData4ChangeRoomServer>();
  change_room_server_data->client_id_ = client_id;
  change_room_server_data->room_id_ = room_id;
  change_room_server_data->url_ = url;
  std::shared_ptr<RemoteDebugProtocolBody> change_room_server_body =
      std::make_shared<RemoteDebugProtocolBody>(
          kRemoteDebugServerEvent4ChangeRoomServer, change_room_server_data);
  return change_room_server_body;
}

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4ChangeRoomServerAck(
    RemoteDebugPrococolClientId client_id) {
  std::shared_ptr<RemoteDebugProtocolBodyData4ChangeRoomServerAck>
      change_room_server_ack_data =
          std::make_shared<RemoteDebugProtocolBodyData4ChangeRoomServerAck>();
  change_room_server_ack_data->client_id_ = client_id;
  std::shared_ptr<RemoteDebugProtocolBody> change_room_server_ack_body =
      std::make_shared<RemoteDebugProtocolBody>(
          kRemoteDebugServerEvent4ChangeRoomServerAck,
          change_room_server_ack_data);
  return change_room_server_ack_body;
}

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Custom(
    std::string type, RemoteDebugPrococolClientId client_id,
    std::shared_ptr<CustomData4CDP> cdp_data) {
  std::shared_ptr<RemoteDebugProtocolBodyData4Custom> custom_content =
      std::make_shared<RemoteDebugProtocolBodyData4Custom>();
  custom_content->type_ = type;
  custom_content->client_id_ = client_id;
  custom_content->cdp_data_ = cdp_data;
  std::shared_ptr<RemoteDebugProtocolBody> custom_body =
      std::make_shared<RemoteDebugProtocolBody>(kRemoteDebugServerEvent4Custom,
                                                custom_content);
  return custom_body;
}

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4AppMessage(
    std::string type, RemoteDebugPrococolClientId client_id,
    std::shared_ptr<AppProtocolData> app_protocol_data) {
  std::shared_ptr<RemoteDebugProtocolBodyData4Custom> custom_content =
      std::make_shared<RemoteDebugProtocolBodyData4Custom>();
  custom_content->type_ = type;
  custom_content->client_id_ = client_id;
  custom_content->app_protocol_data_ = app_protocol_data;
  std::shared_ptr<RemoteDebugProtocolBody> custom_body =
      std::make_shared<RemoteDebugProtocolBody>(kRemoteDebugServerEvent4Custom,
                                                custom_content);
  return custom_body;
}

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Custom(
    std::string type, RemoteDebugPrococolClientId client_id,
    std::shared_ptr<CustomData4SessionList> session_list_data) {
  std::shared_ptr<RemoteDebugProtocolBodyData4Custom> custom_content =
      std::make_shared<RemoteDebugProtocolBodyData4Custom>();
  custom_content->type_ = type;
  custom_content->client_id_ = client_id;
  custom_content->session_data_list_ = session_list_data;
  std::shared_ptr<RemoteDebugProtocolBody> custom_body =
      std::make_shared<RemoteDebugProtocolBody>(kRemoteDebugServerEvent4Custom,
                                                custom_content);
  return custom_body;
}

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Custom(
    std::string type, RemoteDebugPrococolClientId client_id,
    bool should_stop_at_entry) {
  std::shared_ptr<RemoteDebugProtocolBodyData4Custom> custom_content =
      std::make_shared<RemoteDebugProtocolBodyData4Custom>();
  custom_content->type_ = type;
  custom_content->client_id_ = client_id;
  if (custom_content->Is4R2DStopAtEntry() ||
      custom_content->Is4D2RStopAtEntry()) {
    custom_content->should_stop_at_entry_ = should_stop_at_entry;
  } else if (custom_content->Is4R2DStopLepusAtEntry() ||
             custom_content->Is4D2RStopLepusAtEntry()) {
    custom_content->should_stop_lepus_at_entry_ = should_stop_at_entry;
  }
  std::shared_ptr<RemoteDebugProtocolBody> custom_body =
      std::make_shared<RemoteDebugProtocolBody>(kRemoteDebugServerEvent4Custom,
                                                custom_content);
  return custom_body;
}

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Custom(
    const std::string &type, const std::string &open_type,
    const std::string &open_url) {
  std::unique_ptr<RemoteDebugProtocolBodyData4Custom> custom_content =
      std::make_unique<RemoteDebugProtocolBodyData4Custom>();
  custom_content->type_ = type;
  std::unique_ptr<CustomData4OpenCard> open_card =
      std::make_unique<CustomData4OpenCard>();
  open_card->type = open_type;
  open_card->url = open_url;
  custom_content->open_card_data_ = std::move(open_card);
  std::shared_ptr<RemoteDebugProtocolBody> custom_body =
      std::make_shared<RemoteDebugProtocolBody>(kRemoteDebugServerEvent4Custom,
                                                std::move(custom_content));
  return custom_body;
}

std::shared_ptr<RemoteDebugProtocolBody> Parse(const Json::Value &value) {
  const Json::Value &event = value[kKeyEvent];
  if (event.isString()) {
    std::string eventStr = event.asString();
    if (eventStr.compare(kRemoteDebugServerEvent4Init) == 0) {
      const Json::Value &data = value[kKeyData];
      if (data.isInt()) {
        int client_id = data.asInt();
        return CreateProtocolBody4Init(client_id);
      }
    }
    if (eventStr.compare(kRemoteDebugServerEvent4Registered) == 0) {
      return CreateProtocolBody4Registerd();
    }
    if (eventStr.compare(kRemoteDebugServerEvent4RoomJoined) == 0) {
      const Json::Value &data = value[kKeyData];
      if (data.isObject()) {
        const Json::Value &join_client_id = data[kKeyId];
        const Json::Value &join_room_id = data[kKeyRoom];
        if (join_client_id.isInt() && join_room_id.isString()) {
          return CreateProtocolBody4RoomJoined(join_room_id.asCString(),
                                               join_client_id.asInt());
        }
      }
    }
    if (eventStr.compare(kRemoteDebugServerEvent4ChangeRoomServer) == 0) {
      const Json::Value &data = value[kKeyData];
      if (data.isObject()) {
        const Json::Value &client_id = data[kKeyId];
        const Json::Value &room_id = data[kKeyRoom];
        const Json::Value &url = data[kKeyUrl];
        if (client_id.isInt() && room_id.isString() && url.isString()) {
          return CreateProtocolBody4ChangeRoomServer(
              client_id.asInt(), room_id.asString(), url.asString());
        }
      }
    }
    if (eventStr.compare(kRemoteDebugServerEvent4Custom) == 0) {
      const Json::Value &data = value[kKeyData];
      if (data.isObject()) {
        const Json::Value &message_type = data[kKeyType];
        const Json::Value &sender = data[kKeySender];
        const Json::Value &payload = data[kKeyData];
        if (message_type.isString() && sender.isInt()) {
          // parsing custom data 4 stop at entry & stop lepus at entry
          if (message_type.asString().compare(
                  kRemoteDebugProtocolBodyData4Custom4D2RStopAtEntry) == 0 ||
              message_type.asString().compare(
                  kRemoteDebugProtocolBodyData4Custom4D2RStopLepusAtEntry) ==
                  0) {
            if (payload.isObject()) {
              const Json::Value &client_id = payload[kKeyClientId];
              const Json::Value &stop_at_entry = payload[kKeyStopAtEntry];
              if (client_id.isInt() && stop_at_entry.isBool()) {
                return CreateProtocolBody4Custom(message_type.asString(),
                                                 client_id.asInt(),
                                                 stop_at_entry.asBool());
              }
            }
          }

          // parsing custom data 4 open card
          if (message_type.asString().compare(
                  kRemoteDebugProtocolBodyData4Custom4OpenCard) == 0) {
            if (payload.isObject()) {
              const Json::Value &open_type = payload[kKeyType];
              const Json::Value &open_url = payload[kKeyUrl];
              if (open_url.isString() && open_url.isString()) {
                return CreateProtocolBody4Custom(
                    kRemoteDebugProtocolBodyData4Custom4OpenCard,
                    open_type.asString(), open_url.asString());
              }
            }
          }

          if (message_type.asString().compare(
                  kRemoteDebugProtocolBodyData4Custom4ListSession) == 0) {
            auto custom_data =
                std::make_shared<RemoteDebugProtocolBodyData4Custom>();
            auto list_session = std::make_shared<CustomData4ListSession>();
            if (payload.isObject()) {
              const Json::Value client_id = payload[kKeyClientId];
              if (client_id.isInt()) {
                list_session->client_id_ = client_id.asInt();
              }
            }
            custom_data->list_session_data_ = list_session;
            custom_data->type_ =
                kRemoteDebugProtocolBodyData4Custom4ListSession;
            auto body = std::make_shared<RemoteDebugProtocolBody>(eventStr,
                                                                  custom_data);
            return body;
          }

          if (message_type.asString().compare(
                  kRemoteDebugProtocolBodyData4Custom4MessageHandler) == 0) {
            if (payload.isObject()) {
              const Json::Value &client_id = payload[kKeyClientId];
              const Json::Value &message = payload[kKeyMessage];
              const Json::Value &method = message[kKeyMethod];
              const Json::Value &params = message[kKeyParams];
              const Json::Value &message_id = message[kKeyId];
              if ((!method.isString()) || (!params.isObject()) ||
                  (!client_id.isInt()) || (!message_id.isInt())) {
                LOGW("App protocol: method, params or message_id is not valid");
                return nullptr;
              }
              std::string params_string = params.toStyledString();
              std::shared_ptr<AppMessageData> app_message_data =
                  std::make_shared<AppMessageData>(method.asString(),
                                                   message_id.asInt(),
                                                   params_string, kParams);
              auto app_protocol_data = std::make_shared<AppProtocolData>(
                  client_id.asInt(), app_message_data);
              return CreateProtocolBody4AppMessage(
                  message_type.asString(), sender.asInt(), app_protocol_data);
            }
          }

          // parsing custom data 4 cdp & other
          if (payload.isObject()) {
            const Json::Value &session_id = payload[kKeySessionId];
            const Json::Value &client_id = payload[kKeyClientId];
            const Json::Value &message = payload[kKeyMessage];
            std::shared_ptr<CustomData4CDP> cdp =
                std::make_shared<CustomData4CDP>();
            if (client_id.isInt() && session_id.isInt() &&
                (message.isString() || message.isObject())) {
              cdp->client_id_ = client_id.asInt();
              cdp->session_id_ = session_id.asInt();
              if (message.isString()) {
                cdp->message_ = message.asString();
              } else {
                Json::FastWriter fastWriter;
                cdp->message_ = fastWriter.write(message);
              }
              return CreateProtocolBody4Custom(message_type.asString(),
                                               sender.asInt(), cdp);
            }
          }
        }
      }
    }
  }
  return nullptr;
}

std::string Stringify(const std::shared_ptr<RemoteDebugProtocolBody> body) {
  return Stringify(body, -1);
}

std::string Stringify(const std::shared_ptr<RemoteDebugProtocolBody> body,
                      int mark) {
  Json::Value root;
  if (mark > -1) {
    root[kKeyMark] = mark;
  }
  root[kKeyEvent] = body->event_;
  if (body->IsProtocolBody4Init()) {
    body->AsInit()->Stringify(root[kKeyData]);
  }
  if (body->IsProtocolBody4Register()) {
    body->AsRegister()->Stringify(root[kKeyData]);
  }
  if (body->IsProtocolBody4Registered()) {
    body->AsRegistered()->Stringify(root[kKeyData]);
  }
  if (body->IsProtocolBody4RoomJoined()) {
    body->AsRoomJoined()->Stringify(root[kKeyData]);
  }
  if (body->IsProtocolBody4JoinRoom()) {
    body->AsJoinRoom()->Stringify(root[kKeyData]);
  }
  if (body->IsProtocolBody4ChangeRoomServer()) {
    body->AsChangeRoomServer()->Stringify(root[kKeyData]);
  }
  if (body->IsProtocolBody4ChangeRoomServerAck()) {
    body->AsChangeRoomServerAck()->Stringify(root[kKeyData]);
  }
  if (body->IsProtocolBody4Custom()) {
    body->AsCustom()->Stringify(root[kKeyData]);
  }
  std::string str = root.toStyledString();
  return str;
}

}  // namespace RemoteDebugProtocol
}  // namespace protocol
}  // namespace debugrouter
