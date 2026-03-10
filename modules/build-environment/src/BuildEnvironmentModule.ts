import { requireOptionalNativeModule } from "expo";

import type { BuildEnvironmentModuleType } from "./BuildEnvironment.types";

export default requireOptionalNativeModule<BuildEnvironmentModuleType>("BuildEnvironment");
