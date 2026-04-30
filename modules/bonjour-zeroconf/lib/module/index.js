"use strict";

import { useIsScanning } from "./useIsScanning.js";
import { BonjourFail } from "./specs/BonjourFail.js";
import { requestLocalNetworkPermission, useLocalNetworkPermission } from './permissions';
import { BonjourScanner } from "./BonjourScanner.js";
export const Scanner = new BonjourScanner();
export { BonjourScanner, useIsScanning, requestLocalNetworkPermission, useLocalNetworkPermission, BonjourFail };
//# sourceMappingURL=index.js.map