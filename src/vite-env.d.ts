/// <reference types="vite/client" />

type SentinelDevice = 'uno' | 'sentinel';
type SentinelBoardPhase = 'DISCONNECTED' | 'USB OPEN' | 'BOOTED' | 'NEGOTIATING' | 'HEALTHY' | 'OBSERVING' | 'STALE' | 'REVOKED' | 'ERROR';
type SentinelParsedBoardEvent = {
  type: string;
  phase?: SentinelBoardPhase;
  eventName?: string;
  id?: string;
  amount?: number;
  balance?: number;
  reason?: string;
};
type SentinelReadinessBoard = {
  device: SentinelDevice;
  connected: boolean;
  path: string;
  sessionId?: string;
  phase: SentinelBoardPhase;
  lastLineAt: number;
  readinessAt: number;
};

declare global {
  interface Window {
    sentinelDesktop?: {
      getRuntimeInfo: () => Promise<{ platform: string; version: string; packaged: boolean; appName: string }>;
      exportEvidence: (request: { format: 'json' | 'csv'; fileName?: string; content: string }) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }>;
      getUserDataPath: () => Promise<string>;
      listSerialPorts: () => Promise<{ ports: Array<{ path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }> }>;
      getSerialReadiness: () => Promise<{ pairReady: boolean; freshnessMs: number; boards: Record<SentinelDevice, SentinelReadinessBoard> }>;
      connectBoard: (request: { device: SentinelDevice; path: string; baudRate: number }) => Promise<{ ok: boolean; error?: string; sessionId?: string; phase?: SentinelBoardPhase }>;
      disconnectBoard: (device: SentinelDevice) => Promise<{ ok: boolean; error?: string }>;
      sendBoardCommand: (request: { device: SentinelDevice; command: { name: string; args: string[] } }) => Promise<{ ok: boolean; error?: string; requestId?: string; commandName?: string; sensitive?: boolean }>;
      onSerialEvent: (callback: (event: {
        kind: string; code?: string; device: SentinelDevice; path?: string; line?: string; message?: string;
        at?: number; commandName?: string; sensitive?: boolean; requestId?: string; sessionId?: string;
        phase?: SentinelBoardPhase; parsed?: SentinelParsedBoardEvent;
      }) => void) => () => void;
    };
  }
}
export {};
