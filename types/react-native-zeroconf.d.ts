declare module "react-native-zeroconf" {
  import type { EventEmitter } from "events";

  export enum ImplType {
    NSD = "NSD",
    DNSSD = "DNSSD",
  }

  export interface ZeroconfService {
    name: string;
    fullName: string;
    host?: string;
    port: number;
    addresses?: string[];
    txt?: Record<string, string>;
  }

  export default class Zeroconf extends EventEmitter {
    scan(type: string, protocol?: string, domain?: string, implType?: ImplType): void;
    stop(implType?: ImplType): void;
    publishService(
      type: string,
      protocol: string,
      domain: string,
      name: string,
      port: number,
      txt?: Record<string, string>,
      implType?: ImplType,
    ): void;
    unpublishService(name: string, implType?: ImplType): void;
    getServices(): Record<string, ZeroconfService>;
    removeDeviceListeners(): void;
  }
}
