export interface NearbyAdvertiserStartResult {
  serviceName: string;
}

export interface NearbyAdvertiserModuleType {
  startAdvertising(
    serviceName: string,
    type: string,
    domain: string,
    port: number,
  ): Promise<NearbyAdvertiserStartResult>;
  stopAdvertising(serviceName: string): Promise<void>;
}
