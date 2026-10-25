import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertOctagon, ArrowDownToLine, ArrowRight, Banknote, Cable,
  CheckCircle2, CircleAlert, Clock3, Cpu, Fingerprint, Landmark,
  LockKeyhole, LockOpen, Monitor, Plug, Radio, RotateCcw, Shield,
  ShieldAlert, ShieldCheck, Terminal, WalletCards, X
} from 'lucide-react';

type View = 'simulation' | 'hardware';
type Mode = 'baseline' | 'protected';
type EventKind = 'info' | 'success' | 'warning' | 'danger';
type DeviceKey = 'uno' | 'sentinel';
type FeedItem = { id: number; time: string; kind: EventKind; title: string; detail: string };
type Evidence = {
  approvedBuild: string;
  reportedBuild: string;
  privilegedPathRequested: boolean;
  maintenanceWindowOpen: boolean;
  observedSequence: number;
  expectedSequence: number;
};
type Assessment = { compromised: boolean; findings: string[] };
type PortInfo = { usbVendorId?: number; usbProductId?: number };
type WebSerialPort = {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): PortInfo;
  readable: ReadableStream<Uint8Array> | null;
};
type WebSerialApi = {
  requestPort(options?: Record<string, unknown>): Promise<WebSerialPort>;
  getPorts(): Promise<WebSerialPort[]>;
};
type NavigatorWithSerial = Navigator & { serial?: WebSerialApi };
type ActivePort = { port: WebSerialPort; reader: ReadableStreamDefaultReader<Uint8Array> | null };
type DeviceState = { connected: boolean; path: string; lastLine: string };

const INITIAL_BALANCE = 25000;
const TEST_WITHDRAWAL = 2000;
const currency = (amount: number) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0
}).format(amount);

function nowLabel() {
  return new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
}

function makeEvent(kind: EventKind, title: string, detail: string): FeedItem {
  return { id: Date.now() + Math.random(), time: nowLabel(), kind, title, detail };
}

/** Rule evaluator for explicit educational test signals. It does not read ATM transactions. */
function assessController(evidence: Evidence): Assessment {
  const findings: string[] = [];
  if (evidence.reportedBuild !== evidence.approvedBuild) {
    findings.push('Controller identity differs from the approved reference');
  }
  if (evidence.privilegedPathRequested && !evidence.maintenanceWindowOpen) {
    findings.push('Privileged controller path is active outside the approved maintenance window');
  }
  if (evidence.observedSequence !== evidence.expectedSequence) {
    findings.push('Observed control sequence diverges from the expected sequence');
  }
  return { compromised: findings.length > 0, findings };
}

const cleanEvidence: Evidence = {
  approvedBuild: 'ATM-CTRL-01',
  reportedBuild: 'ATM-CTRL-01',
  privilegedPathRequested: false,
  maintenanceWindowOpen: false,
  observedSequence: 42,
  expectedSequence: 42
};

const compromisedEvidence: Evidence = {
  approvedBuild: 'ATM-CTRL-01',
  reportedBuild: 'ATM-CTRL-01 / changed',
  privilegedPathRequested: true,
  maintenanceWindowOpen: false,
  observedSequence: 43,
  expectedSequence: 42
};

const emptyDevices: Record<DeviceKey, DeviceState> = {
  uno: { connected: false, path: '', lastLine: '' },
  sentinel: { connected: false, path: '', lastLine: '' }
};

function devicePath(port: WebSerialPort) {
  const info = port.getInfo();
  if (info.usbVendorId === undefined && info.usbProductId === undefined) return 'USB serial device';
  const vendor = info.usbVendorId?.toString(16).padStart(4, '0') ?? '----';
  const product = info.usbProductId?.toString(16).padStart(4, '0') ?? '----';
  return 'USB ' + vendor.toUpperCase() + ':' + product.toUpperCase();
}

function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 64 64" fill="none">
      <path d="M32 7.5 51.5 14v15.2c0 13.1-8.1 21.2-19.5 28.1C20.6 50.4 12.5 42.3 12.5 29.2V14L32 7.5Z" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M23 25.5h18M23 33h18M32 19v27" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="41" cy="33" r="3.1" fill="#D39E56" stroke="#142821" strokeWidth="1.1" />
    </svg>
  );
}

export default function App() {
  const [view, setView] = useState<View>('simulation');
  const [mode, setMode] = useState<Mode>('protected');
  const [balance, setBalance] = useState(INITIAL_BALANCE);
  const [dispensed, setDispensed] = useState(0);
  const [amount, setAmount] = useState(1000);
  const [quarantined, setQuarantined] = useState(false);
  const [evidence, setEvidence] = useState<Evidence>(cleanEvidence);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [devices, setDevices] = useState<Record<DeviceKey, DeviceState>>(emptyDevices);
  const [serialSupported, setSerialSupported] = useState(false);
  const [serialMessage, setSerialMessage] = useState('Connect each board from this browser to view its USB serial output.');
  const [feed, setFeed] = useState<FeedItem[]>([
    makeEvent('info', 'Simulation ready', 'Virtual ATM is initialized. No bank network, PIN system or physical dispenser is connected.')
  ]);
  const activePorts = useRef<Record<DeviceKey, ActivePort | null>>({ uno: null, sentinel: null });

  const addEvent = useCallback((kind: EventKind, title: string, detail: string) => {
    setFeed(previous => [...previous.slice(-59), makeEvent(kind, title, detail)]);
  }, []);

  useEffect(() => {
    const api = (navigator as NavigatorWithSerial).serial;
    setSerialSupported(Boolean(api && window.isSecureContext));
    if (!window.isSecureContext) {
      setSerialMessage('Hardware access requires a secure HTTPS page or localhost.');
    } else if (!api) {
      setSerialMessage('This browser does not expose Web Serial. Use a current desktop version of Chrome or Edge for USB serial access.');
    } else {
      setSerialMessage('Web Serial is available. Select a board and approve its browser connection.');
    }

    return () => {
      for (const device of ['uno', 'sentinel'] as DeviceKey[]) {
        const active = activePorts.current[device];
        if (active) {
          void active.reader?.cancel().catch(() => undefined);
          void active.port.close().catch(() => undefined);
          activePorts.current[device] = null;
        }
      }
    };
  }, []);

  const connectedCount = Number(devices.uno.connected) + Number(devices.sentinel.connected);
  const summary = useMemo(() => ({
    eventCount: feed.length,
    alerts: feed.filter(item => item.kind === 'warning' || item.kind === 'danger').length
  }), [feed]);

  const resetScenario = useCallback((log = true) => {
    setBalance(INITIAL_BALANCE);
    setDispensed(0);
    setQuarantined(false);
    setAssessment(null);
    setEvidence(cleanEvidence);
    setAmount(1000);
    if (log) addEvent('info', 'Scenario reset', 'The virtual account and controller signals have returned to the initial test state.');
  }, [addEvent]);

  const changeMode = (nextMode: Mode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    resetScenario(false);
    addEvent('info', nextMode === 'protected' ? 'SENTINEL protection selected' : 'Baseline comparison selected',
      nextMode === 'protected'
        ? 'The simulated guardian will evaluate controller evidence and enforce its quarantine state.'
        : 'The same test case will run without independent guardian enforcement.');
  };

  const withdraw = () => {
    if (mode === 'protected' && quarantined) {
      addEvent('danger', 'Dispense request refused', 'The simulated dispenser is enforcing SENTINEL’s revoked-controller state. The balance and dispense counter did not change.');
      return;
    }
    if (amount <= 0 || amount > balance) {
      addEvent('warning', 'Withdrawal unavailable', 'The requested amount exceeds the remaining illustrative account balance.');
      return;
    }
    setBalance(previous => previous - amount);
    setDispensed(previous => previous + amount);
    addEvent('success', 'Virtual cash dispensed', currency(amount) + ' accepted in the ATM simulation. SENTINEL does not inspect customer transactions.');
  };

  const runCompromise = () => {
    if (quarantined && mode === 'protected') return;
    setEvidence(compromisedEvidence);
    addEvent('warning', 'Test fixture introduced controller anomalies',
      'The simulated Uno now reports a changed identity, an out-of-window privileged path, and a divergent control sequence.');

    if (mode === 'baseline') {
      setAssessment(null);
      addEvent('danger', 'No independent guardian enforcement',
        'The compromised-controller test requests a virtual ' + currency(TEST_WITHDRAWAL) + ' dispense. The baseline accepts the request.');
      if (balance >= TEST_WITHDRAWAL) {
        setBalance(previous => previous - TEST_WITHDRAWAL);
        setDispensed(previous => previous + TEST_WITHDRAWAL);
        addEvent('danger', 'Baseline failure reproduced',
          currency(TEST_WITHDRAWAL) + ' was dispensed in the model despite the controller anomalies.');
      } else {
        addEvent('warning', 'Test could not dispense', 'Reset the scenario to restore enough illustrative balance for the same test case.');
      }
      return;
    }

    const result = assessController(compromisedEvidence);
    setAssessment(result);
    if (!result.compromised) {
      addEvent('success', 'Controller evidence accepted', 'No configured controller-integrity rule was violated.');
      return;
    }
    setQuarantined(true);
    addEvent('danger', 'SENTINEL revoked controller authority',
      result.findings.length + ' independent controller-integrity rule(s) were violated. The simulated dispenser is placed in a deny state.');
    addEvent('success', 'Cash dispensing contained',
      'The same ' + currency(TEST_WITHDRAWAL) + ' request was refused. The balance and virtual cash-dispensed total remain unchanged.');
  };

  const connectHardware = async (device: DeviceKey) => {
    const serial = (navigator as NavigatorWithSerial).serial;
    if (!serial || !window.isSecureContext) {
      setSerialMessage('Web Serial is unavailable in this browser or context. Open the HTTPS GitHub Pages site in desktop Chrome or Edge.');
      addEvent('warning', 'Hardware connection unavailable', 'Web Serial is not exposed by the current browser/context.');
      return;
    }
    if (activePorts.current[device]) {
      await disconnectHardware(device);
      return;
    }
    try {
      const port = await serial.requestPort();
      await port.open({ baudRate: 115200 });
      const reader = port.readable?.getReader() ?? null;
      activePorts.current[device] = { port, reader };
      const path = devicePath(port);
      setDevices(previous => ({ ...previous, [device]: { connected: true, path, lastLine: '' } }));
      setSerialMessage((device === 'uno' ? 'Arduino Uno' : 'SENTINEL ESP32') + ' connected. Serial text is observational, not proof of integrity.');
      addEvent('success', 'Board connected over USB', (device === 'uno' ? 'Arduino Uno' : 'SENTINEL ESP32') + ' · ' + path + ' · 115200 baud.');
      if (reader) void readSerial(device, port, reader);
      else addEvent('warning', 'No readable serial stream', 'The selected device opened but did not expose a readable stream.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes('cancel')) {
        setSerialMessage('Could not open selected board: ' + message);
        addEvent('warning', 'USB connection failed', message + ' Close Arduino IDE Serial Monitor if it is using this port, then retry.');
      }
    }
  };

  const readSerial = async (device: DeviceKey, port: WebSerialPort, reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            setDevices(previous => ({ ...previous, [device]: { ...previous[device], lastLine: line } }));
            addEvent('info', device === 'uno' ? 'Uno serial output' : 'ESP32 serial output', line);
          }
          newline = buffer.indexOf('\n');
        }
        if (buffer.length > 4096) buffer = buffer.slice(-1024);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (activePorts.current[device]?.port === port) {
        addEvent('warning', 'Serial read interrupted', message);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* stream may already be released */ }
      if (activePorts.current[device]?.port === port) {
        activePorts.current[device] = null;
        try { await port.close(); } catch { /* device may already have disconnected */ }
        setDevices(previous => ({ ...previous, [device]: { connected: false, path: '', lastLine: previous[device].lastLine } }));
        addEvent('warning', 'Board serial connection ended', device === 'uno' ? 'Arduino Uno' : 'SENTINEL ESP32');
      }
    }
  };

  const disconnectHardware = async (device: DeviceKey) => {
    const active = activePorts.current[device];
    if (!active) return;
    activePorts.current[device] = null;
    try { await active.reader?.cancel(); } catch { /* stream may already be closed */ }
    try { await active.port.close(); } catch { /* close may race the read loop */ }
    setDevices(previous => ({ ...previous, [device]: { connected: false, path: '', lastLine: previous[device].lastLine } }));
    addEvent('info', 'Board disconnected', device === 'uno' ? 'Arduino Uno USB serial port released.' : 'SENTINEL ESP32 USB serial port released.');
  };

  return (
    <div className="site-shell">
      <header className="masthead">
        <a className="identity" href="#top" aria-label="SENTINEL home">
          <span className="brand-symbol"><BrandMark /></span>
          <span className="brand-type"><strong>SENTINEL</strong><small>ATM GUARDIAN / LAB 01</small></span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <button className={view === 'simulation' ? 'nav-link active' : 'nav-link'} onClick={() => setView('simulation')}>Simulation</button>
          <button className={view === 'hardware' ? 'nav-link active' : 'nav-link'} onClick={() => setView('hardware')}>Hardware lab</button>
        </nav>
        <div className="masthead-meta">
          <span className="environment-label"><span className="live-dot" /> SOFTWARE MODEL</span>
          <span className="hardware-count"><Cable size={14} /> {connectedCount}/2 BOARDS</span>
        </div>
      </header>

      <main id="top" className="page-wrap">
        <section className="intro">
          <div className="intro-copy">
            <div className="eyebrow"><span>SECURITY RESEARCH</span><i /> PROTOTYPE 01</div>
            <h1>When the controller<br /><em>loses trust,</em> cash stops.</h1>
            <p className="intro-lede">SENTINEL is an independent guardian for the ATM’s main protective microcontroller. This lab models controller compromise, detection, and revocation—not transaction inspection.</p>
          </div>
          <div className="intro-index" aria-label="Prototype information">
            <span>EXPERIMENT</span>
            <strong>01 <i>/</i> 03</strong>
            <small>CONTROLLER INTEGRITY</small>
          </div>
        </section>

        {view === 'simulation' ? (
          <>
            <section className="mode-bar" aria-label="Test mode">
              <div className="mode-intro"><span className="section-number">A</span><div><strong>Choose the test condition</strong><small>Run the same controller-failure fixture in both modes.</small></div></div>
              <div className="mode-switch">
                <button className={mode === 'baseline' ? 'mode-choice selected baseline' : 'mode-choice'} onClick={() => changeMode('baseline')}><LockOpen size={15} /><span>Unprotected baseline</span></button>
                <button className={mode === 'protected' ? 'mode-choice selected protected' : 'mode-choice'} onClick={() => changeMode('protected')}><ShieldCheck size={15} /><span>SENTINEL active</span></button>
              </div>
              <button className="reset-button" onClick={() => resetScenario()}><RotateCcw size={14} /> Reset test</button>
            </section>

            <section className="experiment-grid">
              <article className="atm-workbench">
                <div className="panel-caption"><span>01 / CUSTOMER TERMINAL</span><span>SIMULATED UNIT <b>ATM-001</b></span></div>
                <div className="atm-bezel">
                  <div className="atm-topline"><div className="atm-bank-mark"><BrandMark size={26} /><span>SENTINEL <small>DEMO BANK</small></span></div><span className="terminal-chip"><span className="live-dot" /> ONLINE</span></div>
                  <div className="atm-display">
                    <div className="screen-caption">AVAILABLE BALANCE</div>
                    <div className="balance-number">{currency(balance)}</div>
                    <div className="balance-note"><WalletCards size={14} /> TEST ACCOUNT / SIM-0001</div>
                    <div className="screen-rule" />
                    <div className="screen-question">Select a withdrawal amount</div>
                    <div className="amount-options">
                      {[500, 1000, 2000, 5000].map(value => (
                        <button key={value} className={amount === value ? 'amount-option chosen' : 'amount-option'} onClick={() => setAmount(value)} aria-pressed={amount === value}>
                          <span>{currency(value)}</span><span className="choice-dot">{amount === value ? <i /> : null}</span>
                        </button>
                      ))}
                    </div>
                    <button className="dispense-action" onClick={withdraw}>
                      <span><ArrowDownToLine size={17} /> {quarantined && mode === 'protected' ? 'Attempt dispense' : 'Dispense virtual cash'}</span>
                      <strong>{currency(amount)} <ArrowRight size={15} /></strong>
                    </button>
                    {quarantined && mode === 'protected' ? (
                      <div className="dispense-state blocked"><LockKeyhole size={14} /><span>DISPENSER LOCKED — CONTROLLER AUTHORITY REVOKED</span></div>
                    ) : (
                      <div className="dispense-state"><CheckCircle2 size={14} /><span>SIMULATION READY · NO PHYSICAL CASH</span></div>
                    )}
                  </div>
                  <div className="atm-bottomline"><span><span className="tiny-light" /> CARDLESS TEST SESSION</span><span>BUILD MODEL 01</span></div>
                </div>
                <div className="cash-summary">
                  <div><span>SESSION DISPENSED</span><strong>{currency(dispensed)}</strong></div>
                  <div><span>REMAINING BALANCE</span><strong>{currency(balance)}</strong></div>
                  <div><span>DISPENSER POLICY</span><strong className={quarantined && mode === 'protected' ? 'status-revoked' : 'status-ready'}>{quarantined && mode === 'protected' ? 'REVOKED' : 'AVAILABLE'}</strong></div>
                </div>
                <p className="terminal-footnote"><LockKeyhole size={12} /> The account and dispenser are entirely virtual. No bank service or physical dispenser is connected.</p>
              </article>

              <aside className="guardian-column">
                <section className="guardian-panel">
                  <div className="panel-caption"><span>02 / CONTROLLER OBSERVATION</span><span className="reference-id">REF. SG-01</span></div>
                  <div className="guardian-heading">
                    <div className="guardian-emblem"><ShieldCheck size={24} strokeWidth={1.7} /></div>
                    <div className="guardian-title"><h2>{quarantined && mode === 'protected' ? 'Authority revoked' : 'Controller under watch'}</h2><p>{quarantined && mode === 'protected' ? 'The virtual dispenser is enforcing quarantine.' : mode === 'protected' ? 'SENTINEL model is armed and awaiting evidence.' : 'Baseline mode has no independent guardian enforcement.'}</p></div>
                    <span className={'trust-tag ' + (quarantined && mode === 'protected' ? 'danger' : mode === 'protected' ? 'trusted' : 'neutral')}>{quarantined && mode === 'protected' ? 'REVOKED' : mode === 'protected' ? 'ARMED' : 'BASELINE'}</span>
                  </div>
                  <div className="controller-chain">
                    <div className="chain-row">
                      <div className="chain-icon uno"><Cpu size={18} /></div>
                      <div className="chain-copy"><strong>Arduino Uno</strong><span>Main protective controller · observed subject</span></div>
                      <span className="chain-state">{evidence.reportedBuild !== evidence.approvedBuild ? <b className="state-fail">ANOMALY</b> : <b>EXPECTED</b>}</span>
                    </div>
                    <div className="chain-connector"><span /><small>INDEPENDENT SUPERVISION</small></div>
                    <div className="chain-row">
                      <div className="chain-icon sentinel"><Shield size={18} /></div>
                      <div className="chain-copy"><strong>SENTINEL · ESP32</strong><span>Integrity rules · authority revocation</span></div>
                      <span className="chain-state">{mode === 'protected' ? <b className={quarantined ? 'state-fail' : 'state-ok'}>{quarantined ? 'DENY' : 'ARMED'}</b> : <b>INACTIVE</b>}</span>
                    </div>
                    <div className="chain-connector"><span /><small>ENFORCEMENT BOUNDARY</small></div>
                    <div className="chain-row">
                      <div className={'chain-icon dispenser ' + (quarantined && mode === 'protected' ? 'locked' : '')}><Banknote size={18} /></div>
                      <div className="chain-copy"><strong>Virtual cash dispenser</strong><span>Final simulated dispense decision</span></div>
                      <span className="chain-state"><b className={quarantined && mode === 'protected' ? 'state-fail' : 'state-ok'}>{quarantined && mode === 'protected' ? 'LOCKED' : 'READY'}</b></span>
                    </div>
                  </div>
                  <div className="evidence-heading"><span>CONTROLLER EVIDENCE</span><span>{assessment ? assessment.findings.length + ' RULES TRIPPED' : 'TEST FIXTURE'}</span></div>
                  <div className="evidence-list">
                    <div className="evidence-row"><span className={'evidence-indicator ' + (evidence.reportedBuild !== evidence.approvedBuild ? 'bad' : 'good')} /><span className="evidence-name">Build identity</span><span className="evidence-value">{evidence.reportedBuild !== evidence.approvedBuild ? 'MISMATCH' : 'MATCH'}</span></div>
                    <div className="evidence-row"><span className={'evidence-indicator ' + (evidence.privilegedPathRequested && !evidence.maintenanceWindowOpen ? 'bad' : 'good')} /><span className="evidence-name">Privileged path</span><span className="evidence-value">{evidence.privilegedPathRequested && !evidence.maintenanceWindowOpen ? 'OUT OF WINDOW' : 'CLOSED'}</span></div>
                    <div className="evidence-row"><span className={'evidence-indicator ' + (evidence.observedSequence !== evidence.expectedSequence ? 'bad' : 'good')} /><span className="evidence-name">Control sequence</span><span className="evidence-value">{evidence.observedSequence === evidence.expectedSequence ? 'IN SYNC' : 'DIVERGED'}</span></div>
                  </div>
                  {assessment && assessment.compromised && mode === 'protected' ? (
                    <div className="decision-block denied"><div><AlertOctagon size={17} /><strong>SENTINEL DECISION / REVOKE</strong></div><p>{assessment.findings.join('. ')}. The simulated dispenser does not accept further authority from the Uno.</p></div>
                  ) : (
                    <div className="decision-block"><div><Activity size={16} /><strong>{mode === 'protected' ? 'SENTINEL DECISION / MONITOR' : 'GUARDIAN / NOT ENFORCING'}</strong></div><p>{mode === 'protected' ? 'No controller anomaly has been introduced. Normal virtual withdrawals remain available.' : 'This comparison intentionally removes independent guardian enforcement so the baseline failure can be observed.'}</p></div>
                  )}
                  <button className="scenario-button" onClick={runCompromise} disabled={quarantined && mode === 'protected'}>
                    <Fingerprint size={17} /><span><strong>{quarantined && mode === 'protected' ? 'Controller quarantined' : 'Inject controller compromise'}</strong><small>Simulated test fixture · no real malware</small></span><ArrowRight size={17} />
                  </button>
                  <p className="model-boundary">The button creates test evidence; the configured rules determine the model's decision. Hardware-backed evidence is not yet implemented.</p>
                </section>

                <section className="principle-note">
                  <div className="principle-icon"><LockKeyhole size={17} /></div>
                  <div><strong>Security boundary</strong><p>SENTINEL watches the Uno’s controller integrity. It does not inspect PINs, account balances, or customer transaction rules.</p></div>
                </section>
              </aside>
            </section>

            <section className="activity-section">
              <div className="activity-header"><div><span className="section-number">B</span><div><h2>Experiment record</h2><p>Traceable events from this simulation session.</p></div></div><div className="activity-meta"><span>{summary.eventCount.toString().padStart(2, '0')} EVENTS</span><span>{summary.alerts.toString().padStart(2, '0')} ALERTS</span><button onClick={() => setFeed([])} aria-label="Clear experiment record" title="Clear experiment record"><X size={14} /></button></div></div>
              {feed.length === 0 ? (
                <div className="empty-feed"><Terminal size={17} /><span>No events recorded. Run a test or perform a virtual withdrawal.</span></div>
              ) : (
                <div className="event-table">
                  {feed.slice(-6).reverse().map(item => <EventRow key={item.id} item={item} />)}
                </div>
              )}
            </section>
          </>
        ) : (
          <section className="hardware-view">
            <div className="hardware-intro"><div><div className="eyebrow"><span>HARDWARE INTEGRATION</span><i /> USB SERIAL</div><h2>Observe the two boards.</h2><p>The browser can read each board’s USB serial console. The existing Uno-to-ESP32 UART connection remains the board-to-board path.</p></div><div className={'serial-support ' + (serialSupported ? 'supported' : 'unsupported')}><span className="live-dot" />{serialSupported ? 'WEB SERIAL AVAILABLE' : 'WEB SERIAL UNAVAILABLE'}</div></div>
            <div className="hardware-notice"><CircleAlert size={17} /><p>{serialMessage}<br /><strong>Close Arduino IDE Serial Monitor before opening the same port here.</strong></p></div>
            <div className="hardware-grid">
              <HardwareCard device="uno" state={devices.uno} supported={serialSupported} onConnect={() => void connectHardware('uno')} onDisconnect={() => void disconnectHardware('uno')} />
              <HardwareCard device="sentinel" state={devices.sentinel} supported={serialSupported} onConnect={() => void connectHardware('sentinel')} onDisconnect={() => void disconnectHardware('sentinel')} />
            </div>
            <div className="hardware-architecture">
              <div className="architecture-title"><span className="section-number">C</span><div><h3>System topology</h3><p>The security decision and the customer transaction are intentionally separate.</p></div></div>
              <div className="architecture-flow">
                <div className="architecture-node"><Monitor size={19} /><strong>Browser simulator</strong><small>Virtual ATM + visible audit trail</small></div>
                <span className="architecture-arrow"><ArrowRight size={17} /><small>USB serial × 2</small></span>
                <div className="architecture-node"><Cpu size={19} /><strong>Arduino Uno</strong><small>Main protective controller</small></div>
                <span className="architecture-arrow"><ArrowRight size={17} /><small>UART · existing link</small></span>
                <div className="architecture-node"><ShieldCheck size={19} /><strong>ESP32 SENTINEL</strong><small>Independent guardian</small></div>
              </div>
              <p className="hardware-boundary"><ShieldAlert size={15} /> The serial window displays messages only. It does not infer compromise from arbitrary text. The controller-monitoring protocol must provide verifiable evidence before the physical boards can claim to detect a compromised Uno.</p>
            </div>
          </section>
        )}

        <footer className="site-footer"><div className="footer-brand"><BrandMark size={20} /><strong>SENTINEL</strong><span>ATM GUARDIAN</span></div><span>PROTOTYPE 01 <i>·</i> EDUCATIONAL SIMULATION</span><span>NO REAL ACCOUNTS <i>·</i> NO PHYSICAL CASH</span></footer>
      </main>
    </div>
  );
}

function EventRow({ item }: { item: FeedItem }) {
  const Icon = item.kind === 'success' ? CheckCircle2 : item.kind === 'warning' ? CircleAlert : item.kind === 'danger' ? AlertOctagon : Terminal;
  return (
    <div className={'event-row event-' + item.kind}>
      <div className="event-marker"><Icon size={15} /></div>
      <time>{item.time}</time>
      <div className="event-content"><strong>{item.title}</strong><span>{item.detail}</span></div>
      <span className="event-kind">{item.kind.toUpperCase()}</span>
    </div>
  );
}

function HardwareCard({
  device, state, supported, onConnect, onDisconnect
}: {
  device: DeviceKey; state: DeviceState; supported: boolean;
  onConnect: () => void; onDisconnect: () => void;
}) {
  const isUno = device === 'uno';
  return (
    <article className="hardware-card">
      <div className="hardware-card-head"><div className={'hardware-device-icon ' + (isUno ? 'uno' : 'sentinel')}>{isUno ? <Cpu size={22} /> : <ShieldCheck size={22} />}</div><div className="hardware-device-title"><span>{isUno ? 'DEVICE 01' : 'DEVICE 02'}</span><h3>{isUno ? 'Arduino Uno' : 'SENTINEL ESP32'}</h3><p>{isUno ? 'Main protective controller' : 'Independent controller guardian'}</p></div><span className={'device-status ' + (state.connected ? 'connected' : '')}><i />{state.connected ? 'CONNECTED' : 'NOT CONNECTED'}</span></div>
      <div className="hardware-device-meta"><span>PORT IDENTIFIER</span><strong>{state.path || 'Permission not granted'}</strong></div>
      <div className="hardware-device-meta"><span>LAST SERIAL LINE</span><strong className="last-line">{state.lastLine || 'Waiting for USB serial output'}</strong></div>
      <button className={state.connected ? 'hardware-button disconnect' : 'hardware-button'} disabled={!supported} onClick={state.connected ? onDisconnect : onConnect}>{state.connected ? <><X size={15} /> Disconnect board</> : <><Plug size={15} /> Connect over USB</>}</button>
    </article>
  );
}
