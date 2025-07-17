#!/bin/bash
# Copyright 2024 The Lynx Authors. All rights reserved.
# Licensed under the Apache License Version 2.0 that can be found in the
# LICENSE file in the root directory of this source tree.

# using posix standard commands to acquire realpath of file
posix_absolute_path() {
  if [[ ! $# -eq 1 ]];then
    echo "illegal parameters $@"
    exit 1
  fi
  cd $(dirname $1) 1>/dev/null || exit 1
  local ABSOLUTE_PATH_OF_FILE="$(pwd -P)/$(basename $1)"
  cd - 1>/dev/null || exit 1
  echo $ABSOLUTE_PATH_OF_FILE
}

lynx_envsetup() {
  local SCRIPT_ABSOLUTE_PATH="$(posix_absolute_path $1)"
  local TOOLS_ABSOLUTE_PATH="$(dirname $SCRIPT_ABSOLUTE_PATH)"
  export DEBUGROUTER_DIR="$(dirname $TOOLS_ABSOLUTE_PATH)"
  export BUILDTOOLS_DIR="${DEBUGROUTER_DIR}/buildtools"
  export PATH="${BUILDTOOLS_DIR}/llvm/bin:${BUILDTOOLS_DIR}/ninja:${TOOLS_ABSOLUTE_PATH}/gn_tools:$PATH"
  export PATH="tools_shared:$PATH"
}

function android_env_setup() {
  local SCRIPT_REAL_PATH=$(posix_absolute_path $1)
  local TOOLS_REAL_PATH=$(dirname $SCRIPT_REAL_PATH)
  echo $TOOLS_REAL_PATH
  # Setup android sdk.
  if [ "$ANDROID_HOME" ]; then
    ln -vsnf "$ANDROID_HOME" "$TOOLS_REAL_PATH"/android_tools/sdk
  else
    if [ "$ANDROID_SDK" ]; then
      ln -vsnf "$ANDROID_SDK" "$TOOLS_REAL_PATH"/android_tools/sdk
    else
      echo "Please setup ANDROID_HOME or ANDROID_SDK for android build."
    fi
  fi

  # Setup android ndk
  if [ "$ANDROID_NDK" ]; then
    ln -vsnf "$ANDROID_NDK" "$TOOLS_REAL_PATH"/android_tools/ndk
  else
    echo "Please setup ANDROID_NDK for android build."
  fi
}

lynx_envsetup "${BASH_SOURCE:-$0}"
android_env_setup "${BASH_SOURCE:-$0}"
