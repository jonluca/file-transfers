import { requireOptionalNativeModule } from "expo";

import type { DirectTransferNativeModuleType } from "./DirectTransferNative.types";

export default requireOptionalNativeModule<DirectTransferNativeModuleType>("DirectTransferNative");
