import type { ScanOptions } from './specs/BonjourZeroconf.nitro';
import type { ScanResult } from './specs/ScanResult';
import type { BonjourListener } from './specs/BonjourListener';
import type { BonjourFail } from './specs/BonjourFail';
export interface BonjourScannerOptions {
    id?: string;
}
export declare class BonjourScanner {
    private _scanner;
    readonly id: string | undefined;
    constructor(options?: BonjourScannerOptions);
    get isScanning(): boolean;
    scan(type: string, domain: string, options?: ScanOptions): void;
    scanFor(time: number, type: string, domain: string, options?: ScanOptions): Promise<ScanResult[]>;
    stop(): void;
    listenForScanResults(onResult: (results: ScanResult[]) => void): BonjourListener;
    listenForScanState(onChange: (isScanning: boolean) => void): BonjourListener;
    listenForScanFail(onFail: (fail: BonjourFail) => void): BonjourListener;
}
//# sourceMappingURL=BonjourScanner.d.ts.map