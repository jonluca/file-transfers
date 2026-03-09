import type { NearbyAdvertiserModuleType } from "./NearbyAdvertiser.types";

const NearbyAdvertiserWebModule: NearbyAdvertiserModuleType = {
  async startAdvertising() {
    throw new Error("Nearby advertising is unavailable on web.");
  },
  async stopAdvertising() {},
};

export default NearbyAdvertiserWebModule;
