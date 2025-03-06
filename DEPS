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
        "commit": "b74a2ad3759ed710e67426eb4ce8e559405ed63f",
        "ignore_in_git": True,
        "condition": system in ['linux', 'darwin', 'windows']
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
            "linux-x86_64": "https://nodejs.org/dist/v16.18.1/node-v16.18.1-linux-x64.tar.gz",
            "linux-arm64": "https://nodejs.org/dist/v16.18.1/node-v16.18.1-linux-arm64.tar.gz",
            "darwin-x86_64": "https://nodejs.org/dist/v16.18.1/node-v16.18.1-darwin-x64.tar.gz",
            "darwin-arm64": "https://nodejs.org/dist/v16.18.1/node-v16.18.1-darwin-arm64.tar.gz",
            "windows-x86_64": "https://nodejs.org/dist/v16.18.1/node-v16.18.1-win-x64.zip"
        }.get(f'{system}-{machine}', None),
        "sha256": {
            "linux-x86_64": "8949919fc52543efae3bfd057261927c616978614926682ad642915f98fe1981",
            "linux-arm64": "d6caa1439e8f3fbf4855b5cc1d09ae3eee31fc54ec29b7170603222ba6f8dfe6",
            "darwin-x86_64": "c190e106d4ac6177d1db3a5a739d39dd68bd276ba17f3d3c84039a93717e081e",
            "darwin-arm64": "71720bb0a80cf158d8fdf492def08048befd953ad45e2458b1d095e32c612ba7",
            "windows-x86_64": "db6a81de8e8ca3444495f1bcf04a883c076b4325d0fbaa032a190f88b38b30c5"
        }.get(f'{system}-{machine}', None),
        "ignore_in_git": True,
        "condition": system in ['linux', 'darwin', 'windows']
    },
}
