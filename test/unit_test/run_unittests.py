#!/usr/bin/env python3
# Copyright 2020 The Lynx Authors. All rights reserved.
# Licensed under the Apache License Version 2.0 that can be found in the
# LICENSE file in the root directory of this source tree.

import lynx_env
import optparse
import os
import re
import subprocess
import sys

from datetime import datetime

SCRIPT_DIR = os.path.join(os.path.dirname(__file__))
BUILD_ROOT = 'out/Default' # The default build root is 'out/Default'
# The default timestamp of test, every test run has an unique timestamp.
TEST_TIMESTAMP = '0000'
TEST_CASES_DIR = 'test_cases'


def GetTestRootPathOnAndroidDevice():
  return lynx_env.GetTestDirectoryOnDevice(TEST_TIMESTAMP)


def GetTestBinaryPathOnAndroidDevice(test):
  return os.path.join(GetTestRootPathOnAndroidDevice(), test)


def GetTestFilterString(gtest_filter):
  return '--gtest_filter=%s' % (gtest_filter)

def GenerateGeneralTestOptionsString(opts):
  result = GetTestFilterString(opts.gtest_filter)
  if opts.gtest_also_run_disabled_tests:
    result = result + ' ' + '--gtest_also_run_disabled_tests'
  return result;

def PushFileToDevice(file_on_local, file_on_device):
  adb_cmd = ['adb', 'push']
  adb_cmd.append(file_on_local)
  adb_cmd.append(file_on_device)
  p = subprocess.Popen(' '.join(adb_cmd),
                       stdout = subprocess.PIPE,
                       stderr = subprocess.PIPE,
                       shell=True)
  output, error = p.communicate()
  if p.returncode < 0:
    print(('Error push files: ' + error))
    sys.exit(0 - p.returncode)
  print(output)


def SetupTestEnviroment():
  # Create the test root directory.
  test_dir_on_device = GetTestRootPathOnAndroidDevice()
  adb_cmd = ['adb', 'shell', 'mkdir', '-p', test_dir_on_device]
  subprocess.check_call(' '.join(adb_cmd), shell=True)

def SetupTestBinary(test):
  # Push test binary to device.
  file_on_output = os.path.join(lynx_env.GetBuildRoot(BUILD_ROOT),
                                'exe.stripped',
                                test)
  file_on_device = os.path.join(GetTestRootPathOnAndroidDevice(), test)
  PushFileToDevice(file_on_output, file_on_device)

  # Setup permisson of test binary.
  adb_cmd = ['adb', 'shell', 'chmod', 'u+x']
  adb_cmd.append(file_on_device)
  p = subprocess.Popen(' '.join(adb_cmd),
                       stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE,
                       shell=True)
  output, error = p.communicate()
  if p.returncode < 0:
    print(("Setup test binary error: " + error))
    sys.exit(0 - p.returncode)
  print(output)


def CleanupTestEnviroment():
  test_dir_on_device = GetTestRootPathOnAndroidDevice()
  adb_cmd = ['adb', 'shell', 'rm', '-r', test_dir_on_device]
  # Remove all cases on device first.
  p = subprocess.Popen(' '.join(adb_cmd),
                       stdout = subprocess.PIPE,
                       stderr = subprocess.PIPE,
                       shell = True)
  output, error = p.communicate()
  if output: print(output)
  if error: print(('Error:' + error))


def CheckTestResult(test_result, return_code):
  failed_cases_re = re.compile('(\d+)\s+FAILED TEST')
  for line in test_result.split(b'\n'):
    if failed_cases_re.search(line.decode('utf-8')):
      return 1
  return return_code


def RunTestSuiteOnAndroidDevice(device, test, general_test_options):
  adb_cmd = ['adb', 'shell']
  gtest_command = GetTestBinaryPathOnAndroidDevice(test) + ' ' + general_test_options;
  gtest_command = ' '.join(gtest_command)
  adb_cmd.append('\"%s\"' % (gtest_command))
  # TODO: Append test root for layout test.
  adb_cmd.append(GetTestRootPathOnAndroidDevice())
  adb_cmd = ' '.join(adb_cmd)
  print(('Run test with command: ' + adb_cmd))
  p = subprocess.Popen([adb_cmd],
                       stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, shell=True)
  result, error = p.communicate()
  if p.returncode:
    print(('Run test error: ' + result + error))
  else:
    print(('Run test sucess: ' + result))
  return CheckTestResult(result, (-p.returncode))

def TestOnAndroidDevice(opts):
  # Start test.
  global BUILD_ROOT
  BUILD_ROOT = opts.output
  global TEST_TIMESTAMP
  TEST_TIMESTAMP= datetime.utcnow().strftime('%Y%m%d-%H%M%S-%f')

  SetupTestEnviroment()

  SetupTestBinary(opts.test)
  return RunTestSuiteOnAndroidDevice(opts.device, opts.test, GenerateGeneralTestOptionsString(opts))

def TestOnNativeEnv(opts):
  BUILD_ROOT = opts.output
  cmd = os.path.join(lynx_env.GetBuildRoot(BUILD_ROOT),
                                opts.test)
  cmd += ' ' + GenerateGeneralTestOptionsString(opts)
  
  # Use dump to write actual result to expected file.
  if opts.dump == 'true':
    cmd += ' ' + 'true'

  print(cmd)
  if opts.coverage:
    os.environ['LLVM_PROFILE_FILE'] = os.path.join(BUILD_ROOT, '%s.profraw' % opts.test)
  p = subprocess.Popen([cmd],
                       stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, shell=True)
  if 'LLVM_PROFILE_FILE' in os.environ:
    del os.environ['LLVM_PROFILE_FILE']
  result, error = p.communicate()
  encoding = 'utf-8'
  if p.returncode:
    print(('Run test error: ' + result.decode(encoding) + error.decode(encoding)))
  else:
    print(('Run test sucess: ' + result.decode(encoding)))
  return CheckTestResult(result, (-p.returncode))

def main():
  parser = optparse.OptionParser()
  parser.add_option('-d', '--device', default='',
                    help='The target running device.')
  parser.add_option('-a', '--gtest_also_run_disabled_tests', 
                    action='store_true', help='Also run disabled tests')
  parser.add_option('-t', '--test', help='Test binary to run.')
  parser.add_option('-f', '--gtest-filter', default='*',
                    help='The test filters passed to gtests,'
                         'refer to "--gtest_filter" option of gtest.')
  parser.add_option('-o', '--output', default='out/Default',
                    help='The output directory, default is \'out/Default\'.')
  parser.add_option('-l', '--layout-test', action='store_true',
                    help='Run layout tests.')
  parser.add_option('-u', '--dump', help='Dump result to expected files')
  parser.add_option('-k', '--keep', action='store_true',
                    help='Keep the test binaries and cases on devices')
  parser.add_option('-p', '--platform', type = "choice", choices = ['', 'android'], default='',
                    help='The platform to run unittest, will run on current platform by default.')
  parser.add_option('-c', '--coverage', action='store_true',
                    help='Get coverage data on the run')
  opts, args = parser.parse_args()

  print((opts.platform))
  if (opts.platform == 'android'):
    test_result = TestOnAndroidDevice(opts)
  else:
    test_result = TestOnNativeEnv(opts)
  
  if not opts.keep and opts.platform == 'android':
    CleanupTestEnviroment()
  return test_result


if __name__ == '__main__':
  sys.exit(main())
