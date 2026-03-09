import { requireNativeModule } from "expo";

import type { NearbyAdvertiserModuleType } from "./NearbyAdvertiser.types";

export default requireNativeModule<NearbyAdvertiserModuleType>("NearbyAdvertiser");
