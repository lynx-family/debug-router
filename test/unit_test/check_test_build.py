#!/usr/bin/env python3
# Copyright 2020 The Lynx Authors. All rights reserved.
# Licensed under the Apache License Version 2.0 that can be found in the
# LICENSE file in the root directory of this source tree.

"""
This script build unittests for debug-router.
"""

import argparse
import os
import subprocess
import sys
from collections import namedtuple

OS_PLATFORM=''

if sys.platform == 'darwin':
  OS_PLATFORM = 'mac'
elif sys.platform.startswith('linux'):
  OS_PLATFORM = 'linux64'
else:
  print('Erorr, host OS not supported!')
  sys.exit(1)

def CheckUnitTestsBuild():
  print('Starting checking if unittests can be built.')
  # cwd = os.getcwd()
  # gn_path = os.path.join(cwd, 'buildtools/gn/')
  # ninja_path = os.path.join(cwd, 'buildtools/ninja/')

  # os.environ['PATH'] = ':'.join([ninja_path, gn_path, os.environ['PATH']])

  gn_common_build_args = """
    enable_unittests = true
  """

  gn_gen_cmd = "buildtools/gn/gn gen out/Default --args=\"" + gn_common_build_args + "\""
  gn_clean_cmd = 'buildtools/gn/gn clean out/Default'
  build_base_tests_cmd = 'buildtools/ninja/ninja -C out/Default example_unittest'

  subprocess.check_call(gn_gen_cmd, shell=True)
  subprocess.check_call(gn_clean_cmd, shell=True)
  subprocess.check_call(build_base_tests_cmd, shell=True)

  print('Congratulations! Unittests can be built.\n')
  sys.exit(0)

def main():
  CheckUnitTestsBuild()


if __name__ == '__main__':
  sys.exit(main())
