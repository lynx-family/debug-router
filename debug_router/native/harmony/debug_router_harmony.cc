// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/harmony/debug_router_harmony.h"

#include <algorithm>

#include "debug_router/native/harmony/base/napi_util.h"
#include "debug_router/native/harmony/debug_router_state_listener_harmony.h"
#include "debug_router/native/harmony/native_slot_harmony.h"

namespace debugrouter {
namespace harmony {

std::vector<DebugRouterHarmony::GlobalHandlerRegistration>
    DebugRouterHarmony::global_handlers_;
std::vector<DebugRouterHarmony::SessionHandlerRegistration>
    DebugRouterHarmony::session_handlers_;
std::vector<DebugRouterHarmony::MessageHandlerRegistration>
    DebugRouterHarmony::message_handlers_;

napi_value DebugRouterHarmony::Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"createInstance", 0, DebugRouterHarmony::CreateInstance, 0, 0, 0,
       napi_static, 0},
      {"addGlobalHandler", 0, DebugRouterHarmony::AddGlobalHandler, 0, 0, 0,
       napi_static, 0},
      {"removeGlobalHandler", 0, DebugRouterHarmony::RemoveGlobalHandler, 0, 0,
       0, napi_static, 0},
      {"addSessionHandler", 0, DebugRouterHarmony::AddSessionHandler, 0, 0, 0,
       napi_static, 0},
      {"removeSessionHandler", 0, DebugRouterHarmony::RemoveSessionHandler, 0,
       0, 0, napi_static, 0},
      {"addMessageHandler", 0, DebugRouterHarmony::AddMessageHandler, 0, 0, 0,
       napi_static, 0},
      {"removeMessageHandler", 0, DebugRouterHarmony::RemoveMessageHandler, 0,
       0, 0, napi_static, 0},
      {"addStateListener", 0, DebugRouterHarmony::AddStateListener, 0, 0, 0,
       napi_static, 0},
      {"connectAsync", 0, DebugRouterHarmony::ConnectAsync, 0, 0, 0,
       napi_static, 0},
      {"disconnectAsync", 0, DebugRouterHarmony::DisconnectAsync, 0, 0, 0,
       napi_static, 0},
      {"isConnected", 0, DebugRouterHarmony::IsConnected, 0, 0, 0, napi_static,
       0},
      {"sendAsync", 0, DebugRouterHarmony::SendAsync, 0, 0, 0, napi_static, 0},
      {"sendDataAsync", 0, DebugRouterHarmony::SendDataAsync, 0, 0, 0,
       napi_static, 0},
      {"plug", 0, DebugRouterHarmony::Plug, 0, 0, 0, napi_static, 0},
      {"pull", 0, DebugRouterHarmony::Pull, 0, 0, 0, napi_static, 0},
      {"isValidSchema", 0, DebugRouterHarmony::IsValidSchema, 0, 0, 0,
       napi_static, 0},
      {"handleSchema", 0, DebugRouterHarmony::HandleSchema, 0, 0, 0,
       napi_static, 0},
      {"setAppInfo", 0, DebugRouterHarmony::SetAppInfo, 0, 0, 0, napi_static,
       0},
      {"getAppInfoByKey", 0, DebugRouterHarmony::GetAppInfoByKey, 0, 0, 0,
       napi_static, 0},
      {"enableAllSessions", 0, DebugRouterHarmony::EnableAllSessions, 0, 0, 0,
       napi_static, 0},
      {"enableSingleSession", 0, DebugRouterHarmony::EnableSingleSession, 0, 0,
       0, napi_static, 0},
      {"enableDebugChannel", 0, DebugRouterHarmony::EnableDebugChannel, 0, 0, 0,
       napi_static, 0},
      {"disableDebugChannel", 0, DebugRouterHarmony::DisableDebugChannel, 0, 0,
       0, napi_static, 0},
      {"isDebugChannelEnabled", 0, DebugRouterHarmony::IsDebugChannelEnabled, 0,
       0, 0, napi_static, 0}};
  constexpr size_t size = std::size(properties);

  napi_value cons;
  napi_status status =
      napi_define_class(env, "DebugRouterHarmony", NAPI_AUTO_LENGTH,
                        Constructor, nullptr, size, properties, &cons);

  status = napi_set_named_property(env, exports, "DebugRouterHarmony", cons);
  return exports;
}

napi_value DebugRouterHarmony::Constructor(napi_env env,
                                           napi_callback_info info) {
  size_t argc = 0;
  napi_value args[1];
  napi_value js_this;
  napi_get_cb_info(env, info, &argc, args, &js_this, nullptr);
  return js_this;
}

napi_value DebugRouterHarmony::CreateInstance(napi_env env,
                                              napi_callback_info info) {
  core::DebugRouterCore::GetInstance();
  return nullptr;
}

napi_value DebugRouterHarmony::AddGlobalHandler(napi_env env,
                                                napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  auto existing = std::find_if(
      global_handlers_.begin(), global_handlers_.end(),
      [env, value = argv[0]](const GlobalHandlerRegistration& registration) {
        return registration.handler->IsSame(env, value);
      });
  if (existing == global_handlers_.end()) {
    auto global_handler =
        std::make_shared<DebugRouterGlobalHandlerHarmony>(env, argv[0]);
    int handler_id =
        core::DebugRouterCore::GetInstance().AddGlobalHandler(global_handler);
    global_handlers_.push_back({handler_id, std::move(global_handler)});
  }
  return nullptr;
}

napi_value DebugRouterHarmony::RemoveGlobalHandler(napi_env env,
                                                   napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_value result;

  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  auto existing = std::find_if(
      global_handlers_.begin(), global_handlers_.end(),
      [env, value = argv[0]](const GlobalHandlerRegistration& registration) {
        return registration.handler->IsSame(env, value);
      });
  if (existing != global_handlers_.end()) {
    existing->handler->Deactivate();
    bool res = core::DebugRouterCore::GetInstance().RemoveGlobalHandler(
        existing->handler_id);
    global_handlers_.erase(existing);
    napi_get_boolean(env, res, &result);
    return result;
  }
  napi_get_boolean(env, false, &result);
  return result;
}

napi_value DebugRouterHarmony::AddSessionHandler(napi_env env,
                                                 napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  auto existing = std::find_if(
      session_handlers_.begin(), session_handlers_.end(),
      [env, value = argv[0]](const SessionHandlerRegistration& registration) {
        return registration.handler->IsSame(env, value);
      });
  if (existing == session_handlers_.end()) {
    auto session_handler =
        std::make_shared<DebugRouterSessionHandlerHarmony>(env, argv[0]);
    int handler_id =
        core::DebugRouterCore::GetInstance().AddSessionHandler(session_handler);
    session_handlers_.push_back({handler_id, std::move(session_handler)});
  }
  return nullptr;
}

napi_value DebugRouterHarmony::RemoveSessionHandler(napi_env env,
                                                    napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_value result;

  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  auto existing = std::find_if(
      session_handlers_.begin(), session_handlers_.end(),
      [env, value = argv[0]](const SessionHandlerRegistration& registration) {
        return registration.handler->IsSame(env, value);
      });
  if (existing != session_handlers_.end()) {
    existing->handler->Deactivate();
    bool res = core::DebugRouterCore::GetInstance().RemoveSessionHandler(
        existing->handler_id);
    session_handlers_.erase(existing);
    napi_get_boolean(env, res, &result);
    return result;
  }
  napi_get_boolean(env, false, &result);
  return result;
}

napi_value DebugRouterHarmony::AddMessageHandler(napi_env env,
                                                 napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  auto existing = std::find_if(
      message_handlers_.begin(), message_handlers_.end(),
      [env, value = argv[0]](const MessageHandlerRegistration& registration) {
        return registration.handler->IsSame(env, value);
      });
  if (existing != message_handlers_.end()) {
    return nullptr;
  }

  napi_value get_name = nullptr;
  napi_value name_value = nullptr;
  napi_status status =
      napi_get_named_property(env, argv[0], "getName", &get_name);
  if (status == napi_ok) {
    status =
        napi_call_function(env, argv[0], get_name, 0, nullptr, &name_value);
  }
  if (status != napi_ok || name_value == nullptr) {
    napi_throw_error(env, nullptr,
                     "DebugRouter message handler getName() failed");
    return nullptr;
  }
  std::string handler_name = base::NapiUtil::ConvertToString(env, name_value);
  if (handler_name.empty()) {
    napi_throw_error(env, nullptr,
                     "DebugRouter message handler name must not be empty");
    return nullptr;
  }

  auto same_name = std::find_if(
      message_handlers_.begin(), message_handlers_.end(),
      [&handler_name](const MessageHandlerRegistration& registration) {
        return registration.handler_name == handler_name;
      });
  auto message_handler = std::make_shared<DebugRouterMessageHandlerHarmony>(
      env, argv[0], handler_name);
  core::DebugRouterCore::GetInstance().AddMessageHandler(message_handler);
  if (same_name != message_handlers_.end()) {
    same_name->handler = std::move(message_handler);
  } else {
    message_handlers_.push_back(
        {std::move(handler_name), std::move(message_handler)});
  }
  return nullptr;
}

napi_value DebugRouterHarmony::RemoveMessageHandler(napi_env env,
                                                    napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  napi_value result;
  auto existing = std::find_if(
      message_handlers_.begin(), message_handlers_.end(),
      [env, value = argv[0]](const MessageHandlerRegistration& registration) {
        return registration.handler->IsSame(env, value);
      });
  bool removed = false;
  if (existing != message_handlers_.end()) {
    existing->handler->Deactivate();
    removed = core::DebugRouterCore::GetInstance().RemoveMessageHandler(
        existing->handler_name);
    message_handlers_.erase(existing);
  }
  napi_get_boolean(env, removed, &result);
  return result;
}

napi_value DebugRouterHarmony::AddStateListener(napi_env env,
                                                napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  auto stateListener =
      std::make_shared<DebugRouterStateListenerHarmony>(env, argv[0]);
  core::DebugRouterCore::GetInstance().AddStateListener(stateListener);
  return nullptr;
}

napi_value DebugRouterHarmony::ConnectAsync(napi_env env,
                                            napi_callback_info info) {
  napi_value js_this;
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  std::string url = base::NapiUtil::ConvertToString(env, argv[0]);
  std::string room = base::NapiUtil::ConvertToString(env, argv[1]);
  core::DebugRouterCore::GetInstance().ConnectAsync(url, room);
  return nullptr;
}

napi_value DebugRouterHarmony::DisconnectAsync(napi_env env,
                                               napi_callback_info info) {
  core::DebugRouterCore::GetInstance().DisconnectAsync();
  return nullptr;
}

napi_value DebugRouterHarmony::IsConnected(napi_env env,
                                           napi_callback_info info) {
  bool isConnected = core::DebugRouterCore::GetInstance().IsConnected();
  napi_value result;
  napi_get_boolean(env, isConnected, &result);
  return result;
}

napi_value DebugRouterHarmony::SendAsync(napi_env env,
                                         napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  std::string message = base::NapiUtil::ConvertToString(env, argv[0]);
  core::DebugRouterCore::GetInstance().SendAsync(message);
  return nullptr;
}

napi_value DebugRouterHarmony::SendDataAsync(napi_env env,
                                             napi_callback_info info) {
  napi_value js_this;
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  std::string type = base::NapiUtil::ConvertToString(env, argv[0]);
  int32_t session;
  napi_get_value_int32(env, argv[1], &session);
  std::string data = base::NapiUtil::ConvertToString(env, argv[2]);
  // 只为harmony提供传递data为string的接口
  core::DebugRouterCore::GetInstance().SendDataAsync(data, type, session, -1,
                                                     false);
  return nullptr;
}

napi_value DebugRouterHarmony::Plug(napi_env env, napi_callback_info info) {
  napi_value js_this;
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  std::string url = base::NapiUtil::ConvertToString(env, argv[1]);
  std::string type = base::NapiUtil::ConvertToString(env, argv[2]);
  auto slot = std::make_shared<NativeSlotHarmony>(env, argv[0], url, type);
  int session_id = core::DebugRouterCore::GetInstance().Plug(slot);
  napi_value result;
  napi_create_int32(env, session_id, &result);
  return result;
}

napi_value DebugRouterHarmony::Pull(napi_env env, napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  int session_id;
  napi_get_value_int32(env, argv[0], &session_id);
  core::DebugRouterCore::GetInstance().Pull(session_id);
  return nullptr;
}

napi_value DebugRouterHarmony::IsValidSchema(napi_env env,
                                             napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  std::string schema = base::NapiUtil::ConvertToString(env, argv[0]);
  bool res = core::DebugRouterCore::GetInstance().IsValidSchema(schema);
  napi_value result;
  napi_get_boolean(env, res, &result);
  return result;
}

napi_value DebugRouterHarmony::HandleSchema(napi_env env,
                                            napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  std::string schema = base::NapiUtil::ConvertToString(env, argv[0]);
  bool res = core::DebugRouterCore::GetInstance().HandleSchema(schema);
  napi_value result;
  napi_get_boolean(env, res, &result);
  return result;
}

napi_value DebugRouterHarmony::SetAppInfo(napi_env env,
                                          napi_callback_info info) {
  napi_value js_this;
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);

  if (argc == 1) {
    std::unordered_map<std::string, std::string> app_info;
    napi_valuetype value_type;
    napi_typeof(env, argv[0], &value_type);
    if (value_type != napi_object) {
      napi_throw_error(
          env, nullptr,
          "First argument must be an object when single parameter is provided");
      return nullptr;
    }
    napi_value property_names;
    napi_get_property_names(env, argv[0], &property_names);

    uint32_t prop_count;
    napi_get_array_length(env, property_names, &prop_count);

    for (uint32_t i = 0; i < prop_count; ++i) {
      napi_value key_js;
      napi_get_element(env, property_names, i, &key_js);

      napi_value value_js;
      napi_get_property(env, argv[0], key_js, &value_js);

      std::string key = base::NapiUtil::ConvertToString(env, key_js);
      std::string value = base::NapiUtil::ConvertToString(env, value_js);
      app_info[key] = value;
    }
    core::DebugRouterCore::GetInstance().SetAppInfo(app_info);
    return nullptr;
  } else if (argc == 2) {
    std::string key = base::NapiUtil::ConvertToString(env, argv[0]);
    std::string value = base::NapiUtil::ConvertToString(env, argv[1]);
    core::DebugRouterCore::GetInstance().SetAppInfo(key, value);
    return nullptr;
  } else {
    napi_throw_error(env, nullptr, "Invalid number of arguments");
    return nullptr;
  }
}

napi_value DebugRouterHarmony::GetAppInfoByKey(napi_env env,
                                               napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  std::string key = base::NapiUtil::ConvertToString(env, argv[0]);
  std::string value = core::DebugRouterCore::GetInstance().GetAppInfoByKey(key);
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

napi_value DebugRouterHarmony::EnableAllSessions(napi_env env,
                                                 napi_callback_info info) {
  core::DebugRouterCore::GetInstance().EnableAllSessions();
  return nullptr;
}

napi_value DebugRouterHarmony::EnableSingleSession(napi_env env,
                                                   napi_callback_info info) {
  napi_value js_this;
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, &js_this, nullptr);
  int32_t session_id;
  napi_get_value_int32(env, argv[0], &session_id);
  core::DebugRouterCore::GetInstance().EnableSingleSession(session_id);
  return nullptr;
}

napi_value DebugRouterHarmony::EnableDebugChannel(napi_env env,
                                                  napi_callback_info info) {
  core::DebugRouterCore::GetInstance().EnableDebugChannel();
  return nullptr;
}

napi_value DebugRouterHarmony::DisableDebugChannel(napi_env env,
                                                   napi_callback_info info) {
  core::DebugRouterCore::GetInstance().DisableDebugChannel();
  return nullptr;
}

napi_value DebugRouterHarmony::IsDebugChannelEnabled(napi_env env,
                                                     napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env,
                   core::DebugRouterCore::GetInstance().IsDebugChannelEnabled(),
                   &result);
  return result;
}

}  // namespace harmony
}  // namespace debugrouter
