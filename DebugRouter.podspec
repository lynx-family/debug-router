#
# Be sure to run `pod lib lint DebugRouter.podspec' to ensure this is a
# valid spec before submitting.
#
# Any lines starting with a # are optional, but their use is encouraged
# To learn more about a Podspec see https://guides.cocoapods.org/syntax/podspec.html
#

Pod::Spec.new do |s|
  s.name             = 'DebugRouter'
  s.version          = "#{ ENV['POD_VERSION'] || File.read('DEBUG_ROUTER_VERSION').strip }"
  s.summary          = 'A short description of DebugRouter.'
  s.homepage         = 'https://github.com/lynx-family/debug-router'
  s.license          = 'Apache'
  s.author           = 'Lynx'
  s.source           = { :git => 'https://github.com/lynx-family/debug-router.git', :tag => s.version.to_s + '-ios'  }
  s.pod_target_xcconfig = { "GCC_PREPROCESSOR_DEFINITIONS" => "OS_IOS=1" }

  s.ios.deployment_target = '9.0'

  s.subspec 'Framework' do |ss|
    ss.source_files = 'debug_router/iOS/public/*.{h,m,mm}', 'debug_router/iOS/public/base/*.{h,m,mm}', 'debug_router/iOS/*.{h,m,mm}', 'debug_router/iOS/net/*.{h,m,mm}', 'debug_router/iOS/report/*.{h,m,mm}', 'debug_router/iOS/base/*.{h,m,mm}', 'debug_router/iOS/base/report/*.{h,m,mm}', 'debug_router/iOS/base/service/*.{h,m,mm}'
    ss.pod_target_xcconfig  = { "HEADER_SEARCH_PATHS" => "\"${PODS_TARGET_SRCROOT}/debug_router/iOS/\"" }
    ss.dependency 'SocketRocket','0.6.0'
    ss.dependency 'DebugRouter/Native'
    ss.public_header_files = 'debug_router/iOS/public/DebugRouter.h', 'debug_router/iOS/public/DebugRouterMessageHandler.h', 'debug_router/iOS/public/DebugRouterCommon.h', 'debug_router/iOS/public/DebugRouterMessageHandleResult.h', "debug_router/iOS/public/DebugRouterEventSender.h", "debug_router/iOS/public/DebugRouterGlobalHandler.h", "debug_router/iOS/public/DebugRouterSlot.h", "debug_router/iOS/public/base/DebugRouterReportServiceUtil.h", "debug_router/iOS/public/base/DebugRouterToast.h", "debug_router/iOS/public/DebugRouterSessionHandler.h", "debug_router/iOS/public/base/DebugRouterDefines.h", "debug_router/iOS/public/base/DebugRouterReportServiceProtocol.h", "debug_router/iOS/public/base/DebugRouterService.h", "debug_router/iOS/public/base/DebugRouterServiceProtocol.h"
  end

  s.subspec 'Native' do |ss|
    ss.header_mappings_dir  = "."
    ss.source_files = 'debug_router/native/**/*'
    ss.exclude_files = 'debug_router/native/android/**/*','debug_router/native/test/*','debug_router/native/socket/win/*'
    ss.pod_target_xcconfig  = { "HEADER_SEARCH_PATHS" =>  "\"${PODS_TARGET_SRCROOT}\" \"${PODS_TARGET_SRCROOT}/third_party/jsoncpp/include\""}
    ss.dependency 'DebugRouter/third_party'
    ss.private_header_files = 'debug_router/native/**/*.{h}'
  end

  s.subspec "third_party" do |sp|
    sp.libraries            = "stdc++"
    sp.pod_target_xcconfig = { "HEADER_SEARCH_PATHS" => " \"${PODS_TARGET_SRCROOT}/third_party/jsoncpp/include\" " }
    sp.subspec "jsoncpp" do |ssp|
      ssp.header_mappings_dir  = "third_party"
      ssp.source_files             = "third_party/jsoncpp/include/json/*.h",
                                     "third_party/jsoncpp/src/lib_json/json_tool.h",
                                     "third_party/jsoncpp/src/lib_json/json_reader.cpp",
                                     "third_party/jsoncpp/src/lib_json/json_value.cpp",
                                     "third_party/jsoncpp/src/lib_json/json_writer.cpp",
                                     "third_party/jsoncpp/src/lib_json/json_valueiterator.inl"
      ssp.compiler_flags      = "-Wno-documentation", "-Wno-deprecated"
      ssp.private_header_files = 'third_party/jsoncpp/**/*.{h}', 'third_party/jsoncpp/**/*.{inl}'
    end
  end
end
