// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include "debug_router/native/socket/util.h"

#include <cstring>

namespace debugrouter {
namespace socket_server {

uint32_t CharToUInt32(char value) { return ((uint32_t)value) & 0xFF; }

void IntToCharArray(uint32_t value, char *char_array) {
  char_array[0] = (value >> 24) & 0xFF;
  char_array[1] = (value >> 16) & 0xFF;
  char_array[2] = (value >> 8) & 0xFF;
  char_array[3] = (value >> 0) & 0xFF;
}

uint32_t DecodePayloadSize(char *payload, int32_t len) {
  uint32_t size = 0;
  for (int32_t i = 0; i < len; i++) {
    size = size + ((CharToUInt32(payload[i])) << (8 * (len - 1 - i)));
  }
  return size;
}

bool CheckHeaderThreeBytes(const char *header) {
  char value[4];
  memcpy(value, header, 4);
  uint32_t value_int = DecodePayloadSize(value, 4);
  if (value_int != 1) {
    return false;
  }
  memcpy(value, header + 4, 4);
  value_int = DecodePayloadSize(value, 4);
  if (value_int != 101) {
    return false;
  }
  memcpy(value, header + 8, 4);
  value_int = DecodePayloadSize(value, 4);
  if (value_int != 0) {
    return false;
  }
  return true;
}

bool CheckHeaderFourthByte(const char *header, uint32_t payload_size_int) {
  char value[4];
  memcpy(value, header + 12, 4);
  uint32_t value_int = DecodePayloadSize(value, 4);
  if (value_int != payload_size_int + 4) {
    return false;
  }
  return true;
}

}  // namespace socket_server
}  // namespace debugrouter
