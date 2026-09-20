// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/core/session_filter_util.h"

#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/log/logging.h"
#include "third_party/jsoncpp/include/json/reader.h"
#include "third_party/jsoncpp/include/json/value.h"

namespace debugrouter {
namespace core {
namespace internal {

namespace {

constexpr char kSessionIdKey[] = "\"session_id\"";

}  // namespace

bool ExtractIncomingSessionIdForFilter(const std::string &message,
                                       int32_t &session_id) {
  session_id = -1;
  if (message.find(kSessionIdKey) == std::string::npos) {
    return false;
  }

  Json::Reader reader;
  Json::Value root;
  if (!reader.parse(message, root) || !root.isObject()) {
    return false;
  }

  const Json::Value &data = root["data"];
  if (!data.isObject()) {
    return false;
  }

  const Json::Value &payload = data["data"];
  if (!payload.isObject()) {
    return false;
  }

  const Json::Value &session_id_value = payload["session_id"];
  if (!session_id_value.isNumeric()) {
    return false;
  }

  session_id = session_id_value.asInt();
  return session_id > 0;
}

bool ShouldDropIncomingBySessionFilter(const std::string &message,
                                       std::string_view transport_name) {
  if (DebugRouterCore::GetInstance().isEnableAllSessions()) {
    return false;
  }

  int32_t session_id = -1;
  if (!ExtractIncomingSessionIdForFilter(message, session_id)) {
    return false;
  }
  if (DebugRouterCore::GetInstance().isActiveSession(session_id)) {
    return false;
  }

  if (!transport_name.empty()) {
    LOGI(std::string(transport_name) +
         " drop incoming message for inactive session_id: " +
         std::to_string(session_id));
  } else {
    LOGI("Drop incoming message for inactive session_id: " +
         std::to_string(session_id));
  }
  return true;
}

}  // namespace internal
}  // namespace core
}  // namespace debugrouter
