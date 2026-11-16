// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/core/target_filter_util.h"

#include "debug_router/native/core/debug_router_core.h"
#include "debug_router/native/log/logging.h"
#include "debug_router/native/protocol/protocol.h"
#include "third_party/jsoncpp/include/json/reader.h"
#include "third_party/jsoncpp/include/json/value.h"

namespace debugrouter {
namespace core {
namespace internal {

bool ExtractIncomingTargetIdForFilter(const std::string &message,
                                      int32_t &target_id) {
  static const std::string kLegacyTargetIdKey =
      "\"" + std::string(protocol::kLegacyTargetId) + "\"";
  target_id = -1;
  if (message.find(kLegacyTargetIdKey) == std::string::npos) {
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

  const Json::Value &target_id_value = payload[protocol::kLegacyTargetId];
  if (!target_id_value.isNumeric()) {
    return false;
  }

  target_id = target_id_value.asInt();
  return target_id > 0;
}

bool ShouldDropIncomingByTargetFilter(const std::string &message,
                                      std::string_view transport_name) {
  if (DebugRouterCore::GetInstance().isEnableAllTargets()) {
    return false;
  }

  int32_t target_id = -1;
  if (!ExtractIncomingTargetIdForFilter(message, target_id)) {
    return false;
  }
  if (DebugRouterCore::GetInstance().isActiveTarget(target_id)) {
    return false;
  }

  if (!transport_name.empty()) {
    LOGV(std::string(transport_name) +
         " drop incoming message for inactive target_id: " +
         std::to_string(target_id));
  } else {
    LOGV("Drop incoming message for inactive target_id: " +
         std::to_string(target_id));
  }
  return true;
}

}  // namespace internal
}  // namespace core
}  // namespace debugrouter
