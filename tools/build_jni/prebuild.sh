#!/bin/bash
CURRENT_PATH=$(cd `dirname $0`; pwd)
rm -rf $CURRENT_PATH/gen/
JNI_PREBUILD=$CURRENT_PATH"/prebuild_jni.sh"
$JNI_PREBUILD
# sed -i '' "s/bool RegisterNativesImpl/bool RegisterGlobalHandlerNativesImpl/g" ../../build/gen/DebugRouterGlobalHandlerWrapper_jni.h
