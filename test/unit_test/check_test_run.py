#!/usr/bin/env python3
# Copyright 2020 The Lynx Authors. All rights reserved.
# Licensed under the Apache License Version 2.0 that can be found in the
# LICENSE file in the root directory of this source tree.

"""
This script checks unit test results
"""

import os
import subprocess
import sys

def CheckUnitTestRun():
  # TODO(shouqun): Disable CI test run temporarily, re-enable them when testing
  # device are ready.
  print('Check unittest cases...')
  cwd = os.getcwd()
  os.environ['LYNX_ROOT_DIR'] = cwd

  print('Check base test cases...')
  run_basetest_command = 'python3 test/unit_test/run_unittests.py -c -a -t example_unittest'
  subprocess.check_call(run_basetest_command, shell=True)
  print('Congratulations! All base unittests are passed.\n')

def main():
  CheckUnitTestRun()

if __name__ == '__main__':
  sys.exit(main())
