import { Platform } from "react-native";
import BuildEnvironment from "@/modules/build-environment";

export function isTestFlightBuild() {
  return Platform.OS === "ios" && BuildEnvironment?.isTestFlight === true;
}

export function canUseLocalPremiumOverride() {
  return __DEV__ || isTestFlightBuild();
}
