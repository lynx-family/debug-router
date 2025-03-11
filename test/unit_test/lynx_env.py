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


def GetLayoutTestCasesRoot():
  """
  Get the layout test cases root directory.

  Returns:
    The absolulte directory of layout test cases, eg:
      '$LYNX_ROOT_DIR/testing/lynx/starlight/layout'
  """
  source_root = GetSourceRoot()
  layout_test_cases_root = os.path.join(source_root,
                                        'testing/lynx/starlight/layout')
  if os.path.exists(layout_test_cases_root):
    return layout_test_cases_root
  else:
    print('Layout cases root: ' + layout_test_cases_root + ' does not exists.')
    sys.exit(1)


def GetDynamicCssTestCasesRoot():
  """
  Get the dynamic css test cases root directory.

  Returns:
    The absolulte directory of dynamic css test cases, eg:
      '$LYNX_ROOT_DIR/Lynx/tasm/react/test'
  """
  source_root = GetSourceRoot()
  dynamic_css_test_cases_root = os.path.join(source_root,  'testing/lynx/tasm/react')
  if os.path.exists(dynamic_css_test_cases_root):
    return dynamic_css_test_cases_root
  else:
    print('dynamic css cases root: ' + dynamic_css_test_cases_root + ' does not exists.')
    sys.exit(1)

def GetLepusTest262Conf(output_directory):
  """
  Get the lepus test262 test cases conf file.

  Returns:
    The absolulte directory of lepus test262 test cases conf file, eg:
      '$LYNX_ROOT_DIR/out/Default/lepus_test/test262.conf'
  """
  build_root = GetBuildRoot(output_directory)
  lepus_test262_conf = os.path.join(build_root,  'lepus_test/test262.conf')
  if os.path.exists(lepus_test262_conf):
    return lepus_test262_conf
  else:
    print('dynamic css cases root: ' + lepus_test262_conf + ' does not exists.')
    sys.exit(1)

def GetTasmTestCasesRoot():
  """
  Get the layout test cases root directory.

  Returns:
    The absolulte directory of layout test cases, eg:
      '$LYNX_ROOT_DIR/testing/lynx/tasm/databinding'
  """
  source_root = GetSourceRoot()
  tasm_test_cases_root = os.path.join(source_root,
                                        'testing/lynx/tasm/databinding')
  if os.path.exists(tasm_test_cases_root):
    return tasm_test_cases_root
  else:
    print('Tasm cases root: ' + tasm_test_cases_root + ' does not exists.')
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
