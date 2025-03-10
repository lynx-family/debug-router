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
  print('Starting checking if DebugRouter can be built.')
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


def CheckUnitTestInstallAndRun(args):
  command = "%s/tools/android_tools/emu_bootup.sh --verbose" %(debugrouter_root_dir)
  print("start emu:")
  CheckExecute(command)

  debug_router_android_apk_file = '../../../debug_router/Android/DebugRouter/build/outputs/apk/androidTest/debug/DebugRouter-debug-androidTest.apk'
  print("install test apk:" + debug_router_android_apk_file)
  CheckExecute("adb install -r %s" % (debug_router_android_apk_file))

  CheckExecute("adb logcat -c")
  CheckExecuteDoNotWait("adb logcat")

  print("add permission for test.apk")
  CheckExecute('adb shell pm grant com.lynx.debugrouter.test android.permission.WRITE_EXTERNAL_STORAGE')

  print("check permission:")
  CheckExecute('adb shell dumpsys package com.lynx.debugrouter.test | grep android.permission.WRITE_EXTERNAL_STORAGE')

  print("check dir:")
  CheckExecute('adb shell ls /sdcard')

  print("\n======================================================= start test:")
  # TODO -e coverage true -e coverageFile /sdcard/coverage_debug_router.ec
  debug_router_command = """
    adb shell am instrument -w  -e debug false \
        com.lynx.debugrouter.test/androidx.test.runner.AndroidJUnitRunner | tee run_test.log
  """
  CheckExecute(debug_router_command)
  CheckTestResult('run_test.log')
  return 0

def CheckUnitTestBuild(args):
  print(("run test on %s"%(args.devices)))
  command = './gradlew clean'
  CheckExecute(command)

  print('Build androidTest!')
  command = './gradlew :Debugrouter:assembleDebugAndroidTest'\
    ' --parallel --configure-on-demand'\
    ' -x lint'\
    ' -Penable_coverage=true'
  CheckExecute(command)


def process_coverage_file():
  CheckExecute('adb pull /sdcard/coverage_debug_router.ec ./')
  # check jacococli.jar
  cli_file = os.path.join(debugrouter_root_dir, 'jacococli.jar')
  coverage_xml = os.path.join(debugrouter_root_dir, 'coverage.xml')
  report_dir =  os.path.join(debugrouter_root_dir, 'report')
  if not os.path.exists(cli_file):
    file_data = requests.get('https://tosv.byted.org/obj/eden-internal/nulojhmnuhog/jacococli.jar')
    with open(cli_file, 'wb') as f:
        f.write(file_data.content)
  # gen html
  report_html_command='java -jar %s report *.ec --html %s' \
    ' --classfiles DebugRouter/build/intermediates/javac/debug/classes/*'\
    ' --sourcefiles DebugRouter/src/main/java' % (cli_file, report_dir)
  CheckExecute(report_html_command)
  # gen xml
  report_xml_command='java -jar %s report *.ec --xml %s' \
    ' --classfiles DebugRouter/build/intermediates/javac/debug/classes/*'\
    ' --sourcefiles DebugRouter/src/main/java' % (cli_file, coverage_xml)
  CheckExecute(report_xml_command)
  tree = ET.parse(coverage_xml)
  root = tree.getroot()
  COUNTER_NAME_MAPPING = {
    'INSTRUCTION':'instantiations',
    'BRANCH':'branches',
    'LINE':'lines',
    'METHOD':'functions',
  }
  summary_json = {}
  for child in root:
    if child.tag == 'counter' and child.attrib['type'] in COUNTER_NAME_MAPPING:
      missed_int = int(child.attrib['missed'])
      covered_int = int(child.attrib['covered'])
      summary_json.update({
        COUNTER_NAME_MAPPING[child.attrib['type']]:{
          'count': missed_int + covered_int,
          'covered': covered_int,
          'percent': covered_int * 100.0 / (missed_int + covered_int)
        }
      })
  with open(os.path.join(debugrouter_root_dir, 'coverage_summary_total.json'), 'w') as wf:
    json.dump(summary_json, wf)
  print(('Generated code coverage report at %s!' % report_dir))

def CheckTestResult(log_file):
  if not os.path.exists(log_file):
    print("run_test.log not find!!!")
    sys.exit(1)
  with open(log_file, 'r') as f:
    content = f.read()
    if 'FAILURES!!!' in content:
      sys.exit(1)


def CheckAndroidUnitTests(args):
  AndroidBuildSetup()
  CheckUnitTestBuild(args)
  CheckUnitTestInstallAndRun(args)
  # TODO
  #process_coverage_file()

def main(args):
  CheckAndroidUnitTests(args)

if __name__ == '__main__':
  parser = argparse.ArgumentParser(
    description='assign the devices locations to run tests')
  parser.add_argument('-d', '--devices', dest='devices', default="localhost",
                      help='assign the local device to run tests')
  args = parser.parse_args()
  sys.exit(main(args))
