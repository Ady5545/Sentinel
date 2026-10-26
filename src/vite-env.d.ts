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
  card?: string;
  notes500?: number;
  notes200?: number;
  notes100?: number;
  notes50?: number;
  total?: number;
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
      getSerialReadiness: () => Promise<{ pairReady: boolean; freshnessMs: number; researchMode: 'SIMULATION' | 'HIL'; boards: Record<SentinelDevice, SentinelReadinessBoard>; hilFaultLatched: boolean; faultResetBaseline: { uno: number; sentinel: number } | null; boardBootEpochs: { uno: number; sentinel: number }; canClearHilFault: boolean; hilShadowTouched: boolean }>;
      setResearchMode: (mode: 'SIMULATION' | 'HIL') => Promise<{ ok: boolean; mode?: 'SIMULATION' | 'HIL'; error?: string }>;
      clearHilFault: () => Promise<{ ok: boolean; error?: string }>
      connectBoard: (request: { device: SentinelDevice; path: string; baudRate: number }) => Promise<{ ok: boolean; error?: string; sessionId?: string; phase?: SentinelBoardPhase }>;
      disconnectBoard: (device: SentinelDevice) => Promise<{ ok: boolean; error?: string }>;
      sendBoardCommand: (request: { device: SentinelDevice; command: { name: string; args: string[] } }) => Promise<{ ok: boolean; error?: string; requestId?: string; commandName?: string; sensitive?: boolean }>;
      onSerialEvent: (callback: (event: {
        kind: string; code?: string; device: SentinelDevice; path?: string; line?: string; message?: string;
        at?: number; commandName?: string; sensitive?: boolean; requestId?: string; sessionId?: string;
        phase?: SentinelBoardPhase; parsed?: SentinelParsedBoardEvent; mode?: 'SIMULATION' | 'HIL';
      }) => void) => () => void;
    };
  }
}
export {};
