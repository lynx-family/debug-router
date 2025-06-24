cmake_minimum_required(VERSION 3.4.1)

add_compile_options(-fexceptions)
add_definitions(-DOS_ANDROID=1)
add_definitions(-DGNU_SUPPORT=1)

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=c++14 -fno-rtti -fno-short-enums -Wall -Werror -fno-stack-protector -fno-strict-aliasing")

#remove redundant sections
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fno-short-enums -Wall -Werror -fno-stack-protector -fno-strict-aliasing")

if ((CMAKE_BUILD_TYPE MATCHES "Release"))
    add_definitions(-DNDEBUG)
    MESSAGE("Build Release Version " ${ANDROID_ABI})
    add_definitions(-DENABLE_LOGGING=0)
else () # end release
    MESSAGE("Build Debug Version " ${ANDROID_ABI})
#enable logging
    add_definitions(-DENABLE_LOGGING=1)
#memory debug
    add_definitions(-DDEBUG_MEMORY)
endif ()  #end debug

aux_source_directory(${CMAKE_SOURCE_DIR}/../build/gen GEN_FILES)

include_directories(
        ${CMAKE_SOURCE_DIR}/../../../
        ${CMAKE_SOURCE_DIR}/../../../third_party/jsoncpp/include
        ${CMAKE_SOURCE_DIR}/../../native/android
)

file(GLOB_RECURSE GEN_SRC_LIST ${CMAKE_SOURCE_DIR}/../build/gen/*.*)

file(GLOB DEBUGROUTER_SRC_LIST
        ${CMAKE_SOURCE_DIR}/../../native/android/*.*
        ${CMAKE_SOURCE_DIR}/../../native/android/base/*.*
        ${CMAKE_SOURCE_DIR}/../../native/android/base/android/*.*
        ${CMAKE_SOURCE_DIR}/../../native/android/log/*.*
        ${CMAKE_SOURCE_DIR}/../../native/core/*.*
        ${CMAKE_SOURCE_DIR}/../../native/socket/*.*
        ${CMAKE_SOURCE_DIR}/../../native/socket/posix/*.*
        ${CMAKE_SOURCE_DIR}/../../native/net/*.*
        ${CMAKE_SOURCE_DIR}/../../native/thread/*.*

        ${CMAKE_SOURCE_DIR}/../../native/processor/*.*
        ${CMAKE_SOURCE_DIR}/../../native/protocol/*.*
        ${CMAKE_SOURCE_DIR}/../../native/report/*.*
        ${CMAKE_SOURCE_DIR}/../../native/log/*.*
        ${CMAKE_SOURCE_DIR}/../../../third_party/jsoncpp/src/lib_json/*.*
        ${CMAKE_SOURCE_DIR}/../../../third_party/jsoncpp/include/json/*.*

        ${GEN_FILES}
        )

add_library(lynxdebugrouter SHARED
        ${DEBUGROUTER_SRC_LIST}
        ${GEN_SRC_LIST}
        )

find_library(log-lib log)
find_library(dl-lib dl)
find_library(android-lib android)

set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} -Wl,--exclude-libs,ALL")

MESSAGE(WARNING "add max-page-size config")
if (${ANDROID_ABI} STREQUAL "arm64-v8a" OR ${ANDROID_ABI} STREQUAL "x86_64")
    set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384")
endif()

# liblynxdebugrouter
target_link_libraries(lynxdebugrouter
    ${log-lib}
    ${dl-lib}
    ${android-lib}
)
