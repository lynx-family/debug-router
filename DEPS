import platform
import os

system = platform.system().lower()
machine = platform.machine().lower()
machine = "x86_64" if machine == "amd64" else machine

deps = {
    'buildtools/llvm': {
        "type": "http",
        'url': f"https://github.com/lynx-family/buildtools/releases/download/llvm-020d2fb7/buildtools-llvm-{system}-{machine}.tar.gz",
        "ignore_in_git": True,
        "decompress": True,
        "condition": system in ['linux', 'darwin'],
    },
    'buildtools/gn': {
        "type": "http",
        "url": f"https://github.com/lynx-family/buildtools/releases/download/gn-cc28efe6/buildtools-gn-{system}-{machine}.tar.gz",
        "ignore_in_git": True,
        "condition": system in ['linux', 'darwin', 'windows']
    },
    'buildtools/ninja': {
        "type": "http",
        "url": {
            "linux": "https://github.com/ninja-build/ninja/releases/download/v1.11.1/ninja-linux.zip",
            "darwin": "https://github.com/ninja-build/ninja/releases/download/v1.11.1/ninja-mac.zip",
            "windows": "https://github.com/ninja-build/ninja/releases/download/v1.11.1/ninja-win.zip"
        }.get(system, None),
        "sha256": {
            "linux": "b901ba96e486dce377f9a070ed4ef3f79deb45f4ffe2938f8e7ddc69cfb3df77",
            "darwin": "482ecb23c59ae3d4f158029112de172dd96bb0e97549c4b1ca32d8fad11f873e",
            "windows": "524b344a1a9a55005eaf868d991e090ab8ce07fa109f1820d40e74642e289abc"
        }.get(system, None),
        "ignore_in_git": True,
        "condition": system in ['linux', 'darwin', 'windows']
    },
    'build': {
        "type": "git",
        "url": "https://github.com/lynx-family/buildroot.git",
        "commit": "c415d367d23ca227418dc9a160f7d715e8c92bf3",
        "ignore_in_git": True,
        "condition": system in ['linux', 'darwin', 'windows']
    },
    'third_party/jsoncpp':{
        "type": "git",
        "url": "https://github.com/open-source-parsers/jsoncpp.git",
        "commit": "42e892d96e47b1f6e29844cc705e148ec4856448",
        "ignore_in_git": True,
    },
    'build/linux/debian_sid_amd64-sysroot': {
        "type": "http",
        "url": "https://commondatastorage.googleapis.com/chrome-linux-sysroot/toolchain/79a7783607a69b6f439add567eb6fcb48877085c/debian_sid_amd64_sysroot.tar.xz",
        "ignore_in_git": True,
        "condition": machine == "x86_64" and system == "linux",
        "require": ["build"]
    },
    'buildtools/cmake': {
        "type": "http",
        "url": {
            "linux": f"https://cmake.org/files/v3.18/cmake-3.18.1-Linux-x86_64.tar.gz",
            "darwin": f"https://dl.google.com/android/repository/ba34c321f92f6e6fd696c8354c262c122f56abf8.cmake-3.18.1-darwin.zip"
        }.get(system, None),
        "ignore_in_git": True,
        "condition": system in ['linux', 'darwin']
    },
    'buildtools/node': {
        "type": "http",
        "url": {
            "linux-x86_64": "https://nodejs.org/dist/v18.19.1/node-v18.19.1-linux-x64.tar.gz",
            "linux-arm64": "https://nodejs.org/dist/v18.19.1/node-v18.19.1-linux-arm64.tar.gz",
            "darwin-x86_64": "https://nodejs.org/dist/v18.19.1/node-v18.19.1-darwin-x64.tar.gz",
            "darwin-arm64": "https://nodejs.org/dist/v18.19.1/node-v18.19.1-darwin-arm64.tar.gz",
            "windows-x86_64": "https://nodejs.org/dist/v18.19.1/node-v18.19.1-win-x64.zip"
        }.get(f'{system}-{machine}', None),
        "sha256": {
            "linux-x86_64": "724802c45237477dbe5777923743e6c77906830cae03a82b5653ebd75b301dda",
            "linux-arm64": "2913e8544d95c8be9e6034c539ec0584014532166a088bf742629756c3ec42e2",
            "darwin-x86_64": "ab67c52c0d215d6890197c951e1bd479b6140ab630212b96867395e21d813016",
            "darwin-arm64": "0c7249318868877032ed21cc0ed450015ee44b31b9b281955521cd3fc39fbfa3",
            "windows-x86_64": "ff08f8fe253fba9274992d7052e9d9a70141342d7b36ddbd6e84cbe823e312c6"
        }.get(f'{system}-{machine}', None),
        "ignore_in_git": True,
        "condition": system in ['linux', 'darwin', 'windows']
    },
    'third_party/libcxx': {
        "type": "git",
        "url": "https://chromium.googlesource.com/external/github.com/llvm/llvm-project/libcxx",
        "commit": "64d36e572d3f9719c5d75011a718f33f11126851",
        "ignore_in_git": True,     
    },
    'third_party/libcxxabi': {
        "type": "git",
        "url": "https://chromium.googlesource.com/external/github.com/llvm/llvm-project/libcxxabi",
        "commit": "9572e56a12c88c011d504a707ca94952be4664f9",
        "ignore_in_git": True,
    },
    'test/e2e_test/ios_example/xctestrunner': {
        "type": "http",
        "url": "https://github.com/google/xctestrunner/releases/download/0.2.15/ios_test_runner.par",
        "decompress": False,
        "condition": system in ['darwin'],
    },
    "tools_shared": {
        "type": "solution",
        "url": "https://github.com/lynx-family/tools-shared.git",
        "commit": "271dba582cab4409de488da3fa6e6761fb2a1cdd",
        'deps_file': 'dependencies/DEPS',
        "ignore_in_git": True,
    },
    'third_party/gyp': {
        "type": "git",
        "url": "https://chromium.googlesource.com/external/gyp",
        "commit": "9d09418933ea2f75cc416e5ce38d15f62acd5c9a",
        "ignore_in_git": True,
        "condition": system in ['linux', 'darwin', 'windows'],
    },
}
