"use strict";

import { useEffect, useState } from 'react';
import { Scanner } from "./index.js";
export const useIsScanning = () => {
  const [scanRunning, setScanRunning] = useState(false);
  useEffect(() => {
    const {
      remove
    } = Scanner.listenForScanState(scanning => {
      setScanRunning(scanning);
    });
    return () => {
      remove();
    };
  }, []);
  return scanRunning;
};
//# sourceMappingURL=useIsScanning.js.map