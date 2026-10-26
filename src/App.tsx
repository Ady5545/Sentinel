import { useEffect, useReducer, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import {
  Activity, ArrowRight, Banknote, CheckCircle2, ChevronRight, CircleAlert, Cpu,
  FileText, Fingerprint, Landmark, LockKeyhole, Monitor, Plug, RotateCcw,
  ShieldAlert, ShieldCheck, Terminal, WalletCards, XOctagon
} from 'lucide-react';
import {
  atmReducer, initialAtmState,
  type AtmAction, type AtmState, type JournalEvent, type Service
} from './core/atm-engine';
import { canBeginHilWithdrawal, redactSensitiveSerialText, type HilShadowState, type HilTransaction } from './core/hil-evidence';
import { createUnoHilAdapter, type UnoCommand } from './core/uno-hil-adapter';
import {
  canRecommissionHilShadow, createInitialResearchSession, replayRunRecords, researchPairReady,
  researchSessionReducer, RESEARCH_SCENARIO_CATALOG, type ResearchMode
} from './core/research-session';

type View = 'terminal' | 'machine' | 'sentinel' | 'experiments' | 'journal' | 'hardware';
type DeviceKey = 'uno' | 'sentinel';
type BoardCommand = UnoCommand;
const createResearchRunId = (mode: ResearchMode) => (mode === 'HIL' ? 'HIL' : 'SIM') + '-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
type Port = { path: string; manufacturer?: string; vendorId?: string; productId?: string; serialNumber?: string };
type BoardPhase = 'DISCONNECTED' | 'USB OPEN' | 'BOOTED' | 'NEGOTIATING' | 'HEALTHY' | 'OBSERVING' | 'STALE' | 'REVOKED' | 'ERROR';
type BoardState = { connected: boolean; path: string; lastLine: string; lastLineAt: number; readinessAt: number; sessionId?: string; phase: BoardPhase; error?: string };
const serviceList: { id: Service; label: string; subtitle: string; icon: typeof Banknote }[] = [
  { id: 'withdrawal', label: 'Cash withdrawal', subtitle: 'Dispense virtual banknotes', icon: Banknote },
  { id: 'balance', label: 'Balance inquiry', subtitle: 'View available funds', icon: WalletCards },
  { id: 'statement', label: 'Mini statement', subtitle: 'Recent synthetic transactions', icon: FileText },
  { id: 'transfer', label: 'Funds transfer', subtitle: 'Fictional beneficiary only', icon: ArrowRight },
  { id: 'pin-change', label: 'PIN services', subtitle: 'Demonstration only', icon: LockKeyhole }
];
const initialBoards: Record<DeviceKey, BoardState> = {
  uno: { connected: false, path: '', lastLine: '', lastLineAt: 0, readinessAt: 0, phase: 'DISCONNECTED' },
  sentinel: { connected: false, path: '', lastLine: '', lastLineAt: 0, readinessAt: 0, phase: 'DISCONNECTED' }
};
const money = (value: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
const clock = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const HIL_RECONCILIATION_TIMEOUT_MS = 8000;

function invalidateInFlightHilTransaction(current: HilTransaction | null, message: string): HilTransaction | null {
  if (!current || ['RECONCILED', 'DENIED', 'REVOKED', 'MISMATCH'].includes(current.phase)) return current;
  return { ...current, phase: 'MISMATCH', message };
}

export default function App() {
  const [state, dispatch] = useReducer(atmReducer, undefined, () => initialAtmState('protected'));
  const [research, dispatchResearch] = useReducer(researchSessionReducer, undefined, () => createInitialResearchSession(createResearchRunId('SIMULATION'), Date.now()));
  const hilTransaction = research.hilTransaction;
  const [view, setView] = useState<View>('terminal');
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [exportStatus, setExportStatus] = useState('');
  const [ports, setPorts] = useState<Port[]>([]);
  const [chosenPort, setChosenPort] = useState<Record<DeviceKey, string>>({ uno: '', sentinel: '' });
  const [boards, setBoards] = useState<Record<DeviceKey, BoardState>>(initialBoards);
  const [runtime, setRuntime] = useState<{ platform: string; version: string; packaged: boolean } | null>(null);
  const [serialEvents, setSerialEvents] = useState<string[]>([]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [portMessage, setPortMessage] = useState('Board access is optional. The virtual ATM works without hardware.');

  useEffect(() => {
    const handle = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => {
    if (!research.hilTransaction || ['RECONCILED', 'DENIED', 'REVOKED', 'MISMATCH'].includes(research.hilTransaction.phase)) return;
    dispatchResearch({ type: 'HIL_TIMEOUT', at: nowMs });
  }, [nowMs, research.hilTransaction?.phase, research.hilTransaction?.startedAtMs]);

  useEffect(() => {
    const api = window.sentinelDesktop;
    if (!api) return;
    void api.getRuntimeInfo().then(setRuntime).catch(() => undefined);
    void api.listSerialPorts().then(result => setPorts(result.ports)).catch(() => undefined);
    void api.getSerialReadiness().then(snapshot => {
      setBoards(previous => ({
        uno: { ...previous.uno, connected: snapshot.boards.uno.connected, path: snapshot.boards.uno.path, sessionId: snapshot.boards.uno.sessionId, phase: snapshot.boards.uno.phase, lastLineAt: snapshot.boards.uno.lastLineAt, readinessAt: snapshot.boards.uno.readinessAt },
        sentinel: { ...previous.sentinel, connected: snapshot.boards.sentinel.connected, path: snapshot.boards.sentinel.path, sessionId: snapshot.boards.sentinel.sessionId, phase: snapshot.boards.sentinel.phase, lastLineAt: snapshot.boards.sentinel.lastLineAt, readinessAt: snapshot.boards.sentinel.readinessAt }
      }));
      dispatchResearch({
        type: 'RESTORE_BRIDGE', mode: snapshot.researchMode, at: Date.now(),
        boards: { uno: snapshot.boards.uno, sentinel: snapshot.boards.sentinel }
      });
    }).catch(() => undefined);
    const unsubscribe = api.onSerialEvent(event => {
      if (!event.device) {
        if (event.message) setPortMessage(event.message);
        return;
      }
      const safeLine = event.kind === 'line' ? redactSensitiveSerialText(event.line || '') : '';
      const detail = event.kind === 'line' ? safeLine : event.message || event.kind;
      setSerialEvents(previous => [...previous.slice(-199), clock() + '  ' + event.device.toUpperCase() + '  ' + redactSensitiveSerialText(detail)]);
      if (['opened', 'closed', 'error', 'line', 'command-written'].includes(event.kind)) {
        dispatchResearch({
          type: 'BOARD_EVENT',
          kind: event.kind as 'opened' | 'closed' | 'error' | 'line' | 'command-written',
          device: event.device,
          sessionId: event.sessionId,
          at: event.at || Date.now(),
          line: event.kind === 'line' ? safeLine : undefined,
          parsed: event.parsed,
          phase: event.phase,
          commandName: event.commandName,
          sensitive: event.sensitive,
          requestId: event.requestId,
          message: event.message
        });
      }
      setBoards(previous => {
        const current = previous[event.device];
        const line = event.kind === 'line' ? (safeLine || '') : '';
        let phase: BoardPhase = current.phase;
        const parsedPhase = event.kind === 'line' ? event.parsed?.phase : undefined;
        if (event.kind === 'opened') phase = event.phase || 'USB OPEN';
        else if (event.kind === 'closed') phase = 'DISCONNECTED';
        else if (event.kind === 'error') phase = 'ERROR';
        else if (parsedPhase) phase = parsedPhase;
        else if (/SENTINEL ATM CONTROLLER V\d+(?:\.\d+)? READY|SENTINEL ESP32 GUARDIAN V\d+(?:\.\d+)? READY/.test(line) || line.startsWith('SESSION: ')) phase = 'BOOTED';
        else if (line.includes('[LINK] V3 negotiation started') || line.includes('[LINK] V3 guardian HELLO observed')) phase = 'NEGOTIATING';
        else if (event.device === 'uno' && line.includes('[STATUS_RX] Accepted HEALTHY')) phase = 'HEALTHY';
        else if (event.device === 'sentinel' && line.includes('GUARDIAN_STATUS|mode=OBSERVING')) phase = 'OBSERVING';
        else if (line.includes('[SECURITY_LOCK]') || line.includes('[REVOKE]') || line.includes('GUARDIAN_STATUS|mode=REVOKED') || line.includes('GUARDIAN_REVOKED')) phase = 'REVOKED';
        else if (line.includes('[LINK] V3 handshake complete') || line.includes('[LINK] V3 handshake confirmed')) phase = 'NEGOTIATING';
        return {
          ...previous,
          [event.device]: {
            ...current,
            connected: event.kind === 'opened' ? true : event.kind === 'closed' || event.kind === 'error' ? false : current.connected,
            path: event.path || current.path,
            sessionId: event.sessionId || (event.kind === 'closed' || event.kind === 'error' ? undefined : current.sessionId),
            lastLine: event.kind === 'line' ? safeLine : current.lastLine,
            lastLineAt: event.kind === 'line' ? (event.at || Date.now()) : event.kind === 'closed' || event.kind === 'error' ? 0 : current.lastLineAt,
            readinessAt: event.kind === 'closed' || event.kind === 'error' || (parsedPhase !== undefined && !['HEALTHY', 'OBSERVING'].includes(parsedPhase)) ? 0
              : parsedPhase === 'HEALTHY' || parsedPhase === 'OBSERVING' ? (event.at || Date.now()) : current.readinessAt,
            phase,
            error: event.kind === 'error' ? event.message : undefined
          }
        };
      });
      if (event.kind === 'error') setPortMessage(event.message || 'USB serial error.');
    });
    return unsubscribe;
  }, []);

  const latestSimulationEvent = state.events[state.events.length - 1];
  useEffect(() => {
    if (!latestSimulationEvent) return;
    const scenario = state.scenarioApplied
      ? { id: RESEARCH_SCENARIO_CATALOG[0].id, version: RESEARCH_SCENARIO_CATALOG[0].version }
      : undefined;
    dispatchResearch({
      type: 'SIMULATION_EVENT',
      eventKey: state.runId + ':' + latestSimulationEvent.id,
      event: latestSimulationEvent,
      at: Date.now(),
      scenario
    });
  }, [latestSimulationEvent?.id, state.runId, state.scenarioApplied]);


  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<View>;
      if (['terminal','machine','sentinel','experiments','journal','hardware'].includes(custom.detail)) setView(custom.detail);
    };
    window.addEventListener('sentinel:navigate', handler);
    return () => window.removeEventListener('sentinel:navigate', handler);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(value => !value); setLauncherOpen(false); }
      if (event.key === 'Escape') { setCommandOpen(false); setLauncherOpen(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const navigateTo = (next: View) => { setView(next); setLauncherOpen(false); setCommandOpen(false); setCommandQuery(''); };
  const appItems: { id: View; label: string; detail: string; icon: typeof Monitor }[] = [
    { id: 'terminal', label: 'ATM Terminal', detail: 'Customer session and transactions', icon: Landmark },
    { id: 'machine', label: 'Machine Studio', detail: 'Cabinet and component states', icon: Monitor },
    { id: 'sentinel', label: 'Security Center', detail: 'Evidence, policy and authority', icon: ShieldCheck },
    { id: 'experiments', label: 'Experiment Lab', detail: 'Run controlled scenarios', icon: Fingerprint },
    { id: 'journal', label: 'Incident Journal', detail: 'Timeline and event evidence', icon: Activity },
    { id: 'hardware', label: 'Hardware Bridge', detail: 'Arduino and ESP32 serial link', icon: Plug }
  ];
  const exportEvidence = async (format: 'json' | 'csv') => {
    const api = window.sentinelDesktop;
    if (!api) { setExportStatus('Native evidence export is available in the desktop application, not browser preview.'); return; }
    const payload = {
      product: 'SENTINEL Research Environment', schemaVersion: 1, exportedAt: new Date().toISOString(),
      mode: state.mode,
      evidenceProvenance: 'MIXED: simulated software state plus board-reported USB console text; no cryptographic hardware attestation',
      researchLimit: 'Virtual ATM only. No real cash, bank connection, or physical dispenser.',
      summary: { accountId: state.accountId, accountBalance: state.accountBalance, cassetteCash: state.cassetteCash, dispensedTotal: state.dispensedTotal, controllerState: state.controllerState, sentinelStatus: state.sentinelStatus, lastDecision: state.lastDecision, findings: state.findings },
      transactions: state.transactions,
      events: state.events,
      hardware: {
        mode: 'OPTIONAL HARDWARE-IN-THE-LOOP OBSERVATION',
        provenance: 'BOARD-REPORTED USB console text; parsed correlation is not cryptographic attestation',
        boards: {
          uno: { connected: boards.uno.connected, phase: boards.uno.phase, sessionId: boards.uno.sessionId, lastLineAt: boards.uno.lastLineAt, readinessAt: boards.uno.readinessAt, lastLine: redactSensitiveSerialText(boards.uno.lastLine) },
          sentinel: { connected: boards.sentinel.connected, phase: boards.sentinel.phase, sessionId: boards.sentinel.sessionId, lastLineAt: boards.sentinel.lastLineAt, readinessAt: boards.sentinel.readinessAt, lastLine: redactSensitiveSerialText(boards.sentinel.lastLine) }
        },
        activeTransaction: hilTransaction,
        recentSerialObservations: serialEvents.slice(-200).map(redactSensitiveSerialText)
      }
    };
    const csvCell = (value: unknown) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
    const csvRows = [
      ...state.events.map(item => [item.at,item.id,item.severity,item.source,item.title,item.detail].map(csvCell).join(',')),
      ...serialEvents.slice(-200).map((line,index) => {
        const parts = line.split(/\s+/);
        const time = parts[0] || '';
        const role = parts[1] || 'SYSTEM';
        const detail = redactSensitiveSerialText(parts.slice(2).join(' '));
        const severe = /REVOKE|SECURITY_LOCK|DENIED|MISMATCH|mode=REVOKED/i.test(detail);
        const successful = /PERMIT|APPROVED|Accepted HEALTHY|mode=OBSERVING/i.test(detail);
        return [time,'HIL-'+index,severe?'critical':successful?'success':'info',role,'Board serial observation',detail].map(csvCell).join(',');
      })
    ];
    const csv = ['timestamp,id,severity,source,title,detail', ...csvRows].join('\r\n');
    try {
      const result = await api.exportEvidence({ format, fileName: format === 'json' ? 'sentinel-evidence.json' : 'sentinel-events.csv', content: format === 'json' ? JSON.stringify(payload, null, 2) : csv });
      setExportStatus(result.ok ? 'Evidence exported to ' + result.filePath : result.canceled ? 'Export cancelled.' : result.error || 'Export failed.');
    } catch (error) { setExportStatus(error instanceof Error ? error.message : String(error)); }
  };
  const hardwareJournalEvents: JournalEvent[] = serialEvents.slice(-80).map((entry,index) => {
    const parts = entry.split(/\s+/);
    const line = redactSensitiveSerialText(parts.slice(2).join(' '));
    const severity = /REVOKE|SECURITY_LOCK|DENIED|MISMATCH|mode=REVOKED/i.test(line) ? 'critical'
      : /PERMIT|APPROVED|Accepted HEALTHY|mode=OBSERVING/i.test(line) ? 'success' : 'info';
    const source = parts[1] === 'UNO' ? 'UNO' : parts[1] === 'SENTINEL' ? 'SENTINEL' : 'SYSTEM';
    return { id: 'HIL-' + index, at: parts[0] || '--:--:--', severity, source, title: 'Hardware serial observation', detail: line };
  });
  const combinedJournalEvents = [...state.events, ...hardwareJournalEvents].reverse();
  const eventCount = state.events.length + hardwareJournalEvents.length;
  const alerts = state.events.filter(event => event.severity === 'warning' || event.severity === 'critical').length +
    hardwareJournalEvents.filter(event => event.severity === 'warning' || event.severity === 'critical').length;
  const refreshPorts = async () => {
    if (!window.sentinelDesktop) {
      setPortMessage('USB controls are available in the installed desktop app; a browser preview is not the product runtime.');
      return;
    }
    try {
      const result = await window.sentinelDesktop.listSerialPorts();
      setPorts(result.ports);
      setPortMessage(result.ports.length ? 'Select the correct board port. Port order is not used as device identity.' : 'No serial devices found. Connect a board or continue in simulation mode.');
    } catch (error) {
      setPortMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const connectBoard = async (device: DeviceKey) => {
    const path = chosenPort[device];
    if (!window.sentinelDesktop || !path) {
      setPortMessage('Choose a serial port first. Close Arduino IDE Serial Monitor if it already owns that port.');
      return;
    }
    const response = await window.sentinelDesktop.connectBoard({ device, path, baudRate: 115200 });
    setPortMessage(response.ok ? 'USB console open. Serial text is observational, not proof of controller integrity.' : response.error || 'Connection failed.');
    if (response.ok) setBoards(previous => ({ ...previous, [device]: { ...previous[device], connected: true, path, sessionId: response.sessionId, phase: response.phase || 'USB OPEN', lastLineAt: 0, readinessAt: 0 } }));
  };
  const disconnectBoard = async (device: DeviceKey) => {
    if (!window.sentinelDesktop) return;
    await window.sentinelDesktop.disconnectBoard(device);
    setBoards(previous => ({ ...previous, [device]: { ...previous[device], connected: false, path: '', sessionId: undefined, lastLineAt: 0, readinessAt: 0, phase: 'DISCONNECTED' } }));
  };
  const sendBoardCommand = async (device: DeviceKey, command: BoardCommand) => {
    if (!window.sentinelDesktop) return { ok: false, error: 'Board commands require the installed desktop application.' };
    const response = await window.sentinelDesktop.sendBoardCommand({ device, command });
    setPortMessage(response.ok
      ? (response.commandName || command.name) + ' bytes were written to ' + device.toUpperCase() + '; this is not confirmation the board accepted the command.'
      : response.error || 'Board command write failed.');
    return response;
  };

  const switchResearchMode = async () => {
    const nextMode: ResearchMode = research.mode === 'HIL' ? 'SIMULATION' : 'HIL';
    const tx = research.hilTransaction;
    if (tx && !['RECONCILED', 'DENIED', 'MISMATCH', 'REVOKED'].includes(tx.phase)) {
      setPortMessage('Mode switch blocked: resolve or safely fault the current HIL transaction first.');
      return;
    }
    if (nextMode === 'HIL' && (research.hilFaultLatched || research.hilShadow.status === 'RECONCILIATION REQUIRED')) {
      setPortMessage('HIL mode blocked: reset both boards after the fault, clear the host fault latch, then recommission the RAM-only account and cassette.');
      return;
    }
    const api = window.sentinelDesktop;
    if (!api) {
      setPortMessage('HIL mode is available only in the installed desktop app. The browser preview stays software-only.');
      return;
    }
    try {
      const hostMode = await api.setResearchMode(nextMode);
      if (!hostMode.ok) {
        setPortMessage(hostMode.error || 'The host rejected the requested research mode.');
        return;
      }
      dispatchResearch({ type: 'SET_MODE', mode: nextMode, runId: createResearchRunId(nextMode), at: Date.now() });
      setPortMessage(nextMode === 'HIL'
        ? 'HIL mode enabled. Connect both boards, wait for fresh paired readiness, then commission the fictional account and cassette.'
        : 'Software-only simulation mode restored. HIL-only serial commands are disabled at the host boundary.');
    } catch (error) {
      setPortMessage(error instanceof Error ? error.message : 'Research mode change failed.');
    }
  };

  const clearHilRecord = async () => {
    const api = window.sentinelDesktop;
    if (research.hilFaultLatched) {
      if (!canRecommissionHilShadow(research, nowMs)) {
        setPortMessage('Fault remains latched until both boards reboot after the fault and fresh paired readiness returns.');
        return;
      }
      if (!api) { setPortMessage('Fault clearance requires the installed desktop host.'); return; }
      const hostClear = await api.clearHilFault();
      if (!hostClear.ok) {
        setPortMessage(hostClear.error || 'The host did not clear the HIL fault latch.');
        return;
      }
      dispatchResearch({ type: 'CLEAR_HIL_FAULT', at: Date.now() });
      setHilTransactionStartedAt(undefined);
      setPortMessage('HIL fault cleared after the required paired reboot/readiness gate. The shadow is UNCOMMISSIONED until new board configuration reports arrive.');
      return;
    }
    dispatchResearch({ type: 'CLEAR_TRANSACTION', at: Date.now() });
  };

  return <div className="sentinel-os">
    <header className="os-menubar"><div className="os-brand"><span className="os-brand-mark"><ShieldCheck size={13} /></span><strong>SENTINEL</strong><span className="os-separator">/</span><span>RESEARCH ENVIRONMENT</span></div><div className="os-menubar-center"><span className="os-live-dot" /> LOCAL WORKSTATION <span className="os-separator">·</span> OFFLINE-FIRST</div><div className="os-menubar-right"><span className="os-runtime">{runtime ? runtime.platform.toUpperCase() + ' · ' + runtime.version : 'DEVELOPMENT SESSION'}</span><span className="os-menubar-clock">{clock()}</span></div></header>
    <div className="desktop-app">
    <aside className="app-rail">
      <div className="identity"><div className="identity-mark"><ShieldCheck size={23} /></div><div><strong>SENTINEL</strong><small>ATM EMULATOR</small></div></div>
      <div className="rail-divider" />
      <p className="rail-label">MACHINE</p>
      <nav className="rail-nav" aria-label="Machine areas">
        <NavButton active={view === 'terminal'} icon={<Landmark />} label="ATM terminal" onClick={() => setView('terminal')} />
        <NavButton active={view === 'machine'} icon={<Monitor />} label="Machine model" onClick={() => setView('machine')} />
        <NavButton active={view === 'sentinel'} icon={<ShieldCheck />} label="SENTINEL console" onClick={() => setView('sentinel')} />
        <NavButton active={view === 'experiments'} icon={<Fingerprint />} label="Experiment lab" onClick={() => setView('experiments')} />
        <NavButton active={view === 'journal'} icon={<Activity />} label="Event journal" onClick={() => setView('journal')} />
      </nav>
      <div className="rail-divider" />
      <p className="rail-label">INTEGRATION</p>
      <nav className="rail-nav"><NavButton active={view === 'hardware'} icon={<Plug />} label="Hardware bench" onClick={() => setView('hardware')} /></nav>
      <div className="rail-bottom">
        <div className="rail-state"><i /> OFFLINE SIMULATION</div>
        <p>No bank connection<br />No physical cash</p>
        <div className="rail-version">{runtime ? runtime.platform.toUpperCase() + ' · APP ' + runtime.version : 'DESKTOP RESEARCH BUILD'}</div>
      </div>
    </aside>
    <main className="workspace">
      <header className="titlebar">
        <div className="breadcrumbs"><span>SENTINEL</span><ChevronRight size={13} /><strong>{viewTitle(view)}</strong></div>
        <div className="titlebar-status">
          <span className="status-chip"><i /> LOCAL DOMAIN CORE</span>
          <span className={'status-chip ' + (state.sentinelStatus === 'AUTHORITY REVOKED' ? 'critical-chip' : 'safe-chip')}><ShieldCheck size={13} /> {state.sentinelStatus}</span>
        </div>
      </header>
      <div className="page-body">
        {view === 'terminal' && <TerminalView state={state} dispatch={dispatch} />}
        {view === 'machine' && <MachineView state={state} boards={boards} />}
        {view === 'sentinel' && <SentinelView state={state} boards={boards} />}
        {view === 'experiments' && <ExperimentView state={state} dispatch={dispatch} />}
        {view === 'journal' && <JournalView events={combinedJournalEvents} alerts={alerts} onExport={exportEvidence} />}
        {view === 'hardware' && <HardwareView ports={ports} chosenPort={chosenPort} setChosenPort={setChosenPort} boards={boards} message={portMessage} serialEvents={serialEvents} refresh={refreshPorts} connect={connectBoard} disconnect={disconnectBoard} sendCommand={sendBoardCommand} hilTransaction={hilTransaction} boardBootEpochs={boardBootEpochs} hilFaultResetBaseline={hilFaultResetBaseline} nowMs={nowMs} clearHilTransaction={() => { setHilTransaction(null); setHilTransactionStartedAt(null); setHilFaultResetBaseline(null); }} />}
        <footer className="status-footer"><span><i /> DOMAIN CORE ACTIVE</span><span>{eventCount.toString().padStart(3,'0')} EVENTS · {alerts.toString().padStart(2,'0')} ALERTS</span><span>FICTIONAL ACCOUNT · VIRTUAL CASH · RESEARCH PROTOTYPE</span></footer>
      </div>
    </main>
    </div>
    {launcherOpen && <div className="os-launcher-backdrop" onClick={() => setLauncherOpen(false)}><section className="os-launcher" onClick={event => event.stopPropagation()}><div className="os-launcher-heading"><div className="os-launcher-emblem"><ShieldCheck size={22} /></div><div><strong>SENTINEL WORKSPACE</strong><small>LOCAL SECURITY RESEARCH SYSTEM</small></div></div><label className="os-searchbox"><Activity size={16} /><span>Choose a workspace module</span><kbd>ESC</kbd></label><div className="os-app-grid">{appItems.map(item => { const Icon=item.icon; return <button key={item.id} className="os-app-tile" onClick={() => navigateTo(item.id)}><span className="os-app-icon"><Icon size={20} /></span><strong>{item.label}</strong><small>{item.detail}</small></button>; })}</div><div className="os-launcher-footer"><span><i /> ALL SYSTEMS LOCAL</span><span>NO CLOUD ACCOUNT REQUIRED</span></div></section></div>}
    {commandOpen && <div className="os-command-backdrop" onClick={() => setCommandOpen(false)}><section className="os-command" onClick={event => event.stopPropagation()}><div className="os-command-input"><Activity size={18} /><input autoFocus value={commandQuery} onChange={event => setCommandQuery(event.target.value)} placeholder="Search modules and commands…" /><kbd>ESC</kbd></div><div className="os-command-results">{appItems.filter(item => (item.label + ' ' + item.detail).toLowerCase().includes(commandQuery.toLowerCase())).map(item => { const Icon=item.icon; return <button key={item.id} onClick={() => navigateTo(item.id)}><Icon size={17} /><span><strong>{item.label}</strong><small>{item.detail}</small></span><kbd>OPEN</kbd></button>; })}{appItems.every(item => !(item.label + ' ' + item.detail).toLowerCase().includes(commandQuery.toLowerCase())) && <p>No matching workspace module.</p>}</div><div className="os-command-footer">COMMAND PALETTE <span>Navigate · Open modules · Escape to close</span></div></section></div>}
    {exportStatus && <div className="os-toast" role="status"><span><CheckCircle2 size={15} /> {exportStatus}</span><button onClick={() => setExportStatus('')} aria-label="Dismiss export message">×</button></div>}
    <footer className="os-dock"><button className={'os-dock-launcher ' + (launcherOpen ? 'selected' : '')} title="Workspace launcher" onClick={() => { setLauncherOpen(value => !value); setCommandOpen(false); }}><ShieldCheck size={21} /></button><div className="os-dock-divider" />{appItems.map(item => { const Icon=item.icon; return <button key={item.id} title={item.label} aria-label={item.label} className={'os-dock-app ' + (view === item.id ? 'active' : '')} onClick={() => navigateTo(item.id)}><Icon size={18} /><i /></button>; })}<div className="os-dock-spacer" /><button className="os-dock-search" onClick={() => { setCommandOpen(true); setLauncherOpen(false); }}><Activity size={15} /><span>Quick search</span><kbd>⌘ K</kbd></button><div className="os-dock-status"><span className="os-live-dot" /> LOCAL CORE</div></footer>
  </div>;
}

function viewTitle(view: View) {
  return ({ terminal: 'ATM terminal', machine: 'Machine model', sentinel: 'SENTINEL console', experiments: 'Experiment lab', journal: 'Event journal', hardware: 'Hardware bench' } as const)[view];
}
function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return <button className={'rail-button ' + (active ? 'active' : '')} onClick={onClick}>{icon}<span>{label}</span>{active && <i />}</button>;
}
function ScreenHeading({ number, eyebrow, title, description, action }: { number: string; eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="screen-heading"><div><div className="eyebrow"><span>{number}</span>{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}
function PanelTitle({ icon, title, suffix }: { icon: ReactNode; title: string; suffix?: string }) {
  return <div className="panel-title"><span>{icon}{title}</span>{suffix && <small>{suffix}</small>}</div>;
}

function TerminalView({ state, dispatch }: { state: AtmState; dispatch: Dispatch<AtmAction> }) {
  const [pinEntry, setPinEntry] = useState('');
  useEffect(() => {
    if (state.screen !== 'pin') setPinEntry('');
  }, [state.screen]);
  const enterPin = (digit: string) => {
    if (pinEntry.length >= 4) return;
    setPinEntry(previous => previous + digit);
    dispatch({ type: 'PIN_DIGIT', digit });
  };
  const submitPin = () => {
    dispatch({ type: 'PIN_SUBMIT' });
    setPinEntry('');
  };
  const cancel = () => { setPinEntry(''); dispatch({ type: 'CANCEL_SESSION' }); };
  return <>
    <ScreenHeading number="01" eyebrow="CUSTOMER ENVIRONMENT" title="ATM terminal" description={state.mode === "baseline" ? "SOFTWARE-ONLY UNPROTECTED BASELINE. Never controls connected hardware." : "Protected software simulation. Hardware-in-the-loop remains separate until the board bridge is qualified."} action={<button className="quiet-button" onClick={cancel}><RotateCcw size={14} /> End session</button>} />
    <div className="terminal-layout">
      <section className="terminal-hardware">
        <div className="hardware-label"><span>ATM UNIT / ATM-001</span><span>MODEL PROFILE 01</span></div>
        <div className="terminal-bezel">
          <div className="terminal-brand"><div className="terminal-brand-symbol"><ShieldCheck size={19} /></div><div><strong>NORTHSTAR</strong><small>DEMO BANKING SYSTEM</small></div><span className="terminal-indicator"><i /> ONLINE</span></div>
          <div className="terminal-screen">
            {state.screen === 'welcome' && <div className="customer-screen welcome-screen"><div className="screen-kicker">AUTOMATED TELLER TERMINAL</div><div className="welcome-symbol"><Landmark size={32} /></div><h2>Welcome</h2><p>Insert your demo card to begin a simulated session.</p><div className="account-preview"><span>DEMO ACCOUNT</span><strong>{state.accountId}</strong><small>Fictional account · no bank connected</small></div><button className="primary-action" onClick={() => dispatch({ type: 'INSERT_CARD' })}><WalletCards size={16} /> Insert virtual card <ArrowRight size={15} /></button></div>}
            {state.screen === 'pin' && <div className="customer-screen pin-screen"><div className="screen-kicker">CUSTOMER VERIFICATION</div><h2>Enter your PIN</h2><p>Use the keypad. Input is masked and never logged.</p><div className="pin-dots" aria-label={pinEntry.length + ' of 4 digits entered'}>{[0,1,2,3].map(i => <span key={i} className={i < pinEntry.length ? 'filled' : ''} />)}</div><div className="keypad">{['1','2','3','4','5','6','7','8','9','CLEAR','0','ENTER'].map(key => <button key={key} className={'key ' + (key === 'ENTER' ? 'enter-key' : key === 'CLEAR' ? 'clear-key' : '')} onClick={() => { if (key === 'ENTER') submitPin(); else if (key === 'CLEAR') { setPinEntry(''); dispatch({ type: 'PIN_CLEAR' }); } else enterPin(key); }}>{key}</button>)}</div><button className="screen-link" onClick={cancel}>Cancel and return card</button></div>}
            {state.screen === 'menu' && <div className="customer-screen menu-screen"><div className="screen-kicker">SESSION AUTHENTICATED · {state.accountId}</div><h2>Choose a service</h2><p>All operations run against fictional local state.</p><div className="service-list">{serviceList.map(service => { const Icon = service.icon; return <button className="service-button" key={service.id} onClick={() => dispatch({ type: 'SELECT_SERVICE', service: service.id })}><span className="service-icon"><Icon size={17} /></span><span><strong>{service.label}</strong><small>{service.subtitle}</small></span><ChevronRight size={15} /></button>; })}</div><button className="screen-link" onClick={cancel}>Cancel session</button></div>}
            {state.screen === 'amount' && <div className="customer-screen amount-screen"><div className="screen-kicker">{state.service === 'transfer' ? 'LOCAL TRANSFER DEMONSTRATION' : 'CASH WITHDRAWAL'}</div><h2>{state.service === 'transfer' ? 'Transfer amount' : 'Select an amount'}</h2><p>{state.service === 'transfer' ? 'Fictional beneficiary DEMO-2042; no network is used.' : 'Amount is checked against account and cassette state.'}</p><div className="amount-grid">{[500,1000,2000,5000].map(amount => <button key={amount} onClick={() => dispatch({ type: 'SELECT_AMOUNT', amount })} className={state.selectedAmount === amount ? 'amount-pick selected' : 'amount-pick'}>{money(amount)}</button>)}</div><div className="amount-selected"><span>SELECTED AMOUNT</span><strong>{money(state.selectedAmount)}</strong></div><button className="primary-action" onClick={() => dispatch({ type: 'CONFIRM_AMOUNT' })}>{state.service === 'transfer' ? 'Confirm local transfer' : 'Create withdrawal request'} <ArrowRight size={15} /></button><button className="screen-link" onClick={() => dispatch({ type: 'RETURN_TO_MENU' })}>Back to services</button></div>}
            {state.screen === 'pending' && <div className="customer-screen amount-screen"><div className="screen-kicker">VIRTUAL DISPENSER / AUTHORITY CHECK</div><h2>Withdrawal pending</h2><p>No account or cassette values change until the final gate succeeds.</p><div className="amount-selected"><span>TRANSACTION</span><strong>{state.pendingWithdrawal?.id ?? 'UNKNOWN'}</strong></div><div className="amount-selected"><span>REQUESTED AMOUNT</span><strong>{money(state.pendingWithdrawal?.amount ?? 0)}</strong></div><div className="amount-selected"><span>AUTHORITY</span><strong>{state.lastDecision}</strong></div>{!state.simulationPermit && state.mode === 'protected' && state.sentinelStatus !== 'AUTHORITY REVOKED' && <button className="primary-action" onClick={() => dispatch({ type: 'AUTHORIZE_PENDING_WITHDRAWAL' })}>Evaluate Sentinel policy <ShieldCheck size={15} /></button>}{state.mode === 'baseline' && !state.simulationPermit && <p className="muted-note">Baseline mode deliberately omits the independent guardian; this software-only comparison must never control hardware.</p>}{(state.mode === 'baseline' || state.simulationPermit) && <button className="primary-action" onClick={() => dispatch({ type: 'COMMIT_PENDING_WITHDRAWAL' })}>{state.mode === 'baseline' ? 'Run unprotected baseline dispense' : 'Pass final virtual-dispenser gate'} <ArrowRight size={15} /></button>}{state.simulationPermit && <p className="muted-note">SIMULATED permit expires at {new Date(state.simulationPermit.expiresAtMs).toLocaleTimeString('en-IN')} and applies only to this transaction.</p>}<button className="screen-link" onClick={() => dispatch({ type: 'CANCEL_PENDING_WITHDRAWAL' })}>Cancel pending withdrawal</button></div>}
            {state.screen === 'statement' && <div className="customer-screen statement-screen"><div className="screen-kicker">ACCOUNT ACTIVITY</div><h2>Mini statement</h2><p>Recent synthetic transactions</p>{state.transactions.length === 0 ? <div className="no-transactions">No transactions in this demo session.</div> : <div className="statement-lines">{[...state.transactions].reverse().slice(0,5).map(txn => <div key={txn.id}><span>{txn.type.toUpperCase()}<small>{txn.reference}</small></span><strong>{txn.amount ? money(txn.amount) : 'INQUIRY'}</strong></div>)}</div>}<button className="primary-action" onClick={() => dispatch({ type: 'RETURN_TO_MENU' })}>Return to menu <ArrowRight size={15} /></button></div>}
            {state.screen === 'receipt' && <div className="customer-screen receipt-screen"><div className="receipt-mark"><CheckCircle2 size={24} /></div><div className="screen-kicker">TERMINAL RESPONSE</div><h2>Transaction result</h2><pre>{state.receiptMessage || 'Request completed.'}</pre>{state.service === 'balance' && <div className="balance-readout"><span>AVAILABLE BALANCE</span><strong>{money(state.accountBalance)}</strong></div>}<button className="primary-action" onClick={() => dispatch({ type: 'RETURN_TO_MENU' })}>Return to menu <ArrowRight size={15} /></button><button className="screen-link" onClick={cancel}>End session</button></div>}
            {state.screen === 'locked' && <div className="customer-screen incident-screen"><div className="incident-icon"><LockKeyhole size={27} /></div><div className="screen-kicker danger-text">SESSION LOCKED</div><h2>Verification failed</h2><p>The test account reached its configured retry limit.</p><button className="primary-action" onClick={cancel}>Return card <ArrowRight size={15} /></button></div>}
            {state.screen === 'lockdown' && <div className="customer-screen incident-screen"><div className="incident-icon"><ShieldAlert size={28} /></div><div className="screen-kicker danger-text">SENTINEL LOCKDOWN</div><h2>Dispensing blocked</h2><p>The independent authority gate revoked controller permission. No further protected withdrawal can be completed until the experiment is reset.</p><div className="lockdown-stamp">AUTHORITY REVOKED</div><button className="screen-link" onClick={() => window.dispatchEvent(new CustomEvent('sentinel:navigate', { detail: 'experiments' }))}>Open experiment controls</button></div>}
          </div>
          <div className="terminal-bottom"><span><i /> VIRTUAL CARD READER</span><span>NO PHYSICAL CASH</span></div>
        </div>
        <p className="terminal-caption"><LockKeyhole size={13} /> Demo PIN: <strong>1234</strong> · Synthetic account only · PIN content is not retained in the journal.</p>
      </section>
      <aside className="terminal-side">
        <section className="data-panel"><PanelTitle icon={<WalletCards size={16} />} title="ACCOUNT LEDGER" suffix="SIM" /><div className="ledger-balance"><span>AVAILABLE BALANCE</span><strong>{money(state.accountBalance)}</strong><small>Account {state.accountId}</small></div><div className="ledger-row"><span>Virtual cash dispensed</span><strong>{money(state.dispensedTotal)}</strong></div><div className="ledger-row"><span>Cassette inventory</span><strong>{money(state.cassetteCash)}</strong></div></section>
        <section className="data-panel"><PanelTitle icon={<ShieldCheck size={16} />} title="SECURITY AUTHORITY" /><div className="authority-row"><span>Primary controller</span><b className={state.controllerState === 'COMPROMISED' ? 'red-text' : 'green-text'}>{state.controllerState}</b></div><div className="authority-row"><span>SENTINEL</span><b className={state.sentinelStatus === 'AUTHORITY REVOKED' ? 'red-text' : 'green-text'}>{state.sentinelStatus}</b></div><div className="authority-row"><span>Last decision</span><b>{state.lastDecision}</b></div>{state.sentinelStatus === 'AUTHORITY REVOKED' && <div className="inline-warning"><ShieldAlert size={14} /> Protected gate is closed.</div>}</section>
        <section className="note-panel"><div><strong>Operator note</strong><p>Compare the same controller-failure fixture with and without Sentinel enforcement.</p><button onClick={() => setViewThroughEvent('experiments')}>Open experiment lab <ArrowRight size={13} /></button></div></section>
      </aside>
    </div>
  </>;
}
function setViewThroughEvent(view: View) {
  window.dispatchEvent(new CustomEvent('sentinel:navigate', { detail: view }));
}

function MachineView({ state, boards }: { state: AtmState; boards: Record<DeviceKey, BoardState> }) {
  const modules = [
    ['01','ATM host computer','UPPER CABINET','SIMULATED','Customer session, transaction orchestration and synthetic account host.'],
    ['02','Card reader','CUSTOMER INTERFACE','SIMULATED','Virtual card insertion/ejection and session lifecycle.'],
    ['03','PIN / EPP model','SECURE INPUT MODEL','SIMULATED','Masked test PIN input; not a certified encrypting PIN pad.'],
    ['04','UNO controller','PRIMARY CONTROL',boards.uno.connected ? 'USB CONNECTED' : 'BOARD OPTIONAL','Represents the primary ATM control microcontroller. USB console output is not attestation.'],
    ['05','ESP32 SENTINEL','INDEPENDENT GUARDIAN',boards.sentinel.connected ? 'USB CONNECTED' : 'BOARD OPTIONAL','Independent authority model. The versioned board protocol is a later integration phase.'],
    ['06','Cassette bank + dispenser','LOWER SAFE / VAULT','VIRTUAL INVENTORY','Cassette accounting and final dispense decision are enforced in the domain core.'],
    ['07','Cabinet/tamper monitor','ENVIRONMENTAL SECURITY','SIMULATED SENSORS','Door, light, temperature, voltage/clock and vibration signals are modeled only.'],
    ['08','Alarm + backup power','RESPONSE MODEL','SIMULATED','Alarm and zeroization responses are educational state transitions only.']
  ];
  return <>
    <ScreenHeading number="02" eyebrow="MACHINE ARCHITECTURE" title="Inside the ATM model" description="The modeled machine is stateful. Every subsystem identifies whether its state is simulated or reported by hardware." />
    <div className="machine-banner"><Monitor size={22} /><div><strong>ATM-001 / EDUCATIONAL MACHINE PROFILE</strong><p>Host and peripherals are emulated in software. Only the UNO and ESP32 can be physically connected in the current kit.</p></div><span className="provenance-chip">MODEL VIEW</span></div>
    <div className="module-grid">{modules.map(([number,name,layer,status,detail]) => <article className="module-card" key={number}><div className="module-top"><span>{number} / {layer}</span><small>{status}</small></div><h3>{name}</h3><p>{detail}</p><div className="module-foot"><i /> STATE SOURCE: {status.includes('USB') ? 'BOARD-REPORTED' : 'SIMULATED'}</div></article>)}</div>
    <div className="machine-bottom-grid"><section className="data-panel"><PanelTitle icon={<Banknote size={16} />} title="VIRTUAL CASSETTE BANK" /><div className="cassette-bars">{[['Cassette A · ₹500',.25],['Cassette B · ₹1,000',.35],['Cassette C · ₹2,000',.4]].map(([label,fraction]) => <div className="cassette-row" key={String(label)}><span>{label}</span><div><i style={{ width: Number(fraction)*100 + '%' }} /></div><strong>{money(state.cassetteCash * Number(fraction))}</strong></div>)}</div><p className="muted-note">Illustrative cassette split. Total simulated cash inventory: {money(state.cassetteCash)}.</p></section><section className="data-panel"><PanelTitle icon={<Activity size={16} />} title="AUTHORITY PATH" /><div className="control-path"><span>ATM host</span><ArrowRight size={14} /><span>UNO</span><ArrowRight size={14} /><span>ESP32</span><ArrowRight size={14} /><b>VIRTUAL GATE</b></div><p className="muted-note">The controller requests; the policy decides; the domain-owned gate enforces.</p></section></div>
  </>;
}

function SentinelView({ state, boards }: { state: AtmState; boards: Record<DeviceKey, BoardState> }) {
  const tests = [
    ['Reported controller profile','profile','Self-reported identity mismatch is a weak signal, not firmware attestation.'],
    ['Privileged path / service window','Privileged','Service activity outside the configured maintenance window.'],
    ['Control sequence / transition','sequence','Observed sequence and controller transition are compared with the model.'],
    ['Heartbeat / frame freshness','heartbeat','Locally tracked freshness and heartbeat limits detect stale or missing traffic.']
  ];
  return <>
    <ScreenHeading number="03" eyebrow="INDEPENDENT SECURITY LAYER" title="SENTINEL console" description="Inspect the rule engine's evidence, decision and actual virtual gate state." action={<span className={'decision-pill ' + (state.lastDecision === 'REVOKE' ? 'danger' : 'safe')}>{state.lastDecision === 'REVOKE' ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}{state.lastDecision}</span>} />
    <div className="sentinel-summary"><div className="sentinel-emblem"><ShieldCheck size={31} /></div><div className="sentinel-status-copy"><span>AUTHORITY STATE</span><strong className={state.sentinelStatus === 'AUTHORITY REVOKED' ? 'red-text' : 'green-text'}>{state.sentinelStatus}</strong><p>{state.sentinelStatus === 'AUTHORITY REVOKED' ? 'Protected requests are denied until the experiment is reset.' : 'Monitoring is active in the software model. An open serial port is not proof of trust.'}</p></div><div className="sentinel-mode"><span>RUN MODE</span><strong>{state.mode.toUpperCase()}</strong><small>{state.mode === 'protected' ? 'Authority enforced in the virtual gate' : 'Unprotected virtual comparison'}</small></div></div>
    <div className="section-heading"><h2>Evidence rules</h2><span>DETERMINISTIC POLICY / V1</span></div>
    <div className="rule-list">{tests.map(([title,term,description],index) => { const tripped = state.findings.some(finding => finding.toLowerCase().includes(term.toLowerCase())); return <div className="rule-row" key={title}><div className="rule-index">{String(index+1).padStart(2,'0')}</div><div className="rule-copy"><strong>{title}</strong><p>{description}</p></div><span className={'rule-status ' + (tripped ? 'tripped' : '')}>{tripped ? 'TRIPPED' : 'NO FINDING'}</span></div>; })}</div>
    <div className="sentinel-limit"><CircleAlert size={17} /><div><strong>Integrity limitations</strong><p>The first attack case injects simulated evidence. USB console text is observational only; CRC detects transmission errors, not sender authenticity. Physical tamper inputs and hardware-backed attestation are not implemented.</p></div></div>
    <div className="two-column"><section className="data-panel"><PanelTitle icon={<Cpu size={16} />} title="PRIMARY CONTROLLER" /><div className="authority-row"><span>UNO board</span><b className={boards.uno.connected ? 'green-text' : ''}>{boards.uno.connected ? 'USB OPEN' : 'NOT CONNECTED'}</b></div><div className="authority-row"><span>Model state</span><b className={state.controllerState === 'COMPROMISED' ? 'red-text' : ''}>{state.controllerState}</b></div><div className="authority-row"><span>Reported telemetry</span><b>UNTRUSTED BY DEFAULT</b></div></section><section className="data-panel"><PanelTitle icon={<ShieldCheck size={16} />} title="GUARDIAN" /><div className="authority-row"><span>ESP32 board</span><b className={boards.sentinel.connected ? 'green-text' : ''}>{boards.sentinel.connected ? 'USB OPEN' : 'NOT CONNECTED'}</b></div><div className="authority-row"><span>Virtual gate</span><b className={state.sentinelStatus === 'AUTHORITY REVOKED' ? 'red-text' : 'green-text'}>{state.sentinelStatus === 'AUTHORITY REVOKED' ? 'DENY' : 'READY'}</b></div><div className="authority-row"><span>Rule findings</span><b>{state.findings.length}</b></div></section></div>
  </>;
}

function ExperimentView({ state, dispatch }: { state: AtmState; dispatch: Dispatch<AtmAction> }) {
  const blocked = state.mode === 'protected' && state.lastDecision === 'REVOKE';
  const baselineReleased = state.mode === 'baseline' && state.scenarioApplied;
  return <>
    <ScreenHeading number="04" eyebrow="CONTROLLED SECURITY EXPERIMENT" title="Baseline vs protected" description="The fixture supplies inputs; the rule engine evaluates them; the virtual dispenser gate determines the outcome." action={<button className="quiet-button" onClick={() => dispatch({ type: 'RESET_SCENARIO' })}><RotateCcw size={14} /> Reset run</button>} />
    <div className="experiment-mode-switch"><button className={'experiment-mode baseline ' + (state.mode === 'baseline' ? 'selected' : '')} onClick={() => dispatch({ type: 'SET_MODE', mode: 'baseline' })}><LockKeyhole size={18} /><span><strong>Unprotected baseline</strong><small>Independent gate intentionally bypassed in this virtual comparison.</small></span></button><button className={'experiment-mode protected ' + (state.mode === 'protected' ? 'selected' : '')} onClick={() => dispatch({ type: 'SET_MODE', mode: 'protected' })}><ShieldCheck size={18} /><span><strong>SENTINEL active</strong><small>Policy findings revoke authority and the virtual gate enforces denial.</small></span></button></div>
    <section className="scenario-card"><div className="scenario-meta"><span>FIXTURE S-001</span><span className="simulated-label">SIMULATED EVIDENCE</span></div><div className="scenario-main"><div className="scenario-symbol"><Fingerprint size={29} /></div><div className="scenario-copy"><h2>Controller compromise / unauthorized dispense</h2><p>The fixture introduces a reported-profile mismatch, out-of-window privileged path, sequence divergence, stale heartbeat/frame and illegal transition. No real malware is involved.</p><div className="scenario-tags"><span>CONTROLLER INTEGRITY</span><span>DISPENSER AUTHORITY</span><span>REPEATABLE</span></div></div></div><div className="scenario-evidence">{['Reported profile mismatch','Privileged path outside maintenance','Control sequence divergence','Stale heartbeat and frame','Illegal controller transition'].map((item,index)=><div key={item}><span>{String(index+1).padStart(2,'0')}</span>{item}<b>TEST INPUT</b></div>)}</div><button className="run-scenario" onClick={() => dispatch({ type: 'RUN_COMPROMISE_SCENARIO' })} disabled={state.scenarioApplied}><Fingerprint size={17} /><span><strong>{state.scenarioApplied ? 'Scenario already applied' : 'Run controlled compromise scenario'}</strong><small>{state.scenarioApplied ? 'Reset the experiment to replay the same fixture.' : 'The button injects evidence; it does not choose the verdict.'}</small></span><ArrowRight size={17} /></button></section>
    <div className="results-grid"><section className="result-panel"><div className="result-head"><span>VIRTUAL DISPENSER RESULT</span><b className={blocked || baselineReleased ? 'red-text' : 'green-text'}>{blocked ? 'BLOCKED' : baselineReleased ? 'UNAUTHORIZED DISPENSE' : 'READY'}</b></div><strong className="result-number">{money(state.dispensedTotal)}</strong><small>Virtual cash released in this run</small><div className="result-foot"><span>Cassette cash remaining</span><b>{money(state.cassetteCash)}</b></div></section><section className="result-panel"><div className="result-head"><span>SENTINEL DECISION</span><b>{state.lastDecision}</b></div><strong className="result-number">{state.findings.length}</strong><small>Findings in active run</small><div className="result-foot"><span>Controller state</span><b className={state.controllerState === 'COMPROMISED' ? 'red-text' : ''}>{state.controllerState}</b></div></section></div>
    <div className="scientific-note"><CircleAlert size={16} /><p>This fixture validates only the configured model. It cannot prove detection of arbitrary real firmware compromise, and the virtual gate is not a physical cash-dispenser interlock.</p></div>
    {state.findings.length > 0 && <section className="finding-panel"><h3>Policy findings</h3>{state.findings.map((finding,index)=><p key={finding}><span>{String(index+1).padStart(2,'0')}</span>{finding}</p>)}</section>}
  </>;
}

function JournalView({ events, alerts, onExport }: { events: JournalEvent[]; alerts: number; onExport: (format: 'json' | 'csv') => void }) {
  return <>
    <ScreenHeading number="05" eyebrow="TRACEABLE RUN HISTORY" title="Event journal" description="Controller observations, policy findings and actual virtual-gate outcomes." action={<div className="journal-export-actions"><button className="quiet-button" onClick={() => onExport('json')}><FileText size={13} /> Export JSON</button><button className="quiet-button" onClick={() => onExport('csv')}><Activity size={13} /> Export CSV</button></div>} />
    <div className="journal-stats"><div><span>RECORDED EVENTS</span><strong>{events.length.toString().padStart(3,'0')}</strong></div><div><span>ALERT / WARNING EVENTS</span><strong>{alerts.toString().padStart(3,'0')}</strong></div><div><span>DATA PROVENANCE</span><strong>SIMULATION</strong></div></div>
    <div className="journal-list">{events.length === 0 ? <div className="empty-state">No events in this run.</div> : events.map(event => <JournalRow key={event.id} event={event} />)}</div>
  </>;
}
function JournalRow({ event }: { event: JournalEvent }) {
  const icon = event.severity === 'critical' ? <XOctagon size={15} /> : event.severity === 'warning' ? <CircleAlert size={15} /> : event.severity === 'success' ? <CheckCircle2 size={15} /> : <Terminal size={15} />;
  return <article className={'journal-row severity-' + event.severity}><div className="journal-icon">{icon}</div><time>{event.at}</time><div className="journal-copy"><strong>{event.title}</strong><p>{event.detail}</p><small>{event.source} · {event.id}</small></div><span className="severity-tag">{event.severity.toUpperCase()}</span></article>;
}

function HILOperatorControls({ pairReady, unoConnected, sendCommand, hilTransaction }: {
  pairReady: boolean;
  unoConnected: boolean;
  sendCommand: (device: DeviceKey, command: string) => Promise<{ ok: boolean; error?: string; commandName?: string; sensitive?: boolean }>;
  hilTransaction: HilTransaction | null;
}) {
  const customerOpsAllowed = pairReady && canBeginHilWithdrawal(hilTransaction);
  const canConfigure = unoConnected && canBeginHilWithdrawal(hilTransaction);
  const [cardId, setCardId] = useState('CARD01');
  const [demoPin, setDemoPin] = useState('');
  const [startingBalance, setStartingBalance] = useState('50000');
  const [cash500, setCash500] = useState('20');
  const [cash200, setCash200] = useState('20');
  const [cash100, setCash100] = useState('20');
  const [cash50, setCash50] = useState('20');
  const [withdrawAmount, setWithdrawAmount] = useState('500');
  const [customerPin, setCustomerPin] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (device: DeviceKey, command: string) => {
    setBusy(true);
    try {
      const result = await sendCommand(device, command);
      setFeedback(result.ok ? (result.commandName || 'Command') + ' written; verify the board-reported response below.' : result.error || 'Command failed.');
      return result.ok;
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const provision = async () => {
    if (!/^[A-Z0-9_-]{1,16}$/.test(cardId) || !/^[0-9]{4,6}$/.test(demoPin) ||
        !/^(0|[1-9][0-9]*)$/.test(startingBalance) || Number(startingBalance) > 1000000) {
      setFeedback('Use an uppercase card ID, a fictional 4–6 digit PIN and a balance from 0 to 1,000,000.');
      setDemoPin('');
      return;
    }
    const pin = demoPin;
    setDemoPin('');
    const ok = await send('uno', 'ADD_ACCOUNT ' + cardId + ' ' + pin + ' ' + startingBalance);
    if (ok) setFeedback('Account provisioning command written. Confirm ATM_EVENT|ACCOUNT_PROVISIONED before proceeding.');
  };
  const configureCash = async () => {
    const values = [cash500, cash200, cash100, cash50];
    if (values.some(value => !/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > 9999)) {
      setFeedback('Each fictional note count must be an integer from 0 to 9999.');
      return;
    }
    await send('uno', 'SET_CASH ' + values.join(' '));
  };
  const useCard = async () => {
    if (!customerOpsAllowed) { setFeedback('Blocked: the pair is not fresh/ready or a previous HIL withdrawal is still unresolved.'); return; }
    await send('uno', 'CARD ' + cardId);
  };
  const submitPin = async () => {
    if (!/^[0-9]{4,6}$/.test(customerPin)) { setFeedback('Enter the fictional demo PIN used when provisioning.'); setCustomerPin(''); return; }
    const pin = customerPin;
    setCustomerPin('');
    if (!customerOpsAllowed) { setFeedback('Blocked: the pair is not fresh/ready or a previous HIL withdrawal is still unresolved.'); return; }
    await send('uno', 'PIN ' + pin);
  };
  const withdraw = async () => {
    if (!/^[1-9][0-9]*$/.test(withdrawAmount) || Number(withdrawAmount) > 1000000 || Number(withdrawAmount) % 50 !== 0) {
      setFeedback('Withdrawal must be a positive amount, no more than 1,000,000, and a multiple of ₹50.');
      return;
    }
    if (!customerOpsAllowed) { setFeedback('Blocked: the pair is not fresh/ready or a previous HIL withdrawal is still unresolved.'); return; }
    await send('uno', 'WITHDRAW ' + withdrawAmount);
  };
  return <>
    <div className="hil-setup-grid">
      <div><label className="field-label" htmlFor="hil-card">DEMO CARD ID</label><input id="hil-card" value={cardId} onChange={event => setCardId(event.target.value.toUpperCase())} maxLength={16} autoComplete="off" disabled={busy} /></div>
      <div><label className="field-label" htmlFor="hil-pin">NEW FICTIONAL PIN</label><input id="hil-pin" type="password" inputMode="numeric" value={demoPin} onChange={event => setDemoPin(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} autoComplete="new-password" disabled={busy} /></div>
      <div><label className="field-label" htmlFor="hil-balance">STARTING BALANCE (₹)</label><input id="hil-balance" inputMode="numeric" value={startingBalance} onChange={event => setStartingBalance(event.target.value)} disabled={busy} /></div>
    </div>
    <div className="hil-action-row"><button className="board-button" onClick={() => void provision()} disabled={!canConfigure || busy}>Provision fictional account</button></div>
    <div className="hil-setup-grid cash-counts">
      <div><label className="field-label" htmlFor="hil-c500">₹500 NOTES</label><input id="hil-c500" inputMode="numeric" value={cash500} onChange={event => setCash500(event.target.value)} disabled={busy} /></div>
      <div><label className="field-label" htmlFor="hil-c200">₹200 NOTES</label><input id="hil-c200" inputMode="numeric" value={cash200} onChange={event => setCash200(event.target.value)} disabled={busy} /></div>
      <div><label className="field-label" htmlFor="hil-c100">₹100 NOTES</label><input id="hil-c100" inputMode="numeric" value={cash100} onChange={event => setCash100(event.target.value)} disabled={busy} /></div>
      <div><label className="field-label" htmlFor="hil-c50">₹50 NOTES</label><input id="hil-c50" inputMode="numeric" value={cash50} onChange={event => setCash50(event.target.value)} disabled={busy} /></div>
    </div>
    <div className="hil-action-row"><button className="board-button" onClick={() => void configureCash()} disabled={!canConfigure || busy}>Configure virtual cassette</button></div>
    <div className="divider-line" />
    <div className="hil-setup-grid customer-ops">
      <div><label className="field-label" htmlFor="hil-customer-pin">CUSTOMER DEMO PIN</label><input id="hil-customer-pin" type="password" inputMode="numeric" value={customerPin} onChange={event => setCustomerPin(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} autoComplete="off" disabled={busy || !pairReady} /></div>
      <div><label className="field-label" htmlFor="hil-withdraw-amount">WITHDRAWAL AMOUNT (₹)</label><input id="hil-withdraw-amount" inputMode="numeric" value={withdrawAmount} onChange={event => setWithdrawAmount(event.target.value)} disabled={busy || !pairReady} /></div>
    </div>
    <div className="hil-action-row">
      <button className="board-button" onClick={() => void useCard()} disabled={!customerOpsAllowed || busy}>Insert demo card</button>
      <button className="board-button" onClick={() => void submitPin()} disabled={!customerOpsAllowed || busy || !customerPin}>Verify PIN</button>
      <button className="board-button" onClick={() => void send('uno', 'BALANCE')} disabled={!customerOpsAllowed || busy}>Check balance</button>
      <button className="board-button" onClick={() => void withdraw()} disabled={!customerOpsAllowed || busy}>Request withdrawal</button>
      <button className="board-button danger-command" onClick={() => void send('uno', 'FIXTURE_MISMATCH')} disabled={!customerOpsAllowed || busy}>Inject synthetic mismatch</button>
    </div>
    {feedback && <div className="hardware-notice"><CircleAlert size={16} /><p>{feedback}</p></div>}
    <p className="muted-note">All values are fictional and RAM-only on the boards. Provisioning does not mean the board accepted it until a corresponding ATM_EVENT appears. PIN fields are cleared after use and are not copied into the serial event journal.</p>
  </>;
}

function HardwareView({ ports, chosenPort, setChosenPort, boards, message, serialEvents, refresh, connect, disconnect, sendCommand, hilTransaction, boardBootEpochs, hilFaultResetBaseline, nowMs, clearHilTransaction }: {
  ports: Port[]; chosenPort: Record<DeviceKey, string>;
  setChosenPort: Dispatch<SetStateAction<Record<DeviceKey, string>>>;
  boards: Record<DeviceKey, BoardState>; message: string; serialEvents: string[];
  refresh: () => void; connect: (device: DeviceKey) => void; disconnect: (device: DeviceKey) => void;
  sendCommand: (device: DeviceKey, command: string) => Promise<{ ok: boolean; error?: string; commandName?: string; sensitive?: boolean }>;
  hilTransaction: HilTransaction | null;
  boardBootEpochs: HilBoardResetEpochs;
  hilFaultResetBaseline: HilBoardResetEpochs | null;
  nowMs: number;
  clearHilTransaction: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<DeviceKey, string>>({ uno: 'STATUS', sentinel: 'STATUS' });
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandFeedback, setCommandFeedback] = useState('');
  const isFresh = (device: DeviceKey) => boards[device].connected && boards[device].readinessAt > 0 &&
    nowMs - boards[device].readinessAt <= 3500;
  const phaseForDisplay = (device: DeviceKey): BoardPhase => {
    const board = boards[device];
    if (board.connected && ['HEALTHY', 'OBSERVING'].includes(board.phase) && !isFresh(device)) return 'STALE';
    return board.phase;
  };
  const pairReady = isFresh('uno') && isFresh('sentinel') &&
    boards.uno.phase === 'HEALTHY' && boards.sentinel.phase === 'OBSERVING';
  const canClearHilRecord = Boolean(hilTransaction && (
    hilTransaction.phase === 'RECONCILED' || hilTransaction.phase === 'DENIED' ||
    canClearHilFaultAfterPairedReset(hilTransaction.phase, pairReady, hilFaultResetBaseline, boardBootEpochs)
  ));
  const runCommand = async (device: DeviceKey) => {
    const command = drafts[device];
    if (!boards[device].connected) {
      setCommandFeedback('Connect the selected board before sending an operator command.');
      return;
    }
    const commandName = command.split(' ')[0];
    const requiresPair = ['CARD', 'PIN', 'BALANCE', 'WITHDRAW', 'CHANGE_PIN', 'FIXTURE_MISMATCH'].includes(commandName);
    if (requiresPair && !pairReady) {
      setCommandFeedback('Blocked by the desktop safety gate: both USB consoles must be open, the Uno must report accepted HEALTHY status, and the ESP32 must report OBSERVING.');
      return;
    }
    setCommandBusy(true);
    try {
      const response = await sendCommand(device, command);
      setCommandFeedback(response.ok
        ? (response.commandName || 'Command') + ' was written locally. Check the board response before assuming acceptance.'
        : response.error || 'Command failed.');
      if (['PIN', 'ADD_ACCOUNT', 'CHANGE_PIN'].includes(commandName) || response.ok) {
        setDrafts(previous => ({ ...previous, [device]: '' }));
      }
    } catch (error) {
      setCommandFeedback(error instanceof Error ? error.message : String(error));
      if (['PIN', 'ADD_ACCOUNT', 'CHANGE_PIN'].includes(commandName)) {
        setDrafts(previous => ({ ...previous, [device]: '' }));
      }
    } finally {
      setCommandBusy(false);
    }
  };
  return <>
    <ScreenHeading number="06" eyebrow="HARDWARE-IN-THE-LOOP" title="Board bench" description="Connect and control the existing Arduino Uno and ESP32 through an allowlisted local command bridge. The customer terminal remains a separate software simulation until a correlated HIL transaction path is qualified." action={<button className="quiet-button" onClick={refresh}><RotateCcw size={14} /> Scan ports</button>} />
    <div className="hardware-notice"><CircleAlert size={16} /><p>{message}<br /><strong>Close Arduino IDE Serial Monitor before connecting the same port.</strong> Each USB port must have one owner. Local write success is not board acceptance.</p></div>
    <section className="data-panel">
      <PanelTitle icon={<ShieldCheck size={16} />} title="PROTECTED HIL READINESS" suffix="BOARD-REPORTED CONSOLE EVIDENCE" />
      <div className="authority-row"><span>Uno peer status</span><b className={phaseForDisplay('uno') === 'HEALTHY' ? 'green-text' : phaseForDisplay('uno') === 'REVOKED' || phaseForDisplay('uno') === 'ERROR' || phaseForDisplay('uno') === 'STALE' ? 'red-text' : ''}>{phaseForDisplay('uno')}</b></div>
      <div className="authority-row"><span>ESP32 guardian state</span><b className={phaseForDisplay('sentinel') === 'OBSERVING' ? 'green-text' : phaseForDisplay('sentinel') === 'REVOKED' || phaseForDisplay('sentinel') === 'ERROR' || phaseForDisplay('sentinel') === 'STALE' ? 'red-text' : ''}>{phaseForDisplay('sentinel')}</b></div>
      <div className="authority-row"><span>Protected HIL</span><b className={pairReady ? 'green-text' : 'red-text'}>{pairReady ? 'OBSERVED READY' : 'NOT READY — DENY'}</b></div>
      <p className="muted-note">Readiness is inferred from specific serial-console lines and is still board-reported, not cryptographic attestation. The application fails closed when these lines are missing.</p>
    </section>
    <div className="board-grid">{(['uno','sentinel'] as DeviceKey[]).map((device,index) => {
      const board = boards[device];
      return <section className="board-card" key={device}>
        <div className="board-top"><div className={'board-symbol ' + device}>{device === 'uno' ? <Cpu size={22} /> : <ShieldCheck size={22} />}</div><div><small>DEVICE 0{index+1}</small><h2>{device === 'uno' ? 'Arduino Uno' : 'SENTINEL ESP32'}</h2><p>{device === 'uno' ? 'Primary ATM control microcontroller' : 'Independent guardian controller'}</p></div><span className={'board-status ' + (board.connected ? 'connected' : '')}><i />{board.connected ? 'CONNECTED' : 'DISCONNECTED'}</span></div>
        <label className="field-label" htmlFor={'port-'+device}>USB SERIAL PORT</label>
        <select id={'port-'+device} value={chosenPort[device]} disabled={board.connected} onChange={event => setChosenPort(previous => ({ ...previous, [device]: event.target.value }))}><option value="">Select a port</option>{ports.map(port => <option key={port.path} value={port.path}>{port.path}{port.manufacturer ? ' · ' + port.manufacturer : ''}</option>)}</select>
        <div className="board-meta"><span>BOARD-REPORTED PHASE</span><strong>{board.phase}</strong><span>LAST SERIAL LINE</span><strong>{board.lastLine || 'Waiting for serial data'}</strong></div>
        {board.error && <p className="error-line">{board.error}</p>}
        <button className={'board-button ' + (board.connected ? 'disconnect' : '')} onClick={() => board.connected ? disconnect(device) : connect(device)} disabled={!board.connected && !chosenPort[device]}>{board.connected ? <><XOctagon size={15} /> Disconnect board</> : <><Plug size={15} /> Connect USB console</>}</button>
        <form className="board-command-form" onSubmit={event => { event.preventDefault(); void runCommand(device); }}>
          <label className="field-label" htmlFor={'command-'+device}>ALLOWLISTED OPERATOR COMMAND</label>
          <input id={'command-'+device} value={drafts[device]} onChange={event => setDrafts(previous => ({ ...previous, [device]: event.target.value }))} placeholder={device === 'uno' ? 'STATUS / ADD_ACCOUNT / CARD / PIN / WITHDRAW' : 'STATUS / SET_LIMITS / FIXTURE_REVOKE'} disabled={!board.connected || commandBusy} autoComplete="off" spellCheck={false} />
          <button className="board-button" type="submit" disabled={!board.connected || commandBusy || !drafts[device]}>{commandBusy ? 'Sending…' : 'Send command'}</button>
          <p className="muted-note">PIN-bearing commands are cleared from this input after sending. Raw command text is not copied into the host event journal or command-write diagnostic.</p>
        </form>
      </section>;
    })}</div>

    <section className="data-panel hil-operator-panel">
      <PanelTitle icon={<Cpu size={16} />} title="UNO / SENTINEL OPERATOR WORKFLOW" suffix="FICTIONAL DEMO ONLY" />
      <p className="muted-note">This panel sends allowlisted commands to the connected boards. It does not drive physical cash hardware. A local USB write is not proof the board accepted a command.</p>
      <HILOperatorControls pairReady={pairReady} unoConnected={boards.uno.connected} sendCommand={sendCommand} hilTransaction={hilTransaction} />
    </section>
    <section className="data-panel hil-transaction-panel">
      <PanelTitle icon={<Activity size={16} />} title="HIL TRANSACTION CORRELATION" suffix="BOARD-REPORTED / PROTOCOL-EVIDENCE" />
      {!hilTransaction && <div className="empty-state">No HIL withdrawal has been observed in this session. A successful board transaction must match by ID and amount, and both the Uno commit and guardian reconciliation must be observed.</div>}
      {hilTransaction && <>
        <div className="authority-row"><span>Transaction ID</span><b>{hilTransaction.id}</b></div>
        <div className="authority-row"><span>Requested amount</span><b>{money(hilTransaction.amount)}</b></div>
        <div className="authority-row"><span>Lifecycle state</span><b className={hilTransaction.phase === 'RECONCILED' ? 'green-text' : hilTransaction.phase === 'DENIED' || hilTransaction.phase === 'REVOKED' || hilTransaction.phase === 'MISMATCH' ? 'red-text' : ''}>{hilTransaction.phase}</b></div>
        {hilTransaction.balance !== undefined && <div className="authority-row"><span>Uno-reported remaining balance</span><b>{money(hilTransaction.balance)}</b></div>}
        <p className="muted-note">{hilTransaction.message}</p>
        <p className="muted-note">{hilTransaction.phase === 'RECONCILED' ? 'Both relevant board reports have been observed for this transaction. This remains board-reported evidence, not cryptographic attestation; no desktop shadow-cash mutation is performed by this initial bridge.' : 'The desktop does not mark this as a completed HIL withdrawal or change its software-simulation ledger.'}</p>
        <button className="quiet-button" onClick={clearHilTransaction} disabled={!canClearHilRecord}>Clear displayed terminal record</button>
        {(['REVOKED', 'MISMATCH'].includes(hilTransaction.phase) && !canClearHilFaultAfterPairedReset(hilTransaction.phase, pairReady, hilFaultResetBaseline, boardBootEpochs)) && <p className="muted-note">This fault stays latched in the desktop until both boards emit a new boot/session-start record and fresh paired readiness is re-established. Clearing the display alone never clears a board fault.</p>}
      </>}
    </section>
    {commandFeedback && <div className="hardware-notice"><CircleAlert size={16} /><p>{commandFeedback}</p></div>}
    <section className="data-panel serial-log"><PanelTitle icon={<Terminal size={16} />} title="USB SERIAL OBSERVATION" suffix="RAW LINES / NOT ATTESTATION" />{serialEvents.length ? serialEvents.slice(-15).reverse().map((line,index) => <p key={index}>{line}</p>) : <div className="empty-state">No serial events yet. Simulation mode remains fully available.</div>}</section>
    <div className="scientific-note"><CircleAlert size={16} /><p>This bridge can transmit only allowlisted operator commands and displays incoming console lines, but it does not yet perform full desktop transaction correlation. It intentionally blocks customer/withdrawal/fixture commands until both boards report ready.</p></div>
  </>;
}
