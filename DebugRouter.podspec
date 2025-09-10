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
    ss.source_files = 'debug_router/ios/public/*.{h,m,mm}', 'debug_router/ios/public/base/*.{h,m,mm}', 'debug_router/ios/*.{h,m,mm}', 'debug_router/ios/net/*.{h,m,mm}', 'debug_router/ios/report/*.{h,m,mm}', 'debug_router/ios/base/*.{h,m,mm}', 'debug_router/ios/base/report/*.{h,m,mm}', 'debug_router/ios/base/service/*.{h,m,mm}'
    ss.pod_target_xcconfig  = { "HEADER_SEARCH_PATHS" => "\"${PODS_TARGET_SRCROOT}/debug_router/ios/\"" }
    ss.dependency 'DebugRouter/Native'
    ss.public_header_files = 'debug_router/ios/public/DebugRouter.h', 'debug_router/ios/public/DebugRouterMessageHandler.h', 'debug_router/ios/public/DebugRouterCommon.h', 'debug_router/ios/public/DebugRouterMessageHandleResult.h', "debug_router/ios/public/DebugRouterEventSender.h", "debug_router/ios/public/DebugRouterGlobalHandler.h", "debug_router/ios/public/DebugRouterSlot.h", "debug_router/ios/public/base/DebugRouterReportServiceUtil.h", "debug_router/ios/public/base/DebugRouterToast.h", "debug_router/ios/public/DebugRouterSessionHandler.h", "debug_router/ios/public/base/DebugRouterDefines.h", "debug_router/ios/public/base/DebugRouterReportServiceProtocol.h", "debug_router/ios/public/base/DebugRouterService.h", "debug_router/ios/public/base/DebugRouterServiceProtocol.h", "debug_router/ios/public/LocalNetworkPermissionChecker.h"
  end

  s.subspec 'Native' do |ss|
    ss.header_mappings_dir  = "."
    ss.source_files = 'debug_router/native/**/*'
    ss.exclude_files = 'debug_router/native/android/**/*','debug_router/native/test/*','debug_router/native/socket/win/*', 'debug_router/native/harmony/**/*'
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

  s.subspec "MessageTransceiverEnable" do |sp|
    sp.source_files = 'debug_router/common/debug_router_export.h'
    sp.pod_target_xcconfig = { "GCC_PREPROCESSOR_DEFINITIONS" => "ENABLE_MESSAGE_IMPL=1 $(inherited)" }
  end
end
