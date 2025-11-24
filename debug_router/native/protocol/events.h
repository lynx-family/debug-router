// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_PROTOCOL_EVENTS_H_
#define DEBUGROUTER_NATIVE_PROTOCOL_EVENTS_H_

namespace debugrouter {
namespace protocol {

extern const char *kDebugStateConnecting;
extern const char *kDebugStateConnected;
extern const char *kDebugStateDisconnected;

extern const char *kStopAtEntryEnable;
extern const char *kStopAtEntryDisable;

extern const char *kEventType4OpenCard;

extern const char *kInvalidTempalteUrl;

}  // namespace protocol
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_PROTOCOL_EVENTS_H_
