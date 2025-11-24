// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/protocol/events.h"

namespace debugrouter {
namespace protocol {
const char *kDebugStateConnecting =
    "{\"event\": \"debugState\", \"data\": \"connecting\"}";
const char *kDebugStateConnected =
    "{\"event\": \"debugState\", \"data\": \"connected\"}";
const char *kDebugStateDisconnected =
    "{\"event\": \"debugState\", \"data\": \"disconnected\"}";

const char *kStopAtEntryEnable = "{\"event\": \"stopAtEntry\", \"data\": true}";
const char *kStopAtEntryDisable =
    "{\"event\": \"stopAtEntry\", \"data\": false}";

const char *kEventType4OpenCard = "openCard";

const char *kInvalidTempalteUrl = "___UNKNOWN___";

}  // namespace protocol
}  // namespace debugrouter
