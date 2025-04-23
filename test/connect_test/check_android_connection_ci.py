#!/usr/bin/env python3
# Copyright 2021 The Lynx Authors. All rights reserved.
# Licensed under the Apache License Version 2.0 that can be found in the
# LICENSE file in the root directory of this source tree.

"""
This script build DebugRouter and run it's UnitTests.
return 0 iff android demo can be built.
"""

import argparse
import os
import subprocess
import sys
import requests
import xml.etree.ElementTree as ET
import json

debugrouter_root_dir=sys.path[0] + "/../.."

def CheckExecute(command):
  status = subprocess.check_call(command, shell=True)
  if status != 0:
    print(("%s failed" %(command)) + status)
    sys.exit(1)
def CheckExecuteDoNotWait(command):
  subprocess.Popen(command, shell=True)


def AndroidBuildSetup():
  print('\nStarting checking if DebugRouter can be built.')
  print('debugrouter_root_dir:' + debugrouter_root_dir)
  os.chdir(debugrouter_root_dir)
  cur_work_dir = os.getcwd() + "/test/e2e_test/AndroidExample"
  os.chdir(cur_work_dir)
  print('cur_work_dir:' + os.getcwd())

  android_ndk = os.environ.get('ANDROID_NDK')
  android_sdk = os.environ.get('ANDROID_HOME')

  local_pth = """
  ## This file must *NOT* be checked into Version Control Systems,
  # as it contains information specific to your local configuration.
  #
  # Location of the SDK. This is only used by Gradle.
  # For customization when using a Version Control System, please read the
  # header note.
  #Wed Aug 21 19:06:01 CST 2019
  ndk.dir=%s
  sdk.dir=%s

  """ % (android_ndk, android_sdk)

  f = open('local.properties', 'w+')
  f.write(local_pth)
  f.close()


def StartRunEmuAndInstallTestApk(args):
  command = "%s/tools/android_tools/emu_bootup.sh --verbose" %(debugrouter_root_dir)
  print("start emu:")
  CheckExecute(command)

  debug_router_android_apk_file = './app/build/outputs/apk/debug/app-debug.apk'
  print("install test apk:" + debug_router_android_apk_file)
  CheckExecute("adb install -r %s" % (debug_router_android_apk_file))
  return 0

def TestAndroidCon(args):
  print("start TestAndroidWebSocketCon:")
  os.chdir(debugrouter_root_dir + "/debug_router_connector")
  print('cur_work_dir:' + os.getcwd())
  command_build_driver = "../buildtools/node/bin/npm install && ../buildtools/node/bin/npm run build"
  CheckExecute(command_build_driver)
  os.chdir(debugrouter_root_dir + "/test/e2e_test/connector_test")
  # start test
  command_run = ""
  print('cur_work_dir:' + os.getcwd())
  if (args.conection_type == "websocket"):
    print('start: websocket common test.')
    command_run = "../../../buildtools/node/bin/npm install && ../../../buildtools/node/bin/node websocket.js"
  else:
    if(args.conection_type == "usb"):
      print('start: usb common test and large message test.')
      command_run = "../../../buildtools/node/bin/npm install && ../../../buildtools/node/bin/node usb.js && ../../../buildtools/node/bin/node large_message_test.js"
  CheckExecute(command_run)

def CheckBuildDebugRouterTestApk(args):
  command = './gradlew clean'
  CheckExecute(command)

  print('Build androidTest!')
  command = './gradlew :app:assembleDebug'
  CheckExecute(command) # app location: ./app/build/outputs/apk/debug/app-debug.apk

def CheckTestResult(log_file):
  if not os.path.exists(log_file):
    print("run_test.log not find!!!")
    sys.exit(1)
  with open(log_file, 'r') as f:
    content = f.read()
    if 'FAILURES!!!' in content:
      sys.exit(1)


def CheckAndroidConnectionCI(args):
  AndroidBuildSetup()
  CheckBuildDebugRouterTestApk(args)
  if(args.build):
    sys.exit(0)
  StartRunEmuAndInstallTestApk(args)
  CheckExecute("adb logcat -c")
  CheckExecuteDoNotWait("adb logcat")
  TestAndroidCon(args)

def main(args):
  CheckAndroidConnectionCI(args)

if __name__ == '__main__':
  parser = argparse.ArgumentParser(
    description='assign the devices locations to run tests')
  parser.add_argument('-t', '--conection_type', required=True)
  parser.add_argument('-b', '--build', action='store_true')
  parser.add_argument('-d', '--devices', dest='devices', default="localhost",
                      help='assign the local device to run tests')
  args = parser.parse_args()
  sys.exit(main(args))
