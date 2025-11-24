// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_PROTOCOL_PROTOCOL_H_
#define DEBUGROUTER_NATIVE_PROTOCOL_PROTOCOL_H_

#include <memory>
#include <string>
#include <unordered_map>

#include "debug_router/native/log/logging.h"
#include "debug_router/native/protocol/md5.h"
#include "json/json.h"

namespace debugrouter {
namespace protocol {

extern const char *kRemoteDebugServerEvent4Unknow;
extern const char *kRemoteDebugServerEvent4Init;
extern const char *kRemoteDebugServerEvent4Registered;
extern const char *kRemoteDebugServerEvent4Register;
extern const char *kRemoteDebugServerEvent4JoinRoom;
extern const char *kRemoteDebugServerEvent4RoomJoined;
extern const char *kRemoteDebugServerEvent4ChangeRoomServer;
extern const char *kRemoteDebugServerEvent4ChangeRoomServerAck;
extern const char *kRemoteDebugServerEvent4Custom;

extern const char *kRemoteDebugProtocolBodyData4CDP;
extern const char *kRemoteDebugProtocolBodyData4Custom4ListSession;
extern const char *kRemoteDebugProtocolBodyData4Custom4MessageHandler;
extern const char *kRemoteDebugProtocolBodyData4Custom4SessionList;
extern const char *kRemoteDebugProtocolBodyData4Custom4OpenSession;
extern const char *kRemoteDebugProtocolBodyData4Custom4CloseSession;
extern const char *kRemoteDebugProtocolBodyData4Custom4D2RStopAtEntry;
extern const char *kRemoteDebugProtocolBodyData4Custom4R2DStopAtEntry;
extern const char *kRemoteDebugProtocolBodyData4Custom4D2RStopLepusAtEntry;
extern const char *kRemoteDebugProtocolBodyData4Custom4R2DStopLepusAtEntry;
extern const char *kRemoteDebugProtocolBodyData4Custom4OpenCard;
extern const char *kRemoteDebugProtocolBodyData4Custom4OpenType4Url;

extern const char *kKeyId;
extern const char *kKeyRoom;
extern const char *kKeyType;
extern const char *kKeyInfo;
extern const char *kKeyClientId;
extern const char *kKeySessionId;
extern const char *kKeyUrl;
extern const char *kKeyCode;
extern const char *kKeyMessage;
extern const char *kKeyMethod;
extern const char *kKeyResult;
extern const char *kKeyParams;
extern const char *kKeyError;
extern const char *kKeySender;
extern const char *kKeyData;
extern const char *kKeyEvent;
extern const char *kKeyStopAtEntry;
extern const char *kKeySignature;
extern const char *kKeyMark;
extern const char *kKeyReconnect;

extern const char *kRuntimeType;

extern const char *kSignatureSalt;

using RemoteDebugPrococolClientId = uint32_t;
using RemoteDebugProtocolRoomId = std::string;

struct Stringifiable {
  virtual ~Stringifiable() = default;

  virtual void Stringify(Json::Value &v) {
    v = Json::Value(Json::objectValue);
  };
};

struct RemoteDebugProtocolBodyData4Init : public Stringifiable {
  RemoteDebugPrococolClientId client_id_;

  ~RemoteDebugProtocolBodyData4Init() override = default;

  void Stringify(Json::Value &data) override { data = client_id_; };
};

struct RemoteDebugProtocolBodyData4JoinRoom : public Stringifiable {
  RemoteDebugProtocolRoomId room_id_;

  ~RemoteDebugProtocolBodyData4JoinRoom() override = default;

  void Stringify(Json::Value &data) override { data = room_id_; };
};

struct RemoteDebugProtocolBodyData4RoomJoined : public Stringifiable {
  RemoteDebugProtocolRoomId room_id_;
  RemoteDebugPrococolClientId client_id_;

  ~RemoteDebugProtocolBodyData4RoomJoined() override = default;

  void Stringify(Json::Value &data) override {
    Json::Value v(Json::objectValue);
    v[kKeyId] = client_id_;
    v[kKeyRoom] = room_id_;
    v[kKeyType] = kRuntimeType;
    data = v;
  };
};

struct RemoteDebugProtocolBodyData4Register : public Stringifiable {
  RemoteDebugPrococolClientId client_id_;
  std::unordered_map<std::string, std::string> client_info_;
  bool is_reconnect_;

  ~RemoteDebugProtocolBodyData4Register() override = default;

  void Stringify(Json::Value &data) override {
    Json::Value v(Json::objectValue);
    v[kKeyId] = client_id_;
    v[kKeyType] = std::string(kRuntimeType);
    v[kKeyReconnect] = is_reconnect_;
    Json::Value info(Json::objectValue);
    for (auto item : client_info_) {
      info[item.first] = item.second;
    }
    v[kKeyInfo] = info;
    data = v;
  };
};

struct RemoteDebugProtocolBodyData4Registered : public Stringifiable {
  ~RemoteDebugProtocolBodyData4Registered() override = default;

  void Stringify(Json::Value &data) override {
    Json::Value v(Json::objectValue);
    data = v;
  }
};

struct RemoteDebugProtocolBodyData4ChangeRoomServer : public Stringifiable {
  RemoteDebugPrococolClientId client_id_;
  RemoteDebugProtocolRoomId room_id_;
  std::string url_;

  ~RemoteDebugProtocolBodyData4ChangeRoomServer() override = default;

  void Stringify(Json::Value &data) override {
    Json::Value v(Json::objectValue);
    v[kKeyId] = client_id_;
    v[kKeyRoom] = room_id_;
    v[kKeyUrl] = url_;
    data = v;
  };
};

struct RemoteDebugProtocolBodyData4ChangeRoomServerAck : public Stringifiable {
  RemoteDebugPrococolClientId client_id_;

  ~RemoteDebugProtocolBodyData4ChangeRoomServerAck() override = default;

  void Stringify(Json::Value &data) override { data = client_id_; };
};

struct SessionInfo {
  int session_id_;
  std::string url_;
  std::string type_;
};

struct CustomData4SessionList : public Stringifiable {
  std::vector<std::shared_ptr<SessionInfo>> list_;

  ~CustomData4SessionList() override = default;

  void Stringify(Json::Value &ref) override {
    Json::Value v(Json::arrayValue);
    for (std::shared_ptr<SessionInfo> it : list_) {
      Json::Value sessionItem(Json::objectValue);
      sessionItem[kKeySessionId] = it->session_id_;
      sessionItem[kKeyUrl] = it->url_;
      sessionItem[kKeyType] = it->type_;
      v[v.size()] = sessionItem;
    }
    ref = v;
  }
};

enum AppMessageDataUnionType {
  kParams = 0,
  kResult = 1,
  kError = 2,
};

struct AppMessageData : public Stringifiable {
  std::string method_;
  int32_t id_;

  std::string params_;
  std::string result_;
  std::string error_;

  // is not part of message
  AppMessageDataUnionType union_type_;

  void Stringify(Json::Value &ref) override {
    Json::Value value(Json::objectValue);
    value[kKeyMethod] = method_;
    value[kKeyId] = id_;
    switch (union_type_) {
      case kParams:
        value[kKeyParams] = params_;
        break;
      case kResult:
        value[kKeyResult] = result_;
        break;
      case kError:
        value[kKeyError] = error_;
      default:
        LOGE("AppMessageData Stringify: unknown type");
    }
    ref[kKeyMessage] = value.toStyledString();
  }

  ~AppMessageData() {}

  AppMessageData(const std::string &method, int32_t id,
                 const std::string &params, AppMessageDataUnionType union_type)
      : method_(method), id_(id), union_type_(union_type) {
    switch (union_type) {
      case kParams:
        params_ = params;
        break;
      case kResult:
        result_ = params;
        break;
      case kError:
        error_ = params;
      default:
        LOGE("AppMessageData Init: unknown type");
    }
  }
};

struct CustomData4CDP : public Stringifiable {
  int session_id_;
  RemoteDebugPrococolClientId client_id_;
  std::string message_;
  bool is_object_ = false;

  ~CustomData4CDP() override = default;

  void Stringify(Json::Value &ref) override {
    Json::Value v(Json::objectValue);
    v[kKeySessionId] = session_id_;
    v[kKeyClientId] = client_id_;
    if (is_object_) {
      Json::Reader reader;
      Json::Value object;
      reader.parse(message_, object);
      v[kKeyMessage] = object;
    } else {
      v[kKeyMessage] = message_;
    }
    ref = v;
  }
};

typedef CustomData4CDP CustomData4Extension;

struct CustomData4OpenCard : public Stringifiable {
  std::string type;
  std::string url;
  void Stringify(Json::Value &ref) override {
    Json::Value v(Json::objectValue);
    v[kKeyType] = type;
    v[kKeyUrl] = url;
    ref = v;
  }
};

struct CustomData4ListSession : public Stringifiable {
  RemoteDebugPrococolClientId client_id_;
  void Stringify(Json::Value &ref) override {
    Json::Value v(Json::objectValue);
    v[kKeyClientId] = client_id_;
    ref = v;
  }
};

struct AppProtocolData : public Stringifiable {
  RemoteDebugPrococolClientId client_id_;
  std::shared_ptr<AppMessageData> app_message_data_;
  ~AppProtocolData() = default;
  void Stringify(Json::Value &ref) override {
    Json::Value value(Json::objectValue);
    value[kKeyClientId] = client_id_;
    if (app_message_data_) {
      app_message_data_->Stringify(value);
    }
    ref = value;
  }

  AppProtocolData(RemoteDebugPrococolClientId clientId,
                  const std::shared_ptr<AppMessageData> &app_message_data)
      : client_id_(clientId), app_message_data_(app_message_data) {}
};

struct RemoteDebugProtocolBodyData4Custom : public Stringifiable {
  std::string type_;
  // TODO(zhanglei): change to union
  std::shared_ptr<CustomData4CDP> cdp_data_;
  std::shared_ptr<CustomData4SessionList> session_data_list_;
  std::shared_ptr<CustomData4OpenCard> open_card_data_;
  std::shared_ptr<CustomData4ListSession>
      list_session_data_;  // is diffent from CustomData4SessionList !!
  std::shared_ptr<AppProtocolData> app_protocol_data_;
  bool should_stop_at_entry_;
  bool should_stop_lepus_at_entry_;
  RemoteDebugPrococolClientId client_id_;

  ~RemoteDebugProtocolBodyData4Custom() = default;

  void Stringify(Json::Value &ref) override {
    Json::Value v(Json::objectValue);
    v[kKeyType] = type_;
    v[kKeySender] = client_id_;

    if (Is4SessionList()) {
      this->session_data_list_->Stringify(v[kKeyData]);
      // concatenate signature data
      Json::FastWriter writer;
      std::string sig_data = writer.write(v[kKeyData]) + kSignatureSalt;
      // eliminate '\n'
      std::string::size_type pos = 0;
      std::string sig_data_tight = sig_data;
      while ((pos = sig_data_tight.find("\n", pos)) != std::string::npos) {
        sig_data_tight = sig_data_tight.replace(pos, 1, "");
      }
      // generate signature
      v[kKeySignature] = md5(sig_data_tight);
    } else if (Is4R2DStopAtEntry()) {
      v[kKeyData] = should_stop_at_entry_;
    } else if (Is4R2DStopLepusAtEntry()) {
      v[kKeyData] = should_stop_lepus_at_entry_;
    } else if (Is4MessageHandler()) {
      app_protocol_data_->Stringify(v[kKeyData]);
    } else {
      this->cdp_data_->Stringify(v[kKeyData]);
    }
    ref = v;
  }
  bool Is4CDP() { return type_.compare(kRemoteDebugProtocolBodyData4CDP) == 0; }
  std::shared_ptr<CustomData4CDP> AsCDP() { return cdp_data_; }
  std::shared_ptr<CustomData4Extension> AsExtension() { return cdp_data_; }
  bool Is4SessionList() {
    return type_.compare(kRemoteDebugProtocolBodyData4Custom4SessionList) == 0;
  }
  std::shared_ptr<CustomData4SessionList> AsSessionList() {
    return session_data_list_;
  }
  bool Is4R2DStopAtEntry() {
    return type_.compare(kRemoteDebugProtocolBodyData4Custom4R2DStopAtEntry) ==
           0;
  }
  bool AsR2DStopAtEntry() { return should_stop_at_entry_; }
  bool Is4D2RStopAtEntry() {
    return type_.compare(kRemoteDebugProtocolBodyData4Custom4D2RStopAtEntry) ==
           0;
  }
  bool AsD2RStopAtEntry() { return should_stop_at_entry_; }
  bool Is4R2DStopLepusAtEntry() {
    return type_.compare(
               kRemoteDebugProtocolBodyData4Custom4R2DStopLepusAtEntry) == 0;
  }
  bool AsR2DStopLepusAtEntry() { return should_stop_lepus_at_entry_; }
  bool Is4D2RStopLepusAtEntry() {
    return type_.compare(
               kRemoteDebugProtocolBodyData4Custom4D2RStopLepusAtEntry) == 0;
  }
  bool AsD2RStopLepusAtEntry() { return should_stop_lepus_at_entry_; }
  bool Is4OpenCard() {
    return !type_.compare(kRemoteDebugProtocolBodyData4Custom4OpenCard);
  }
  bool Is4ListSession() {
    return !type_.compare(kRemoteDebugProtocolBodyData4Custom4ListSession);
  }
  bool Is4MessageHandler() {
    return !type_.compare(kRemoteDebugProtocolBodyData4Custom4MessageHandler);
  }
  std::shared_ptr<CustomData4OpenCard> AsOpenCardData() {
    return open_card_data_;
  }
};

struct RemoteDebugProtocolBody {
  std::string event_;
  union {
    std::shared_ptr<RemoteDebugProtocolBodyData4Init> init_data_;
    std::shared_ptr<RemoteDebugProtocolBodyData4Register> register_data_;
    std::shared_ptr<RemoteDebugProtocolBodyData4Registered> registered_data_;
    std::shared_ptr<RemoteDebugProtocolBodyData4JoinRoom> join_room_data_;
    std::shared_ptr<RemoteDebugProtocolBodyData4RoomJoined> room_joined_data_;
    std::shared_ptr<RemoteDebugProtocolBodyData4ChangeRoomServer>
        change_room_server_data_;
    std::shared_ptr<RemoteDebugProtocolBodyData4ChangeRoomServerAck>
        change_room_server_ack_data_;
    std::shared_ptr<RemoteDebugProtocolBodyData4Custom> custom_data_;
  };

  RemoteDebugProtocolBody(
      const std::string event,
      std::shared_ptr<RemoteDebugProtocolBodyData4Init> init_data)
      : event_(event), init_data_(init_data) {}

  RemoteDebugProtocolBody(
      const std::string event,
      std::shared_ptr<RemoteDebugProtocolBodyData4Register> register_data)
      : event_(event), register_data_(register_data) {}

  RemoteDebugProtocolBody(
      const std::string event,
      std::shared_ptr<RemoteDebugProtocolBodyData4Registered> registered_data)
      : event_(event), registered_data_(registered_data) {}

  RemoteDebugProtocolBody(
      const std::string event,
      std::shared_ptr<RemoteDebugProtocolBodyData4JoinRoom> join_room_data)
      : event_(event), join_room_data_(join_room_data) {}

  RemoteDebugProtocolBody(
      const std::string event,
      std::shared_ptr<RemoteDebugProtocolBodyData4RoomJoined> room_joined_data)
      : event_(event), room_joined_data_(room_joined_data) {}

  RemoteDebugProtocolBody(
      const std::string event,
      std::shared_ptr<RemoteDebugProtocolBodyData4ChangeRoomServer>
          change_room_server_data)
      : event_(event), change_room_server_data_(change_room_server_data) {}

  RemoteDebugProtocolBody(
      const std::string event,
      std::shared_ptr<RemoteDebugProtocolBodyData4ChangeRoomServerAck>
          change_room_server_ack_data)
      : event_(event),
        change_room_server_ack_data_(change_room_server_ack_data) {}

  RemoteDebugProtocolBody(
      const std::string event,
      std::shared_ptr<RemoteDebugProtocolBodyData4Custom> custom_data)
      : event_(event), custom_data_(custom_data) {}

  bool IsProtocolBody4Init();
  std::shared_ptr<RemoteDebugProtocolBodyData4Init> AsInit();

  bool IsProtocolBody4Register();
  std::shared_ptr<RemoteDebugProtocolBodyData4Register> AsRegister();

  bool IsProtocolBody4Registered();
  std::shared_ptr<RemoteDebugProtocolBodyData4Registered> AsRegistered();

  bool IsProtocolBody4JoinRoom();
  std::shared_ptr<RemoteDebugProtocolBodyData4JoinRoom> AsJoinRoom();

  bool IsProtocolBody4RoomJoined();
  std::shared_ptr<RemoteDebugProtocolBodyData4RoomJoined> AsRoomJoined();

  bool IsProtocolBody4ChangeRoomServer();
  std::shared_ptr<RemoteDebugProtocolBodyData4ChangeRoomServer>
  AsChangeRoomServer();

  bool IsProtocolBody4ChangeRoomServerAck();
  std::shared_ptr<RemoteDebugProtocolBodyData4ChangeRoomServerAck>
  AsChangeRoomServerAck();

  bool IsProtocolBody4Custom();
  std::shared_ptr<RemoteDebugProtocolBodyData4Custom> AsCustom();

  ~RemoteDebugProtocolBody() {
    if (IsProtocolBody4Init()) {
      init_data_.~shared_ptr();
    }
    if (IsProtocolBody4Register()) {
      register_data_.~shared_ptr();
    }
    if (IsProtocolBody4Registered()) {
      registered_data_.~shared_ptr();
    }
    if (IsProtocolBody4JoinRoom()) {
      join_room_data_.~shared_ptr();
    }
    if (IsProtocolBody4RoomJoined()) {
      room_joined_data_.~shared_ptr();
    }
    if (IsProtocolBody4ChangeRoomServer()) {
      change_room_server_data_.~shared_ptr();
    }
    if (IsProtocolBody4ChangeRoomServerAck()) {
      change_room_server_ack_data_.~shared_ptr();
    }
    if (IsProtocolBody4Custom()) {
      custom_data_.~shared_ptr();
    }
  }
};

namespace RemoteDebugProtocol {

std::shared_ptr<RemoteDebugProtocolBody> Parse(const Json::Value &value);
std::string Stringify(const std::shared_ptr<RemoteDebugProtocolBody> body);
std::string Stringify(const std::shared_ptr<RemoteDebugProtocolBody> body,
                      int mark);
std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Register(
    RemoteDebugPrococolClientId client_id,
    std::unordered_map<std::string, std::string> client_info,
    bool is_reconnect);
std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4JoinRoom(
    RemoteDebugProtocolRoomId room_id);
std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Init(
    RemoteDebugPrococolClientId client_id);
std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4RoomJoined(
    const char *room_id, RemoteDebugPrococolClientId client_id);
std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Registerd();
std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4ChangeRoomServer(
    RemoteDebugPrococolClientId client_id, RemoteDebugProtocolRoomId room_id,
    const std::string &url);
std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4ChangeRoomServerAck(
    RemoteDebugPrococolClientId client_id);
std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Custom(
    std::string type, RemoteDebugPrococolClientId client_id,
    std::shared_ptr<CustomData4CDP> cdp_data);

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4AppMessage(
    std::string type, RemoteDebugPrococolClientId client_id,
    std::shared_ptr<AppProtocolData> app_protocol_data);

std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Custom(
    std::string type, RemoteDebugPrococolClientId client_id,
    std::shared_ptr<CustomData4SessionList> session_list);
std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Custom(
    std::string type, RemoteDebugPrococolClientId client_id,
    bool should_stop_at_entry);
std::shared_ptr<RemoteDebugProtocolBody> CreateProtocolBody4Custom(
    const std::string &type, const std::string &open_type,
    const std::string &open_url);
}  // namespace RemoteDebugProtocol

}  // namespace protocol
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_PROTOCOL_PROTOCOL_H_
