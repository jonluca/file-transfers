"use strict";

import { NitroModules } from 'react-native-nitro-modules';
export class BonjourScanner {
  constructor(options) {
    this._scanner = NitroModules.createHybridObject('BonjourZeroconf');
    this.id = options?.id;
    if (this.id !== undefined) {
      this._scanner.id = this.id;
    }
  }
  get isScanning() {
    return this._scanner.isScanning;
  }
  scan(type, domain, options) {
    this._scanner.scan(type, domain, options);
  }
  scanFor(time, type, domain, options) {
    return this._scanner.scanFor(time, type, domain, options);
  }
  stop() {
    this._scanner.stop();
  }
  listenForScanResults(onResult) {
    return this._scanner.listenForScanResults(onResult);
  }
  listenForScanState(onChange) {
    return this._scanner.listenForScanState(onChange);
  }
  listenForScanFail(onFail) {
    return this._scanner.listenForScanFail(onFail);
  }
}
//# sourceMappingURL=BonjourScanner.js.map