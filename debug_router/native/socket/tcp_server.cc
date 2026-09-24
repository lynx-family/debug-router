// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/socket_server_type.h"
#ifdef _WIN32
#include "debug_router/native/socket/win/tcp_server_win.h"
#else
#include "debug_router/native/socket/posix/tcp_server_posix.h"
#endif
#include "debug_router/native/core/util.h"
#include "debug_router/native/thread/debug_router_executor.h"

namespace debugrouter {
namespace socket_server {

std::shared_ptr<TcpServer> TcpServer::CreateTcpServer(
    const std::shared_ptr<TcpServerConnectionListener> &listener) {
#ifdef _WIN32
  return std::make_shared<TcpServerWin>(listener);
#else
  return std::make_shared<TcpServerPosix>(listener);
#endif
}

TcpServer::TcpServer(
    const std::shared_ptr<TcpServerConnectionListener> &listener)
    : listener_(listener), tcp_connection_(nullptr) {
  clean_executor_.init();
}

void TcpServer::ScheduleClientStop(
    const std::shared_ptr<TcpConnection> &client) {
  if (!client) {
    return;
  }
  clean_executor_.submit([client]() { client->Stop(); });
}

bool TcpServer::Send(const std::string &message) {
  std::shared_ptr<TcpConnection> client;
  {
    std::lock_guard<std::mutex> lock(client_lock_);
    client = tcp_connection_;
  }
  if (!client) {
    LOGI("TcpServerApi Send: client is null.");
    return false;
  }
  return client->Send(message);
}

#if defined(DEBUGROUTER_ENABLE_IOS_USB_START_PORT)
bool TcpServer::SetStartPort(int32_t start_port) {
  if (start_port <= 0 || start_port > UINT16_MAX - kTryPortCount + 1) {
    return false;
  }
  start_port_.store(static_cast<PORT_TYPE>(start_port),
                    std::memory_order_relaxed);
  return true;
}

PORT_TYPE TcpServer::GetStartPort() {
  return start_port_.load(std::memory_order_relaxed);
}
#endif

void TcpServer::HandleOnOpenStatus(std::shared_ptr<TcpConnection> client,
                                      int32_t code, const std::string &reason) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    std::shared_ptr<TcpConnection> old_client_;
    bool should_notify = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      if (temp_tcp_connection_ != client) {
        LOGI("TcpServerApi OnOpen: stale client open ignored.");
        return;
      }
      old_client_ = tcp_connection_;
      tcp_connection_ = client;
      should_notify = true;
    }
    LOGI("TcpServerApi OnOpen: replace old client.");
    if (old_client_ && old_client_ != client) {
      LOGI("TcpServerApi HandleOnOpenStatus: stop old client.");
      ScheduleClientStop(old_client_);
    }
    if (should_notify) {
      if (auto listener = listener_.lock()) {
        listener->OnStatusChanged(client, kConnected, code, reason);
      }
    }
  });
}

void TcpServer::HandleOnMessageStatus(std::shared_ptr<TcpConnection> client,
                                         const std::string &message) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    bool is_current_client = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      is_current_client = tcp_connection_ && tcp_connection_ == client;
    }
    if (!is_current_client) {
      LOGI("TcpServerApi OnMessage: client is null or not match.");
      return;
    }
    if (auto listener = listener_.lock()) {
      listener->OnMessage(client, message);
    }
  });
}

void TcpServer::HandleOnCloseStatus(std::shared_ptr<TcpConnection> client,
                                       ConnectionStatus status, int32_t code,
                                       const std::string &reason) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    std::shared_ptr<TcpConnection> client_to_stop;
    bool should_notify = false;
    // True if this callback tore down a client that had already been
    // promoted to tcp_connection_. Such clients must still produce a status
    // notification even if their close/error races with a newer accept.
    bool cleared_promoted_client = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      const bool superseded_by_new_accept =
          temp_tcp_connection_ && temp_tcp_connection_ != client;
      if (superseded_by_new_accept || !tcp_connection_ || tcp_connection_ != client) {
        if (tcp_connection_ == client) {
          tcp_connection_ = nullptr;
          cleared_promoted_client = true;
        }
        if (temp_tcp_connection_ == client) {
          temp_tcp_connection_ = nullptr;
        }
        client_to_stop = client;
      } else {
        LOGI(
            "TcpServerApi HandleOnCloseStatus: close curr client for "
            "OnClose.");
        client_to_stop = tcp_connection_;
        tcp_connection_ = nullptr;
        if (temp_tcp_connection_ == client) {
          temp_tcp_connection_ = nullptr;
        }
        should_notify = true;
      }
    }
    if (!should_notify && !cleared_promoted_client) {
      LOGI(
          "TcpServerApi OnClose: stale client closed, stop stale client "
          "without notifying current connection.");
      if (client_to_stop) {
        ScheduleClientStop(client_to_stop);
      }
      return;
    }
    if (client_to_stop) {
      ScheduleClientStop(client_to_stop);
    }
    if (auto listener = listener_.lock()) {
      listener->OnStatusChanged(client, status, code, reason);
    }
  });
}

void TcpServer::HandleOnErrorStatus(std::shared_ptr<TcpConnection> client,
                                       ConnectionStatus status, int32_t code,
                                       const std::string &reason) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    std::shared_ptr<TcpConnection> client_to_stop;
    bool should_notify = false;
    // True if this callback tore down a client that had already been
    // promoted to tcp_connection_. Such clients must still produce a status
    // notification even if their close/error races with a newer accept.
    bool cleared_promoted_client = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      const bool superseded_by_new_accept =
          temp_tcp_connection_ && temp_tcp_connection_ != client;
      if (superseded_by_new_accept || !tcp_connection_ || tcp_connection_ != client) {
        if (tcp_connection_ == client) {
          tcp_connection_ = nullptr;
          cleared_promoted_client = true;
        }
        if (temp_tcp_connection_ == client) {
          temp_tcp_connection_ = nullptr;
        }
        client_to_stop = client;
      } else {
        LOGI(
            "TcpServerApi HandleOnErrorStatus: close curr client for "
            "OnError.");
        client_to_stop = tcp_connection_;
        tcp_connection_ = nullptr;
        if (temp_tcp_connection_ == client) {
          temp_tcp_connection_ = nullptr;
        }
        should_notify = true;
      }
    }
    if (!should_notify && !cleared_promoted_client) {
      LOGI(
          "TcpServerApi OnError: stale client errored, stop stale client "
          "without notifying current connection.");
      if (client_to_stop) {
        ScheduleClientStop(client_to_stop);
      }
      return;
    }
    if (client_to_stop) {
      ScheduleClientStop(client_to_stop);
    }
    if (auto listener = listener_.lock()) {
      listener->OnStatusChanged(client, status, code, reason);
    }
  });
}

void TcpServer::NotifyInit(int32_t code, const std::string &info) {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    if (auto listener = listener_.lock()) {
      listener->OnInit(code, info);
    }
  });
}

void TcpServer::setEnableServer(bool enable) {
  LOGI("TcpServer::setEnableServer:" << enable);
  // notify only when transition from false to true
  bool should_notify = false;
  {
    std::lock_guard<std::mutex> lock(running_mutex_);
    should_notify =
        !is_running_.exchange(enable, std::memory_order_relaxed) && enable;
  }
  if (should_notify) {
    running_condition_.notify_one();
  }
}

void TcpServer::StartServer() { setEnableServer(true); }

void TcpServer::StopServer() {
  std::shared_ptr<TcpConnection> current_client;
  std::shared_ptr<TcpConnection> pending_client;
  setEnableServer(false);
  // Close socket if it's valid
  SocketType socket_fd = socket_fd_.load(std::memory_order_acquire);
  if (socket_fd != kInvalidSocket) {
#ifdef _WIN32
    shutdown(socket_fd, SD_BOTH);
#else
    shutdown(socket_fd, SHUT_RDWR);
#endif
  }

  Close();
  {
    std::unique_lock<std::mutex> lock(serving_mutex_);
    serving_condition_.wait(lock, [this]() { return !is_serving_; });
  }
  {
    std::lock_guard<std::mutex> lock(client_lock_);
    current_client = tcp_connection_;
    pending_client = temp_tcp_connection_;
    tcp_connection_ = nullptr;
    temp_tcp_connection_ = nullptr;
  }
  if (current_client) {
    current_client->Stop();
  }
  if (pending_client && pending_client != current_client) {
    pending_client->Stop();
  }
}

void TcpServer::ThreadFunc(std::shared_ptr<TcpServer> tcp_server) {
  int count = 0;
  while (true) {
    {
      std::unique_lock running_lock(tcp_server->running_mutex_);
      tcp_server->running_condition_.wait(running_lock, [=]() {
        return tcp_server->is_running_.load(std::memory_order_relaxed) ==
               true;
      });
      std::lock_guard<std::mutex> serving_lock(tcp_server->serving_mutex_);
      tcp_server->is_serving_ = true;
    }
    LOGI("Init start:" << count);
    tcp_server->Start();
    {
      std::lock_guard<std::mutex> lock(tcp_server->serving_mutex_);
      tcp_server->is_serving_ = false;
    }
    tcp_server->serving_condition_.notify_all();
    count++;
  }
}

void TcpServer::Init() {
  std::thread listen_thread(ThreadFunc, shared_from_this());
  listen_thread.detach();
}

// close server socket
void TcpServer::Close() {
  SocketType socket_fd =
      socket_fd_.exchange(kInvalidSocket, std::memory_order_acq_rel);
  LOGI("TcpServer::Close server socket_fd_:" << socket_fd);
  // The atomic exchange above is the only cross-thread double-close guard we
  // need here. Backend-specific CloseSocket() keeps the kInvalidSocket check so
  // all close validation remains centralized in one place.
  CloseSocket(socket_fd);
}

void TcpServer::Disconnect() {
  thread::DebugRouterExecutor::GetInstance().Post([=]() {
    std::shared_ptr<TcpConnection> client_to_stop;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      client_to_stop = tcp_connection_;
      tcp_connection_ = nullptr;
      if (temp_tcp_connection_ == client_to_stop) {
        temp_tcp_connection_ = nullptr;
      }
    }
    if (client_to_stop) {
      LOGI("TcpServerApi Disconnect: stop curr client.");
      ScheduleClientStop(client_to_stop);
    }
  });
}

TcpServer::~TcpServer() {
  clean_executor_.shutdown();
  std::shared_ptr<TcpConnection> current_client;
  std::shared_ptr<TcpConnection> pending_client;
  {
    std::lock_guard<std::mutex> lock(client_lock_);
    current_client = tcp_connection_;
    pending_client = temp_tcp_connection_;
    tcp_connection_ = nullptr;
    temp_tcp_connection_ = nullptr;
  }
  if (current_client) {
    current_client->Stop();
  }
  if (pending_client && pending_client != current_client) {
    pending_client->Stop();
  }
}

}  // namespace socket_server
}  // namespace debugrouter
