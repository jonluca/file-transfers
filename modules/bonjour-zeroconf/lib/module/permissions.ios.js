"use strict";

import { NitroModules } from 'react-native-nitro-modules';
import { useEffect, useState } from 'react';
const LocalNetworkPermission = NitroModules.createHybridObject('LocalNetworkPermission');
export const requestLocalNetworkPermission = async () => {
  return await LocalNetworkPermission.requestPermission();
};
export const useLocalNetworkPermission = () => {
  const [permissionGranted, setPermissionGranted] = useState(false);
  useEffect(() => {
    const {
      remove
    } = LocalNetworkPermission.listenForPermission(granted => {
      setPermissionGranted(granted);
    });
    return () => {
      remove();
    };
  }, []);
  return [permissionGranted, requestLocalNetworkPermission];
};
//# sourceMappingURL=permissions.ios.js.map