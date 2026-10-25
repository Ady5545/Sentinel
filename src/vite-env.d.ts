/// <reference types="vite/client" />
declare global {
  interface Window {
    sentinelDesktop?: {
      getRuntimeInfo: () => Promise<{ platform: string; version: string; packaged: boolean; appName: string }>;
      listSerialPorts: () => Promise<{ ports: Array<{ path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }> }>;
      connectBoard: (request: { device: 'uno' | 'sentinel'; path: string; baudRate: number }) => Promise<{ ok: boolean; error?: string }>;
      disconnectBoard: (device: 'uno' | 'sentinel') => Promise<{ ok: boolean; error?: string }>;
      onSerialEvent: (callback: (event: { kind: string; device: 'uno' | 'sentinel'; path?: string; line?: string; message?: string; at?: number }) => void) => () => void;
    };
  }
}
export {};
