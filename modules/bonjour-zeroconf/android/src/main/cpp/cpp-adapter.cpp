#include <jni.h>
#include <fbjni/fbjni.h>
#include "dawidzawada_bonjourzeroconfOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, []() {
    margelo::nitro::dawidzawada_bonjourzeroconf::registerAllNatives();
  });
}
