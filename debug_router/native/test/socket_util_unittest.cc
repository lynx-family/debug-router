// Copyright 2023 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#include <cstdlib>

#include "debug_router/native/core/util.h"
#include "gtest/gtest.h"

TEST(SocketUtilTestSuite, TestCharToUInt32) {
  EXPECT_EQ(debugrouter::util::CharToUInt32(0xF0), (uint32_t)240);
  EXPECT_EQ(debugrouter::util::CharToUInt32(1), (uint32_t)1);
}

TEST(SocketUtilTestSuite, TestIntToCharArray1) {
  char array[4];
  uint32_t result[4] = {0, 0, 3, 232};
  debugrouter::util::IntToCharArray(1000, array);
  for (int i = 0; i < 4; i++) {
    EXPECT_EQ(debugrouter::util::CharToUInt32(array[i]), result[i]);
  }
}

TEST(SocketUtilTestSuite, TestIntToCharArray2) {
  char array[4];
  uint32_t result[4] = {0, 0, 0, 255};
  debugrouter::util::IntToCharArray(255, array);
  for (int i = 0; i < 4; i++) {
    EXPECT_EQ(debugrouter::util::CharToUInt32(array[i]), result[i]);
  }
}

TEST(SocketUtilTestSuite, TestIntToCharArray3) {
  char array[4];
  uint32_t result[4] = {0, 0, 1, 0};
  debugrouter::util::IntToCharArray(256, array);
  for (int i = 0; i < 4; i++) {
    EXPECT_EQ(debugrouter::util::CharToUInt32(array[i]), result[i]);
  }
}

TEST(SocketUtilTestSuite, TestDecodePayloadSize) {
  char array[4] = {0, 0, 1, 0};
  uint32_t result = 256;
  EXPECT_EQ(debugrouter::util::DecodePayloadSize(array, 4), result);
}

TEST(SocketUtilTestSuite, TestDecodePayloadSize2) {
  srand(time(NULL));
  uint32_t rand_number = rand() % ((1UL << 32) - 1);
  char array[4];
  debugrouter::util::IntToCharArray(rand_number, array);
  uint32_t result = debugrouter::util::DecodePayloadSize(array, 4);
  EXPECT_EQ(result, rand_number);
}

TEST(SocketUtilTestSuite, TestCheckHeader) {
  char header[16] = {0, 0, 0, 1, 0, 0, 0, 101, 0, 0, 0, 0, 0, 0, 0, 31};

  EXPECT_EQ(true, debugrouter::util::CheckHeaderThreeBytes(header));
  EXPECT_EQ(true, debugrouter::util::CheckHeaderFourthByte(header, 27));
}
