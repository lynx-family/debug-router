// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#ifndef DEBUGROUTER_NATIVE_SOCKET_UTIL_H_
#define DEBUGROUTER_NATIVE_SOCKET_UTIL_H_

#include <cstdint>

namespace debugrouter {
namespace socket_server {

// convert a char value to a uint32_t value
uint32_t CharToUInt32(char value);

// convert a uint32_t number into 4 sizes char array
// char_array's len needs equal 4, result is char_array
void IntToCharArray(uint32_t value, char *char_array);

// convert char array's elements into a uint32_t value
// len need less than 4 and payload's length need == len
uint32_t DecodePayloadSize(char *payload, int32_t len);

// check if header's [12,16) == payload_size_int + 4
// the return value is result, header's len needs equal 16
bool CheckHeaderFourthByte(const char *header, uint32_t payload_size_int);

// check if header's [0,12) == DebugRouter connect protocol's header
// the return value is result, header's len needs equal 16
bool CheckHeaderThreeBytes(const char *header);

}  // namespace socket_server
}  // namespace debugrouter

#endif  // DEBUGROUTER_NATIVE_SOCKET_UTIL_H_
