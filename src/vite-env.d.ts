/// <reference types="vite/client" />
declare global {
  interface Window {
    sentinelDesktop?: {
      getRuntimeInfo: () => Promise<{ platform: string; version: string; packaged: boolean; appName: string }>;
      exportEvidence: (request: { format: 'json' | 'csv'; fileName?: string; content: string }) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }>;
      getUserDataPath: () => Promise<string>;
      listSerialPorts: () => Promise<{ ports: Array<{ path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }> }>;
      connectBoard: (request: { device: 'uno' | 'sentinel'; path: string; baudRate: number }) => Promise<{ ok: boolean; error?: string }>;
      disconnectBoard: (device: 'uno' | 'sentinel') => Promise<{ ok: boolean; error?: string }>;
      sendBoardCommand: (request: { device: 'uno' | 'sentinel'; command: string }) => Promise<{ ok: boolean; error?: string; requestId?: string; commandName?: string; sensitive?: boolean }>;
      onSerialEvent: (callback: (event: { kind: string; device: 'uno' | 'sentinel'; path?: string; line?: string; message?: string; at?: number; commandName?: string; sensitive?: boolean; requestId?: string }) => void) => () => void;
    };
  }
}
export {};
