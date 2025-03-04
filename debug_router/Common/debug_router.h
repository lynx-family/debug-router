// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_COMMON_DEBUG_ROUTER_H_
#define DEBUGROUTER_COMMON_DEBUG_ROUTER_H_

#include <map>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "debug_router/Common/debug_router_global_handler.h"
#include "debug_router/Common/debug_router_session_handler.h"
#include "debug_router/Common/debug_router_slot.h"
#include "debug_router/native/base/no_destructor.h"

namespace debugrouter {
namespace common {

typedef enum { Unknown = -1, WebSocket = 0, USB } ConnectionType;

class DebugRouterStateListener {
 public:
  virtual void OnOpen(ConnectionType type) = 0;
  virtual void OnClose(int32_t code, const std::string &reason) = 0;
  virtual void OnMessage(const std::string &message) = 0;
  virtual void OnError(const std::string &error) = 0;
};

typedef enum { DISCONNECTED = 0, CONNECTING, CONNECTED } ConnectionState;

class DebugRouterSlot;
class DebugRouterGlobalHandlerDelegate;
class DebugRouterSessionHandlerDelegate;

// DebugRouter for Common
class DebugRouter {
 public:
  static DebugRouter &GetInstance();

  void ConnectAsync(const std::string &url, const std::string &room);

  void DisconnectAsync();

  void SendAsync(const std::string &message);

  void SendDataAsync(const std::string &data, const std::string &type,
                     int32_t session);

  void SendDataAsync(const std::string &data, const std::string &type,
                     int32_t session, bool is_object);

  int32_t Plug(const std::shared_ptr<DebugRouterSlot> &slot);

  void Pull(int32_t session_id);

  void AddGlobalHandler(DebugRouterGlobalHandler *handler);

  bool RemoveGlobalHandler(DebugRouterGlobalHandler *handler);

  void AddSessionHandler(DebugRouterSessionHandler *handler);

  bool RemoveSessionHandler(DebugRouterSessionHandler *handler);

  bool IsValidSchema(const std::string &schema);

  bool HandleSchema(const std::string &schema);

  bool IsConnected();

  void SetAppInfo(const std::unordered_map<std::string, std::string> &app_info);

  void SetAppInfo(const std::string &key, const std::string &value);

  std::string GetAppInfoByKey(const std::string &key);

  void AddStateListener(
      const std::shared_ptr<DebugRouterStateListener> &listener);

  DebugRouter(const DebugRouter &) = delete;
  DebugRouter &operator=(const DebugRouter &) = delete;
  DebugRouter(DebugRouter &&) = delete;
  DebugRouter &operator=(DebugRouter &&) = delete;

 private:
  friend class base::NoDestructor<DebugRouter>;
  DebugRouter();

  std::map<DebugRouterGlobalHandler *, int> global_handlers_map_;
  std::map<DebugRouterSessionHandler *, int> session_handlers_map_;
};

}  // namespace common
}  // namespace debugrouter

#endif  // DEBUGROUTER_COMMON_DEBUG_ROUTER_H_
