// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_CORE_H_
#define DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_CORE_H_

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "debug_router/native/core/debug_router_global_handler.h"
#include "debug_router/native/core/debug_router_message_handler.h"
#include "debug_router/native/core/debug_router_state_listener.h"
#include "debug_router/native/core/debug_router_target_handler.h"
#include "debug_router/native/core/message_transceiver.h"
#include "debug_router/native/core/native_target.h"
#include "debug_router/native/report/debug_router_native_report.h"

namespace debugrouter {
namespace thread {
class DebugRouterExecutor;
}
namespace processor {
class Processor;
}
namespace net {
class SocketServerClient;
}

namespace core {

#ifdef TESTING
class DebugRouterCoreConcurrencyTest;
#endif

typedef enum { DISCONNECTED = -1, CONNECTING, CONNECTED } ConnectionState;
// whether the connection is the first connection
typedef enum {
  UNINIT = -1,
  FIRST_CONNECT,
  NON_FIRST_CONNECT
} WebSocketConnectType;

#if ENABLE_MESSAGE_IMPL
static constexpr size_t kTransceiverCount = 2;
#else
static constexpr size_t kTransceiverCount = 0;
#endif

class DebugRouterCore : public MessageTransceiverDelegate {
 public:
  friend class MessageHandlerCore;
#ifdef TESTING
  friend class DebugRouterCoreConcurrencyTest;
#endif

  static DebugRouterCore &GetInstance();
  DebugRouterCore();

  virtual void OnOpen(
      const std::shared_ptr<MessageTransceiver> &transceiver) override;
  virtual void OnClosed(
      const std::shared_ptr<MessageTransceiver> &transceiver) override;
  virtual void OnFailure(const std::shared_ptr<MessageTransceiver> &transceiver,
                         const std::string &error_message,
                         int error_code) override;
  virtual void OnMessage(
      const std::string &message,
      const std::shared_ptr<MessageTransceiver> &transceiver) override;

#ifdef TESTING
  void ProcessMessageForTest(const std::string &message);
#endif

  void Connect(const std::string &url, const std::string &room);
  void ConnectAsync(const std::string &url, const std::string &room);

  void Disconnect();
  void DisconnectAsync();

  // Sends a fully wrapped protocol message without applying target filtering.
  // Callers that send target-bound Customized payloads must use SendData /
  // SendDataAsync so active-target filtering is enforced centrally.
  void Send(const std::string &message);

  // Async variant of Send(). This is also a raw bypass and does not apply
  // target filtering.
  void SendAsync(const std::string &message);

  // Sends a target-bound Customized payload and applies active-target
  // filtering for target_id > 0. Control messages should use Send / SendAsync.
  void SendData(const std::string &data, const std::string &type,
                int32_t target_id, int32_t mark, bool is_object);

  void SendDataAsync(const std::string &data, const std::string &type,
                     int32_t target_id, int32_t mark, bool is_object);

  int32_t Plug(const std::shared_ptr<core::NativeTarget> &target);

  int32_t GetUSBPort();

#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
  bool SetUSBStartPort(int32_t start_port);
#endif

  void Pull(int32_t target_id);

  std::string GetRoomId();
  std::string GetServerUrl();

  ConnectionState GetConnectionState();

  void Report(const std::string &eventName, const std::string &category,
              const std::string &metric, const std::string &extra);

  int AddGlobalHandler(DebugRouterGlobalHandler *handler);
  int AddGlobalHandler(
      const std::shared_ptr<DebugRouterGlobalHandler> &handler);
  bool RemoveGlobalHandler(int handler_id);

  void AddMessageHandler(DebugRouterMessageHandler *handler);
  void AddMessageHandler(
      const std::shared_ptr<DebugRouterMessageHandler> &handler);
  bool RemoveMessageHandler(const std::string &handler_name);

  int AddTargetHandler(DebugRouterTargetHandler *handler);
  int AddTargetHandler(
      const std::shared_ptr<DebugRouterTargetHandler> &handler);
  bool RemoveTargetHandler(int handler_id);

  bool IsValidSchema(const std::string &schema);

  bool HandleSchema(const std::string &schema);

  bool IsConnected();

  void SetAppInfo(const std::unordered_map<std::string, std::string> &app_info);

  void SetAppInfo(const std::string &key, const std::string &value);

  std::string GetAppInfoByKey(const std::string &key);

  void SetReportDelegate(
      std::unique_ptr<report::DebugRouterNativeReport> report);

  void AddStateListener(
      const std::shared_ptr<core::DebugRouterStateListener> &listener);

  // these two methods are conflictive, only one of them can be enabled
  void EnableAllTargets();
  // Records the target IDs allowed by isActiveTarget(). This does not
  // affect whether the local server stays available. target_id must be > 0.
  void EnableSingleTarget(int32_t target_id);
  // Debug channel only controls whether the server should stay available.
  // It does not bypass target filtering or alter message routing semantics.
  void EnableDebugChannel();
  void DisableDebugChannel();
  bool IsDebugChannelEnabled();

  bool isActiveTarget(int32_t target_id);
  bool isEnableAllTargets();

  DebugRouterCore(const DebugRouterCore &) = delete;
  DebugRouterCore &operator=(const DebugRouterCore &) = delete;
  DebugRouterCore(DebugRouterCore &&) = delete;
  DebugRouterCore &operator=(DebugRouterCore &&) = delete;

  virtual ~DebugRouterCore();

 protected:
  std::shared_mutex targets_mutex_;
  std::shared_mutex state_listeners_mutex_;
  std::shared_mutex global_handler_mutex_;
  std::shared_mutex target_handler_mutex_;
  std::shared_mutex message_handler_mutex_;
  friend class MessageHandlerCore;
  std::unordered_map<int32_t, std::shared_ptr<core::NativeTarget> > targets_;
  std::string room_id_;
  std::string server_url_;
  std::string host_url_;
  std::unordered_map<std::string, std::shared_ptr<DebugRouterMessageHandler> >
      message_handlers_;
  std::unordered_map<std::string, std::string> app_info_;

  // Track global and target handlers for registration and removal.
  std::unordered_map<int, std::shared_ptr<DebugRouterGlobalHandler> >
      global_handler_map_;
  std::unordered_map<int, std::shared_ptr<DebugRouterTargetHandler> >
      target_handler_map_;

 private:
  bool ShouldServerRun();
  void UpdateServerState();
  void Reconnect();
  void Connect(const std::string &url, const std::string &room,
               bool is_reconnect);
  std::atomic<ConnectionState> connection_state_;
#if ENABLE_MESSAGE_IMPL
  // intermediate state, need to be deleted after connection is refactored
  std::shared_ptr<net::SocketServerClient> socket_server_client_;
#endif
  std::shared_ptr<MessageTransceiver> current_transceiver_;
  std::array<std::shared_ptr<MessageTransceiver>, kTransceiverCount>
      message_transceivers_;
  int32_t max_target_id_;
  std::unique_ptr<report::DebugRouterNativeReport> report_;
  std::unique_ptr<debugrouter::processor::Processor> processor_;
  std::vector<std::shared_ptr<core::DebugRouterStateListener> >
      state_listeners_;
  std::atomic<int> retry_times_;
  void TryToReconnect();
  void NotifyConnectStateByMessage(ConnectionState state);
  std::string GetConnectionStateMsg(ConnectionState state);
  std::atomic<int> handler_count_;
  std::atomic<WebSocketConnectType> is_first_connect_;
  // Caches the last server state requested by UpdateServerState().
  std::atomic<bool> server_running_{false};
  // Ensures UpdateServerState() has at most one executor task in flight.
  // Repeated callers only flip dirty and let that single task absorb the
  // merged state change instead of enqueueing more StartServer/StopServer work.
  std::atomic<bool> server_state_update_scheduled_{false};
  // Records that another UpdateServerState() request arrived while the current
  // task was running, so the task must re-check ShouldServerRun() once more
  // before it exits and apply only the latest merged server state.
  std::atomic<bool> server_state_update_dirty_{false};

  std::atomic<bool> enable_all_targets_{false};
  std::atomic<bool> debug_channel_enabled_{false};
  std::unordered_set<int32_t> enabled_target_ids_;
  std::shared_mutex enabled_targets_mutex_;
};

}  // namespace core
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_CORE_H_
