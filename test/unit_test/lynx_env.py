#!/usr/bin/env python
# Copyright 2020 The Lynx Authors. All rights reserved.
# Licensed under the Apache License Version 2.0 that can be found in the
# LICENSE file in the root directory of this source tree.

import os
import sys

def GetSourceRoot():
  """
  Get the Lynx source root directory.

  Returns:
    Absolute Lynx source root directory.
  """
  if 'LYNX_ROOT_DIR' in os.environ.keys():
    return os.environ['LYNX_ROOT_DIR']
  else:
    print('LYNX_ROOT_DIR not set, please run "source tools/envsetup.sh".')
    sys.exit(1)


def GetBuildRoot(output_directory):
  """
  Get the build root directory (GN build).

  Args:
    Configured gn out out directory, eg: 'out/Default'
  Returns:
    The absolute directory of build root, eg: '$LYNX_ROOT_DIR/out/Default'
  """
  source_root = GetSourceRoot()
  build_root = os.path.join(source_root, output_directory)
  if os.path.exists(build_root):
    return build_root
  else:
    print('Build root directory: ' + build_root + ' does not exits.')
    sys.exit(1)

def GetTestDirectoryOnDevice(timestamp):
  """
  Get the test root directory on device.

  Args:
    The unique timestamp of a test run.
  Returns:
    The absolute directory of the test run.
  """
  return os.path.join('/data/local/tmp', 'test-' + timestamp)

def main():
  print(GetSourceRoot())
  print(GetBuildRoot("out/Default"))
  print(GetTestDirectoryOnDevice())
  return 0


if __name__ == '__main__':
  sys.exit(main())
