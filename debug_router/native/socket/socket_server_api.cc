// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/socket_server_api.h"

#ifdef _WIN32
#include <winsock2.h>

#include "debug_router/native/socket/win/socket_server_win.h"
#else
#include <sys/socket.h>

#include "debug_router/native/socket/posix/socket_server_posix.h"
#endif
#include <utility>

#include "debug_router/native/core/util.h"
#include "debug_router/native/thread/debug_router_executor.h"

namespace debugrouter {
namespace socket_server {

std::shared_ptr<SocketServer> SocketServer::CreateSocketServer(
    const std::shared_ptr<SocketServerConnectionListener> &listener) {
#ifdef _WIN32
  SocketServer *socket_server = new SocketServerWin(listener);
#else
  SocketServer *socket_server = new SocketServerPosix(listener);
#endif
  return std::shared_ptr<SocketServer>(socket_server, [](SocketServer *server) {
    // Stop while the dynamic platform object is still fully alive. Its
    // destructor repeats this idempotently for direct internal construction.
    server->StopServer();
    delete server;
  });
}

SocketServer::SocketServer(
    const std::shared_ptr<SocketServerConnectionListener> &listener)
    : listener_(listener), usb_client_(nullptr) {
  clean_executor_.init();
}

void SocketServer::ScheduleClientStop(
    const std::shared_ptr<UsbClient> &client) {
  if (!client) {
    return;
  }
  clean_executor_.submit([client]() { client->Stop(); });
}

bool SocketServer::Send(const std::string &message) {
  std::shared_ptr<UsbClient> client;
  {
    std::lock_guard<std::mutex> lock(client_lock_);
    client = usb_client_;
  }
  if (!client) {
    LOGI("SocketServerApi Send: client is null.");
    return false;
  }
  return client->Send(message);
}

void SocketServer::HandleOnOpenStatus(std::shared_ptr<UsbClient> client,
                                      int32_t code, const std::string &reason) {
  std::weak_ptr<SocketServer> weak_server = weak_from_this();
  auto callback = [weak_server, this, client = std::move(client), code,
                   reason]() {
    auto keep_alive = weak_server.lock();
    if (!keep_alive) {
      return;
    }
    std::shared_ptr<UsbClient> old_client_;
    bool should_notify = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      if (temp_usb_client_ != client) {
        LOGI("SocketServerApi OnOpen: stale client open ignored.");
        return;
      }
      old_client_ = usb_client_;
      usb_client_ = client;
      should_notify = true;
    }
    LOGI("SocketServerApi OnOpen: replace old client.");
    if (old_client_ && old_client_ != client) {
      LOGI("SocketServerApi HandleOnOpenStatus: stop old client.");
      ScheduleClientStop(old_client_);
    }
    if (should_notify) {
      if (auto listener = listener_.lock()) {
        listener->OnStatusChanged(kConnected, code, reason);
      }
    }
  };
  thread::DebugRouterExecutor::GetInstance().Post(std::move(callback));
}

void SocketServer::HandleOnMessageStatus(std::shared_ptr<UsbClient> client,
                                         const std::string &message) {
  std::weak_ptr<SocketServer> weak_server = weak_from_this();
  auto callback = [weak_server, this, client = std::move(client), message]() {
    auto keep_alive = weak_server.lock();
    if (!keep_alive) {
      return;
    }
    bool is_current_client = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      is_current_client = usb_client_ && usb_client_ == client;
    }
    if (!is_current_client) {
      LOGI("SocketServerApi OnMessage: client is null or not match.");
      return;
    }
    if (auto listener = listener_.lock()) {
      listener->OnMessage(message);
    }
  };
  thread::DebugRouterExecutor::GetInstance().Post(std::move(callback));
}

void SocketServer::HandleOnCloseStatus(std::shared_ptr<UsbClient> client,
                                       ConnectionStatus status, int32_t code,
                                       const std::string &reason) {
  std::weak_ptr<SocketServer> weak_server = weak_from_this();
  thread::DebugRouterExecutor::GetInstance().Post([weak_server, this, client,
                                                   status, code, reason]() {
    auto keep_alive = weak_server.lock();
    if (!keep_alive) {
      return;
    }
    std::shared_ptr<UsbClient> client_to_stop;
    bool should_notify = false;
    // True if this callback tore down a client that had already been
    // promoted to usb_client_. Such clients must still produce a status
    // notification even if their close/error races with a newer accept.
    bool cleared_promoted_client = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      const bool superseded_by_new_accept =
          temp_usb_client_ && temp_usb_client_ != client;
      if (superseded_by_new_accept || !usb_client_ || usb_client_ != client) {
        if (usb_client_ == client) {
          usb_client_ = nullptr;
          cleared_promoted_client = true;
        }
        if (temp_usb_client_ == client) {
          temp_usb_client_ = nullptr;
        }
        client_to_stop = client;
      } else {
        LOGI(
            "SocketServerApi HandleOnCloseStatus: close curr client for "
            "OnClose.");
        client_to_stop = usb_client_;
        usb_client_ = nullptr;
        if (temp_usb_client_ == client) {
          temp_usb_client_ = nullptr;
        }
        should_notify = true;
      }
    }
    if (!should_notify && !cleared_promoted_client) {
      LOGI(
          "SocketServerApi OnClose: stale client closed, stop stale client "
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
      listener->OnStatusChanged(status, code, reason);
    }
  });
}

void SocketServer::HandleOnErrorStatus(std::shared_ptr<UsbClient> client,
                                       ConnectionStatus status, int32_t code,
                                       const std::string &reason) {
  std::weak_ptr<SocketServer> weak_server = weak_from_this();
  thread::DebugRouterExecutor::GetInstance().Post([weak_server, this, client,
                                                   status, code, reason]() {
    auto keep_alive = weak_server.lock();
    if (!keep_alive) {
      return;
    }
    std::shared_ptr<UsbClient> client_to_stop;
    bool should_notify = false;
    // True if this callback tore down a client that had already been
    // promoted to usb_client_. Such clients must still produce a status
    // notification even if their close/error races with a newer accept.
    bool cleared_promoted_client = false;
    {
      std::lock_guard<std::mutex> lock(client_lock_);
      const bool superseded_by_new_accept =
          temp_usb_client_ && temp_usb_client_ != client;
      if (superseded_by_new_accept || !usb_client_ || usb_client_ != client) {
        if (usb_client_ == client) {
          usb_client_ = nullptr;
          cleared_promoted_client = true;
        }
        if (temp_usb_client_ == client) {
          temp_usb_client_ = nullptr;
        }
        client_to_stop = client;
      } else {
        LOGI(
            "SocketServerApi HandleOnErrorStatus: close curr client for "
            "OnError.");
        client_to_stop = usb_client_;
        usb_client_ = nullptr;
        if (temp_usb_client_ == client) {
          temp_usb_client_ = nullptr;
        }
        should_notify = true;
      }
    }
    if (!should_notify && !cleared_promoted_client) {
      LOGI(
          "SocketServerApi OnError: stale client errored, stop stale client "
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
      listener->OnStatusChanged(status, code, reason);
    }
  });
}

void SocketServer::NotifyInit(int32_t code, const std::string &info) {
  uint64_t generation = 0;
  {
    std::lock_guard<std::mutex> lock(running_mutex_);
    generation = listener_generation_;
    if (listener_should_exit_ || !is_running_.load(std::memory_order_relaxed) ||
        generation != server_generation_) {
      return;
    }
  }
  std::weak_ptr<SocketServer> weak_server = weak_from_this();
  thread::DebugRouterExecutor::GetInstance().Post(
      [weak_server, generation, code, info]() {
        auto socket_server = weak_server.lock();
        if (!socket_server ||
            !socket_server->IsListenerGenerationActive(generation)) {
          return;
        }
        if (auto listener = socket_server->listener_.lock()) {
          listener->OnInit(code, info);
        }
      });
}

void SocketServer::setEnableServer(bool enable) {
  LOGI("SocketServer::setEnableServer:" << enable);
  if (enable) {
    StartServer();
  } else {
    StopServer();
  }
}

void SocketServer::StartServer() {
  std::lock_guard<std::mutex> operation_lock(server_operation_mutex_);
  bool should_notify = false;
  {
    std::lock_guard<std::mutex> lock(running_mutex_);
    if (initialized_ && !listen_thread_.joinable()) {
      listener_should_exit_ = false;
      listen_thread_ = std::thread(ListenerThreadFunc, this);
    }
    if (!is_running_.exchange(true, std::memory_order_relaxed)) {
      ++server_generation_;
      should_notify = true;
    }
  }
  if (should_notify) {
    running_condition_.notify_one();
  }
}

void SocketServer::StopServer() {
  std::lock_guard<std::mutex> operation_lock(server_operation_mutex_);
  std::shared_ptr<UsbClient> current_client;
  std::shared_ptr<UsbClient> pending_client;
  SocketType socket_fd = kInvalidSocket;
  {
    std::lock_guard<std::mutex> lock(running_mutex_);
    is_running_.store(false, std::memory_order_relaxed);
    listener_should_exit_ = true;
    ++server_generation_;
    socket_fd = socket_fd_.load(std::memory_order_acquire);
  }
#if defined(TESTING)
  if (stop_requested_latch_for_test_) {
    stop_requested_latch_for_test_->CountDown();
  }
#endif
  running_condition_.notify_all();

  if (socket_fd != kInvalidSocket) {
#ifdef _WIN32
    shutdown(socket_fd, SD_BOTH);
#else
    shutdown(socket_fd, SHUT_RDWR);
#endif
  }

  Close();
  {
    std::lock_guard<std::mutex> lock(client_lock_);
    current_client = usb_client_;
    pending_client = temp_usb_client_;
    usb_client_ = nullptr;
    temp_usb_client_ = nullptr;
  }
  if (current_client) {
    current_client->Stop();
  }
  if (pending_client && pending_client != current_client) {
    pending_client->Stop();
  }

  if (listen_thread_.joinable()) {
    listen_thread_.join();
  }
}

void SocketServer::ThreadFunc(std::shared_ptr<SocketServer> socket_server) {
  // Keep the protected entry point source-compatible. Internal listener
  // generations use ListenerThreadFunc so the thread does not own the server.
  ListenerThreadFunc(socket_server.get());
}

void SocketServer::ListenerThreadFunc(SocketServer *socket_server) {
  int count = 0;
  while (true) {
    {
      std::unique_lock lock(socket_server->running_mutex_);
      socket_server->running_condition_.wait(lock, [socket_server]() {
        return socket_server->listener_should_exit_ ||
               socket_server->is_running_.load(std::memory_order_relaxed);
      });
      if (socket_server->listener_should_exit_) {
        return;
      }
      socket_server->listener_generation_ = socket_server->server_generation_;
    }
    LOGI("Init start:" << count);
    socket_server->Start();
    count++;
  }
}

void SocketServer::Init() {
  std::lock_guard<std::mutex> operation_lock(server_operation_mutex_);
  std::lock_guard<std::mutex> lock(running_mutex_);
  initialized_ = true;
  if (!listen_thread_.joinable()) {
    listener_should_exit_ = false;
    listen_thread_ = std::thread(ListenerThreadFunc, this);
  }
}

bool SocketServer::TryPublishSocket(SocketType socket_fd) {
  std::lock_guard<std::mutex> lock(running_mutex_);
  if (listener_should_exit_ || !is_running_.load(std::memory_order_relaxed) ||
      listener_generation_ != server_generation_) {
    return false;
  }
  socket_fd_.store(socket_fd, std::memory_order_release);
  return true;
}

bool SocketServer::TryInstallPendingClient(
    const std::shared_ptr<UsbClient> &client,
    std::shared_ptr<UsbClient> *old_client) {
  std::lock_guard<std::mutex> running_lock(running_mutex_);
  if (listener_should_exit_ || !is_running_.load(std::memory_order_relaxed) ||
      listener_generation_ != server_generation_) {
    return false;
  }
  std::lock_guard<std::mutex> client_lock(client_lock_);
  *old_client = temp_usb_client_;
  temp_usb_client_ = client;
  return true;
}

#if defined(TESTING)
void SocketServer::WaitForClientListenerReleaseForTest() {
  CountDownLatch *created_latch = client_listener_created_latch_for_test_;
  CountDownLatch *release_latch = release_client_listener_latch_for_test_;
  if (created_latch) {
    created_latch->CountDown();
  }
  if (release_latch) {
    release_latch->Await();
  }
}
#endif

bool SocketServer::IsListenerGenerationActive(uint64_t generation) {
  std::lock_guard<std::mutex> lock(running_mutex_);
  return !listener_should_exit_ &&
         is_running_.load(std::memory_order_relaxed) &&
         generation == server_generation_;
}

// close server socket
void SocketServer::Close() {
  SocketType socket_fd =
      socket_fd_.exchange(kInvalidSocket, std::memory_order_acq_rel);
  LOGI("SocketServer::Close server socket_fd_:" << socket_fd);
  // The atomic exchange above is the only cross-thread double-close guard we
  // need here. Backend-specific CloseSocket() keeps the kInvalidSocket check so
  // all close validation remains centralized in one place.
  CloseSocket(socket_fd);
}

void SocketServer::Disconnect() {
  uint64_t generation = 0;
  std::shared_ptr<UsbClient> target;
  if (!SnapshotClientForDisconnect(&generation, &target)) {
    return;
  }
  std::weak_ptr<SocketServer> weak_server = weak_from_this();
  thread::DebugRouterExecutor::GetInstance().Post(
      [weak_server, generation, target = std::move(target)]() {
        auto socket_server = weak_server.lock();
        if (!socket_server) {
          return;
        }
        std::shared_ptr<UsbClient> client_to_stop =
            socket_server->TakeClientForDisconnect(generation, target);
        if (client_to_stop) {
          LOGI("SocketServerApi Disconnect: stop curr client.");
          socket_server->ScheduleClientStop(client_to_stop);
        }
      });
}

bool SocketServer::SnapshotClientForDisconnect(
    uint64_t *generation, std::shared_ptr<UsbClient> *target) {
  std::lock_guard<std::mutex> running_lock(running_mutex_);
  if (listener_should_exit_ || !is_running_.load(std::memory_order_relaxed)) {
    return false;
  }
  std::lock_guard<std::mutex> client_lock(client_lock_);
  if (!usb_client_) {
    return false;
  }
  *generation = server_generation_;
  *target = usb_client_;
  return true;
}

std::shared_ptr<UsbClient> SocketServer::TakeClientForDisconnect(
    uint64_t generation, const std::shared_ptr<UsbClient> &target) {
  std::lock_guard<std::mutex> running_lock(running_mutex_);
  if (listener_should_exit_ || !is_running_.load(std::memory_order_relaxed) ||
      generation != server_generation_) {
    return nullptr;
  }
  std::lock_guard<std::mutex> client_lock(client_lock_);
  if (usb_client_ != target) {
    return nullptr;
  }
  usb_client_ = nullptr;
  if (temp_usb_client_ == target) {
    temp_usb_client_ = nullptr;
  }
  return target;
}

SocketServer::~SocketServer() { clean_executor_.shutdown(); }

}  // namespace socket_server
}  // namespace debugrouter
