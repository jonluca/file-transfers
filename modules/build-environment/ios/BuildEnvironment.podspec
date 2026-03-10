Pod::Spec.new do |s|
  s.name           = 'BuildEnvironment'
  s.version        = '1.0.0'
  s.summary        = 'Build environment helpers for File Share'
  s.description    = 'Reports native build environment flags such as TestFlight receipt state.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
