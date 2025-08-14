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
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "debug_router/native/core/debug_router_global_handler.h"
#include "debug_router/native/core/debug_router_message_handler.h"
#include "debug_router/native/core/debug_router_session_handler.h"
#include "debug_router/native/core/debug_router_state_listener.h"
#include "debug_router/native/core/message_transceiver.h"
#include "debug_router/native/core/native_slot.h"
#include "debug_router/native/report/debug_router_native_report.h"

namespace debugrouter {
namespace thread {
class DebugRouterExecutor;
}
namespace processor {
class Processor;
}

namespace core {

typedef enum { DISCONNECTED = -1, CONNECTING, CONNECTED } ConnectionState;
// whether the connection is the first connection
typedef enum {
  UNINIT = -1,
  FIRST_CONNECT,
  NON_FIRST_CONNECT
} WebSocketConnectType;

class DebugRouterSlot;

#if ENABLE_MESSAGE_IMPL
static constexpr size_t kTransceiverCount = 2;
#else
static constexpr size_t kTransceiverCount = 0;
#endif

class DebugRouterCore : public MessageTransceiverDelegate {
 public:
  friend class MessageHandlerCore;

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

  virtual void OnInit(const std::shared_ptr<MessageTransceiver> &transceiver,
                      int32_t code, const std::string &info) override;

  void Connect(const std::string &url, const std::string &room);
  void ConnectAsync(const std::string &url, const std::string &room);

  void Disconnect();
  void DisconnectAsync();

  void Send(const std::string &message);

  void SendAsync(const std::string &message);

  void SendData(const std::string &data, const std::string &type,
                int32_t session, int32_t mark, bool is_object);

  void SendDataAsync(const std::string &data, const std::string &type,
                     int32_t session, int32_t mark, bool is_object);

  int32_t Plug(const std::shared_ptr<core::NativeSlot> &slot);

  int32_t GetUSBPort();

  void Pull(int32_t session_id);

  std::string GetRoomId();
  std::string GetServerUrl();

  ConnectionState GetConnectionState();

  void Report(const std::string &eventName, const std::string &category,
              const std::string &metric, const std::string &extra);

  int AddGlobalHandler(DebugRouterGlobalHandler *handler);
  bool RemoveGlobalHandler(int handler_id);

  void AddMessageHandler(DebugRouterMessageHandler *handler);
  bool RemoveMessageHandler(const std::string &handler_name);

  int AddSessionHandler(DebugRouterSessionHandler *handler);
  bool RemoveSessionHandler(int handler_id);

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

  DebugRouterCore(const DebugRouterCore &) = delete;
  DebugRouterCore &operator=(const DebugRouterCore &) = delete;
  DebugRouterCore(DebugRouterCore &&) = delete;
  DebugRouterCore &operator=(DebugRouterCore &&) = delete;

  virtual ~DebugRouterCore();

 protected:
  std::recursive_mutex slots_mutex_;
  std::recursive_mutex state_listeners_mutex_;
  friend class MessageHandlerCore;
  std::unordered_map<int32_t, std::shared_ptr<core::NativeSlot> > slots_;
  std::string room_id_;
  std::string server_url_;
  std::string host_url_;
  std::unordered_map<std::string, DebugRouterMessageHandler *>
      message_handlers_;
  std::unordered_map<std::string, std::string> app_info_;

  // for add global handler and session handler, judge if handler is valid
  // for remove global handler and session handler
  std::unordered_map<int, DebugRouterGlobalHandler *> global_handler_map_;
  std::unordered_map<int, DebugRouterSessionHandler *> session_handler_map_;

 private:
  void Reconnect();
  void Connect(const std::string &url, const std::string &room,
               bool is_reconnect);
  std::atomic<ConnectionState> connection_state_;
  std::shared_ptr<MessageTransceiver> current_transceiver_;
  std::array<std::shared_ptr<MessageTransceiver>, kTransceiverCount>
      message_transceivers_;
  int32_t max_session_id_;
  std::unique_ptr<report::DebugRouterNativeReport> report_;
  std::unique_ptr<debugrouter::processor::Processor> processor_;
  std::vector<std::shared_ptr<core::DebugRouterStateListener> >
      state_listeners_;
  std::atomic<int> retry_times_;
  void TryToReconnect();
  void NotifyConnectStateByMessage(ConnectionState state);
  std::string GetConnectionStateMsg(ConnectionState state);
  std::atomic<int32_t> usb_port_;
  std::atomic<int> handler_count_;
  std::atomic<WebSocketConnectType> is_first_connect_;
};

}  // namespace core
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_CORE_DEBUG_ROUTER_CORE_H_
