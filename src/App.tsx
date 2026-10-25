import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertOctagon, ArrowDownToLine, ArrowLeftRight, ArrowUpRight,
  Banknote, BadgeCheck, Cable, Check, CheckCircle2, ChevronDown, CircleAlert,
  CircleDot, Clock3, Cpu, Fingerprint, Gauge, Landmark, LockKeyhole, LockOpen,
  Monitor, Plug, Radio, RefreshCw, RotateCcw, Server, Shield, ShieldAlert,
  ShieldCheck, SlidersHorizontal, Terminal, WalletCards, X
} from 'lucide-react';

type View = 'atm' | 'control';
type Mode = 'baseline' | 'protected';
type EventKind = 'info' | 'success' | 'warning' | 'danger';
type DeviceKey = 'uno' | 'sentinel';
type PortInfo = { path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string };
type FeedItem = { id: number; time: string; kind: EventKind; title: string; detail: string };
type ControllerEvidence = {
  approvedBuild: string;
  reportedBuild: string;
  privilegedPathRequested: boolean;
  maintenanceWindowOpen: boolean;
  observedSequence: number;
  expectedSequence: number;
};
type Assessment = { compromised: boolean; findings: string[] };

const currency = (amount: number) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0
}).format(amount);

function nowLabel() {
  return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/**
 * Educational controller evidence evaluator.
 * These checks evaluate reported evidence, not the button that starts the scenario.
 * A hardware implementation will need a real, independently verifiable source for each signal.
 */
function assessControllerEvidence(evidence: ControllerEvidence): Assessment {
  const findings: string[] = [];
  if (evidence.reportedBuild !== evidence.approvedBuild) {
    findings.push('Controller build identity differs from the approved profile');
  }
  if (evidence.privilegedPathRequested && !evidence.maintenanceWindowOpen) {
    findings.push('Privileged service path is active outside an approved maintenance window');
  }
  if (evidence.observedSequence !== evidence.expectedSequence) {
    findings.push('Controller control-sequence state is inconsistent with the expected state');
  }
  return { compromised: findings.length > 0, findings };
}

function makeEvent(kind: EventKind, title: string, detail: string): FeedItem {
  return { id: Date.now() + Math.random(), time: nowLabel(), kind, title, detail };
}

export default function App() {
  const [view, setView] = useState<View>('atm');
  const [mode, setMode] = useState<Mode>('protected');
  const [balance, setBalance] = useState(25000);
  const [cashDispensed, setCashDispensed] = useState(0);
  const [selectedAmount, setSelectedAmount] = useState(1000);
  const [quarantined, setQuarantined] = useState(false);
  const [receipt, setReceipt] = useState<{ amount: number; ref: string } | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([
    makeEvent('success', 'ATM simulator initialized', 'Software-only environment is ready. No real account or cash is connected.'),
    makeEvent('info', 'SENTINEL policy loaded', 'Controller-monitoring demonstration rules are available in the protected scenario.')
  ]);
  const [bridgeState, setBridgeState] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPorts, setSelectedPorts] = useState<Record<DeviceKey, string>>({ uno: '', sentinel: '' });
  const [devices, setDevices] = useState<Record<DeviceKey, { connected: boolean; path: string; lastLine: string }>>({
    uno: { connected: false, path: '', lastLine: '' },
    sentinel: { connected: false, path: '', lastLine: '' }
  });
  const [bridgeMessage, setBridgeMessage] = useState('Start the local serial bridge to attach hardware.');
  const [lastAssessment, setLastAssessment] = useState<Assessment | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const addEvent = useCallback((kind: EventKind, title: string, detail: string) => {
    setFeed(previous => [...previous.slice(-39), makeEvent(kind, title, detail)]);
  }, []);

  const sendBridge = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    }
    setBridgeMessage('Bridge is not connected. The ATM remains usable in software simulation mode.');
    return false;
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;

    const connect = () => {
      if (disposed) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket('ws://127.0.0.1:8787');
      } catch {
        setBridgeState('offline');
        return;
      }
      socketRef.current = socket;
      socket.onopen = () => {
        setBridgeState('online');
        setBridgeMessage('Local bridge connected. Hardware links are still optional.');
        socket.send(JSON.stringify({ type: 'get_state' }));
        socket.send(JSON.stringify({ type: 'scan_ports' }));
      };
      socket.onmessage = event => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === 'bridge_state') {
            setDevices((previous) => ({
              uno: { ...previous.uno, connected: Boolean(message.devices?.uno?.connected), path: message.devices?.uno?.path || '', lastLine: previous.uno.lastLine },
              sentinel: { ...previous.sentinel, connected: Boolean(message.devices?.sentinel?.connected), path: message.devices?.sentinel?.path || '', lastLine: previous.sentinel.lastLine }
            }));
          } else if (message.type === 'ports') {
            const found = Array.isArray(message.ports) ? message.ports as PortInfo[] : [];
            setPorts(found);
            setBridgeMessage(found.length ? 'Serial ports discovered. Choose a port for each board.' : 'Bridge is running, but no serial ports were found.');
          } else if (message.type === 'device_status') {
            const device = message.device as DeviceKey;
            if (device === 'uno' || device === 'sentinel') {
              setDevices(previous => ({
                ...previous,
                [device]: { ...previous[device], connected: Boolean(message.connected), path: message.path || '', lastLine: previous[device].lastLine }
              }));
              addEvent(message.connected ? 'success' : 'warning', message.connected ? 'USB serial connected' : 'USB serial disconnected',
                (device === 'uno' ? 'Arduino Uno' : 'SENTINEL ESP32') + (message.path ? ' · ' + message.path : ''));
            }
          } else if (message.type === 'serial_data') {
            const device = message.device as DeviceKey;
            if (device === 'uno' || device === 'sentinel') {
              const line = String(message.line || '').trim();
              setDevices(previous => ({ ...previous, [device]: { ...previous[device], lastLine: line } }));
              if (line) addEvent('info', device === 'uno' ? 'Message from Arduino Uno' : 'Message from SENTINEL ESP32', line);
            }
          } else if (message.type === 'bridge_error') {
            setBridgeMessage(String(message.message || 'Serial bridge reported an error.'));
            addEvent('warning', 'Hardware bridge notice', String(message.message || 'Unknown bridge error.'));
          } else if (message.type === 'bridge_ready') {
            setBridgeState('online');
          }
        } catch {
          addEvent('warning', 'Unrecognized bridge message', 'The local bridge sent data that could not be parsed as JSON.');
        }
      };
      socket.onerror = () => {
        if (!disposed) setBridgeState('offline');
      };
      socket.onclose = () => {
        if (disposed) return;
        setBridgeState('offline');
        socketRef.current = null;
        retryTimer = window.setTimeout(connect, 2500);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [addEvent]);

  const eventSummary = useMemo(() => ({
    total: feed.length,
    alerts: feed.filter(event => event.kind === 'warning' || event.kind === 'danger').length
  }), [feed]);

  const handleWithdraw = () => {
    if (quarantined && mode === 'protected') {
      addEvent('danger', 'Dispense request denied', 'SENTINEL has revoked the simulated controller authority. Reset the scenario to resume.');
      return;
    }
    if (selectedAmount <= 0 || selectedAmount > balance) {
      addEvent('warning', 'Withdrawal unavailable', 'Choose a valid amount within the illustrative account balance.');
      return;
    }
    setBalance(previous => previous - selectedAmount);
    setCashDispensed(previous => previous + selectedAmount);
    const ref = 'ATM-' + String(Date.now()).slice(-7);
    setReceipt({ amount: selectedAmount, ref });
    addEvent('success', 'Virtual cash dispensed', currency(selectedAmount) + ' · reference ' + ref + ' · software simulation only.');
  };

  const runCompromiseScenario = () => {
    setReceipt(null);
    addEvent('warning', 'Compromise scenario started', 'A simulated controller-integrity failure is being introduced. No real malware or ATM hardware is involved.');

    // The scenario supplies controller evidence. SENTINEL evaluates these fields using the same
    // generic evidence rules used by this simulation; the attack button itself is not the verdict.
    const evidence: ControllerEvidence = {
      approvedBuild: 'ATM-CTRL-01',
      reportedBuild: 'ATM-CTRL-01-MODIFIED',
      privilegedPathRequested: true,
      maintenanceWindowOpen: false,
      observedSequence: 43,
      expectedSequence: 42
    };

    if (mode === 'baseline') {
      setLastAssessment(null);
      addEvent('danger', 'No independent guardian attached', 'The controller evidence is not evaluated by SENTINEL in baseline mode. The compromised controller requests a simulated ₹2,000 dispense.');
      if (balance >= 2000) {
        setBalance(previous => previous - 2000);
        setCashDispensed(previous => previous + 2000);
        setReceipt({ amount: 2000, ref: 'BASE-' + String(Date.now()).slice(-6) });
        addEvent('danger', 'Baseline vulnerability reproduced', 'The simulated dispenser accepted the compromised controller request. Virtual balance and dispense totals changed.');
      } else {
        addEvent('warning', 'Scenario needs a balance reset', 'Less than ₹2,000 remains in the illustrative account. Use Reset demo to restore the test account.');
      }
      return;
    }

    const assessment = assessControllerEvidence(evidence);
    setLastAssessment(assessment);
    addEvent(assessment.compromised ? 'danger' : 'success',
      assessment.compromised ? 'SENTINEL detected controller-integrity anomalies' : 'SENTINEL evidence check passed',
      assessment.findings.length ? assessment.findings.join(' · ') : 'No configured controller-integrity rule was violated.');
    if (assessment.compromised) {
      setQuarantined(true);
      addEvent('danger', 'Controller authority revoked', 'SENTINEL enters QUARANTINE. The virtual dispenser refuses this controller request; no cash is released.');
      addEvent('warning', 'Follow-up dispense blocked', 'A second request from the quarantined controller is refused by the simulator. Dispensed total remains unchanged.');
    }
  };

  const selectMode = (nextMode: Mode) => {
    setMode(nextMode);
    setQuarantined(false);
    setReceipt(null);
    setLastAssessment(null);
    addEvent('info', nextMode === 'protected' ? 'Protected demo mode selected' : 'Baseline demo mode selected',
      nextMode === 'protected'
        ? 'The software model will evaluate controller evidence and enforce its quarantine state.'
        : 'The independent SENTINEL decision is not enforced in this baseline comparison.');
  };

  const resetDemo = () => {
    setBalance(25000);
    setCashDispensed(0);
    setQuarantined(false);
    setReceipt(null);
    setLastAssessment(null);
    setSelectedAmount(1000);
    addEvent('info', 'Demo state reset', 'Illustrative balance restored to ₹25,000; virtual cash-dispensed counter and quarantine state cleared.');
  };

  const scanPorts = () => {
    if (!sendBridge({ type: 'scan_ports' })) {
      addEvent('warning', 'Hardware bridge unavailable', 'Run the local Node.js bridge to scan USB serial ports. Software simulation continues to work.');
    }
  };

  const connectDevice = (device: DeviceKey) => {
    const path = selectedPorts[device];
    if (!path) {
      addEvent('warning', 'Choose a serial port first', 'Select the port for ' + (device === 'uno' ? 'Arduino Uno' : 'SENTINEL ESP32') + '.');
      return;
    }
    sendBridge({ type: 'connect', device, path, baudRate: 115200 });
  };

  const disconnectDevice = (device: DeviceKey) => sendBridge({ type: 'disconnect', device });
  const bridgeStatus = bridgeState === 'online' ? 'Bridge online' : bridgeState === 'connecting' ? 'Connecting bridge' : 'Bridge offline';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><ShieldCheck size={23} strokeWidth={2.2} /></div>
          <div className="brand-copy">
            <span className="brand-name">SENTINEL</span>
            <span className="brand-subtitle">ATM CONTROL LAB</span>
          </div>
        </div>

        <div className="workspace-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Primary navigation">
          <button className={'nav-item ' + (view === 'atm' ? 'active' : '')} onClick={() => setView('atm')}>
            <Landmark size={18} /><span>ATM simulator</span><span className="nav-dot" />
          </button>
          <button className={'nav-item ' + (view === 'control' ? 'active' : '')} onClick={() => setView('control')}>
            <Activity size={18} /><span>Controller lab</span>
          </button>
        </nav>

        <div className="sidebar-separator" />
        <div className="workspace-label">SYSTEM</div>
        <div className="system-nav">
          <div className="system-row"><span className={'state-dot ' + (bridgeState === 'online' ? 'green' : 'muted')} /><span>Local serial bridge</span><span className="system-state">{bridgeState === 'online' ? 'ON' : '—'}</span></div>
          <div className="system-row"><span className={'state-dot ' + (devices.uno.connected ? 'green' : 'muted')} /><span>Arduino Uno</span><span className="system-state">{devices.uno.connected ? 'USB' : 'OFF'}</span></div>
          <div className="system-row"><span className={'state-dot ' + (devices.sentinel.connected ? 'green' : 'muted')} /><span>SENTINEL ESP32</span><span className="system-state">{devices.sentinel.connected ? 'USB' : 'OFF'}</span></div>
        </div>
        <div className="sidebar-footer">
          <div className="footer-shield"><Shield size={16} /></div>
          <div><strong>Research prototype</strong><span>Simulation only · No real cash</span></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Sentinel</span><span className="crumb-slash">/</span><strong>{view === 'atm' ? 'ATM Simulator' : 'Controller Lab'}</strong></div>
          <div className="topbar-right">
            <div className="environment-pill"><span className="pill-dot" />LOCAL SIMULATION</div>
            <div className={'bridge-pill ' + bridgeState}><span className="state-dot" />{bridgeStatus}</div>
            <button className="icon-button" onClick={scanPorts} title="Scan serial ports" aria-label="Scan serial ports"><RefreshCw size={17} /></button>
          </div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> SENTINEL / PROTOTYPE 01</div>
              <h1>{view === 'atm' ? 'ATM control environment' : 'Controller integrity lab'}</h1>
              <p>{view === 'atm'
                ? 'A controlled ATM simulator for testing controller behavior and independent security containment.'
                : 'Inspect the controller signals, local hardware links, and the evidence model used by this prototype.'}</p>
            </div>
            <button className="secondary-button" onClick={resetDemo}><RotateCcw size={16} /> Reset demo</button>
          </section>

          <section className="notice-strip">
            <div className="notice-icon"><CircleAlert size={17} /></div>
            <div><strong>Educational simulation</strong><span>The balances and dispensing events are virtual. Live hardware detection is not enabled yet; the current compromise comparison uses a software evidence model.</span></div>
            <span className="notice-tag">NO REAL ATM</span>
          </section>

          {view === 'atm' ? (
            <>
              <section className="summary-grid">
                <div className="summary-card balance-card">
                  <div className="summary-top"><span>TEST ACCOUNT BALANCE</span><div className="summary-icon blue"><WalletCards size={18} /></div></div>
                  <div className="summary-value">{currency(balance)}</div>
                  <div className="summary-bottom"><span className="tiny-indicator blue-indicator" />Illustrative account · SIM-0001</div>
                </div>
                <div className="summary-card">
                  <div className="summary-top"><span>VIRTUAL CASH DISPENSED</span><div className="summary-icon green"><Banknote size={18} /></div></div>
                  <div className="summary-value">{currency(cashDispensed)}</div>
                  <div className="summary-bottom"><span className="tiny-indicator green-indicator" />This demo session</div>
                </div>
                <div className="summary-card">
                  <div className="summary-top"><span>SECURITY STATE</span><div className={'summary-icon ' + (quarantined ? 'red' : 'green')}><ShieldCheck size={18} /></div></div>
                  <div className={'summary-value state-value ' + (quarantined ? 'text-red' : 'text-green')}>{quarantined ? 'QUARANTINED' : 'MONITORING'}</div>
                  <div className="summary-bottom"><span className={'tiny-indicator ' + (quarantined ? 'red-indicator' : 'green-indicator')} />{quarantined ? 'Controller authority revoked' : mode === 'protected' ? 'Protected scenario armed' : 'Baseline · guardian not enforcing'}</div>
                </div>
              </section>

              <section className="work-grid">
                <div className="panel atm-panel">
                  <div className="panel-heading">
                    <div><div className="panel-kicker">01 / CUSTOMER INTERFACE</div><h2>Cash withdrawal</h2></div>
                    <div className="atm-ready"><span className="state-dot green" />SIMULATOR READY</div>
                  </div>
                  <div className="atm-screen">
                    <div className="atm-screen-top"><div className="atm-mini-brand"><ShieldCheck size={17} /><span>SENTINEL BANK</span></div><span className="atm-mini-label">DEMO ATM · 001</span></div>
                    <div className="atm-welcome"><div className="atm-overline">WELCOME BACK</div><h3>How much would<br />you like to withdraw?</h3><p>Choose an amount below to run a virtual transaction.</p></div>
                    <div className="amount-grid">
                      {[500, 1000, 2000, 5000].map(amount => (
                        <button key={amount} className={'amount-button ' + (selectedAmount === amount ? 'selected' : '')} onClick={() => setSelectedAmount(amount)} disabled={quarantined && mode === 'protected'}>
                          <span>{currency(amount)}</span><span className="amount-radio">{selectedAmount === amount && <span />}</span>
                        </button>
                      ))}
                    </div>
                    <div className="atm-balance-row"><span>AVAILABLE BALANCE</span><strong>{currency(balance)}</strong></div>
                    <button className="dispense-button" onClick={handleWithdraw} disabled={quarantined && mode === 'protected'}>
                      <ArrowDownToLine size={18} /> Dispense cash <span>{currency(selectedAmount)}</span>
                    </button>
                    {quarantined && mode === 'protected' && <div className="blocked-banner"><LockKeyhole size={15} /><span>DISPENSING LOCKED — controller quarantined by SENTINEL</span></div>}
                    {receipt && <div className="receipt-banner"><CheckCircle2 size={16} /><span>Virtual dispense: {currency(receipt.amount)} · Ref {receipt.ref}</span></div>}
                    <div className="atm-footnote"><LockKeyhole size={12} /> Virtual transaction only. No PIN, bank network, or physical dispenser is connected.</div>
                  </div>
                  <div className="panel-foot"><span><CircleDot size={13} /> ATM controller model</span><span>Build profile ATM-CTRL-01</span></div>
                </div>

                <div className="right-column">
                  <div className="panel mode-panel">
                    <div className="panel-heading compact"><div><div className="panel-kicker">02 / TEST CONFIGURATION</div><h2>Security comparison</h2></div><SlidersHorizontal size={18} className="heading-icon" /></div>
                    <p className="panel-description">Run the same controller-failure scenario against the baseline and protected software models.</p>
                    <div className="mode-selector">
                      <button className={'mode-option ' + (mode === 'baseline' ? 'chosen baseline-chosen' : '')} onClick={() => selectMode('baseline')}>
                        <div className="mode-option-icon"><LockOpen size={17} /></div><div><strong>Baseline</strong><span>No guardian enforcement</span></div>{mode === 'baseline' && <Check size={15} />}
                      </button>
                      <button className={'mode-option ' + (mode === 'protected' ? 'chosen protected-chosen' : '')} onClick={() => selectMode('protected')}>
                        <div className="mode-option-icon"><ShieldCheck size={17} /></div><div><strong>SENTINEL protected</strong><span>Evidence check + quarantine</span></div>{mode === 'protected' && <Check size={15} />}
                      </button>
                    </div>
                    <div className="mode-divider" />
                    <div className="scenario-copy"><div className="scenario-icon"><Fingerprint size={18} /></div><div><strong>Controller compromise</strong><p>Introduce mismatched build identity, an out-of-window privileged path, and an unexpected control sequence into the software evidence model.</p></div></div>
                    <button className="attack-button" onClick={runCompromiseScenario} disabled={quarantined && mode === 'protected'}><ShieldAlert size={17} /> Run compromise scenario <ArrowUpRight size={15} /></button>
                    <div className="demo-disclaimer"><CircleAlert size={13} /><span>Reproducible test profile. Hardware firmware is not being modified by this button.</span></div>
                  </div>

                  <div className="panel event-panel">
                    <div className="panel-heading compact"><div><div className="panel-kicker">03 / LIVE ACTIVITY</div><h2>Event stream</h2></div><span className="event-count">{eventSummary.total.toString().padStart(2, '0')} EVENTS</span></div>
                    <div className="event-list">
                      {feed.slice(-4).reverse().map(item => <EventRow key={item.id} item={item} />)}
                    </div>
                    <button className="view-all-button" onClick={() => setView('control')}>Open controller lab <ArrowUpRight size={14} /></button>
                  </div>
                </div>
              </section>
            </>
          ) : (
            <section className="control-layout">
              <div className="control-main">
                <div className="panel controller-panel">
                  <div className="panel-heading"><div><div className="panel-kicker">CONTROLLER UNDER OBSERVATION</div><h2>Arduino Uno</h2></div><div className={'connection-chip ' + (devices.uno.connected ? 'connected' : '')}><span className="state-dot" />{devices.uno.connected ? 'USB CONNECTED' : 'NOT CONNECTED'}</div></div>
                  <p className="panel-description">The Uno represents the ATM's main protective microcontroller in this educational setup. The current board link reports serial data only; integrity verification will be integrated with the firmware protocol in a later step.</p>
                  <div className="controller-status-grid">
                    <div className="mini-status"><span>OBSERVED PORT</span><strong>{devices.uno.path || 'Not selected'}</strong></div>
                    <div className="mini-status"><span>LAST SERIAL LINE</span><strong className="mono">{devices.uno.lastLine || 'Waiting for data…'}</strong></div>
                    <div className="mini-status"><span>SIMULATED TRUST</span><strong className={quarantined ? 'text-red' : 'text-green'}>{quarantined ? 'REVOKED' : 'NOT VERIFIED'}</strong></div>
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-heading"><div><div className="panel-kicker">INDEPENDENT SUPERVISOR</div><h2>SENTINEL · ESP32</h2></div><div className={'connection-chip ' + (devices.sentinel.connected ? 'connected' : '')}><span className="state-dot" />{devices.sentinel.connected ? 'USB CONNECTED' : 'NOT CONNECTED'}</div></div>
                  <p className="panel-description">SENTINEL is intended to monitor the Uno's integrity and behavior, then revoke its authority when configured evidence indicates compromise. It must not rely on an Uno message declaring itself compromised.</p>
                  <div className="controller-status-grid">
                    <div className="mini-status"><span>OBSERVED PORT</span><strong>{devices.sentinel.path || 'Not selected'}</strong></div>
                    <div className="mini-status"><span>LAST SERIAL LINE</span><strong className="mono">{devices.sentinel.lastLine || 'Waiting for data…'}</strong></div>
                    <div className="mini-status"><span>CONTAINMENT</span><strong className={quarantined ? 'text-red' : 'text-muted'}>{quarantined ? 'SIMULATED QUARANTINE' : 'NOT TRIGGERED'}</strong></div>
                  </div>
                </div>

                <div className="panel evidence-panel">
                  <div className="panel-heading"><div><div className="panel-kicker">EVIDENCE EVALUATOR</div><h2>Last controller assessment</h2></div><Fingerprint size={19} className="heading-icon" /></div>
                  {lastAssessment ? (
                    <div className={'assessment-result ' + (lastAssessment.compromised ? 'assessment-danger' : 'assessment-safe')}>
                      <div className="assessment-title">{lastAssessment.compromised ? <AlertOctagon size={18} /> : <BadgeCheck size={18} />}{lastAssessment.compromised ? 'Integrity anomaly detected' : 'No configured anomaly detected'}</div>
                      {lastAssessment.findings.length ? <ul>{lastAssessment.findings.map(finding => <li key={finding}>{finding}</li>)}</ul> : <p>No configured controller-integrity rule was violated.</p>}
                    </div>
                  ) : <div className="empty-assessment"><Activity size={19} /><div><strong>No protected scenario assessed yet</strong><span>Return to the ATM simulator and run the compromise scenario in SENTINEL protected mode.</span></div></div>}
                  <div className="model-note"><strong>Model boundary</strong><p>These are software-generated teaching signals. The real Uno firmware does not yet provide authenticated integrity evidence, and USB connection status is not proof of a board's integrity.</p></div>
                </div>
              </div>

              <aside className="control-side">
                <div className="panel hardware-panel">
                  <div className="panel-heading compact"><div><div className="panel-kicker">LOCAL CONNECTIONS</div><h2>Hardware bridge</h2></div><Cable size={18} className="heading-icon" /></div>
                  <div className="bridge-state-line"><span className={'state-dot ' + (bridgeState === 'online' ? 'green' : 'muted')} />{bridgeStatus}<span className="bridge-port">127.0.0.1:8787</span></div>
                  <p className="panel-description small">{bridgeMessage}</p>
                  <button className="secondary-button full-button" onClick={scanPorts}><RefreshCw size={15} /> Scan USB serial ports</button>
                  <div className="device-connect-block">
                    <div className="device-connect-heading"><div className="device-icon uno-icon"><Cpu size={16} /></div><div><strong>Arduino Uno</strong><span>USB serial · 115200 baud</span></div></div>
                    <select aria-label="Arduino Uno serial port" value={selectedPorts.uno} onChange={event => setSelectedPorts(previous => ({ ...previous, uno: event.target.value }))}>
                      <option value="">Choose serial port…</option>
                      {ports.map(port => <option key={port.path} value={port.path}>{port.path}{port.manufacturer ? ' — ' + port.manufacturer : ''}</option>)}
                    </select>
                    <button className="connect-button" onClick={() => devices.uno.connected ? disconnectDevice('uno') : connectDevice('uno')} disabled={bridgeState !== 'online' || (!devices.uno.connected && !selectedPorts.uno)}>{devices.uno.connected ? <><X size={15} /> Disconnect Uno</> : <><Plug size={15} /> Connect Uno</>}</button>
                  </div>
                  <div className="device-connect-block">
                    <div className="device-connect-heading"><div className="device-icon esp-icon"><ShieldCheck size={16} /></div><div><strong>SENTINEL ESP32</strong><span>USB serial · 115200 baud</span></div></div>
                    <select aria-label="ESP32 serial port" value={selectedPorts.sentinel} onChange={event => setSelectedPorts(previous => ({ ...previous, sentinel: event.target.value }))}>
                      <option value="">Choose serial port…</option>
                      {ports.map(port => <option key={port.path} value={port.path}>{port.path}{port.manufacturer ? ' — ' + port.manufacturer : ''}</option>)}
                    </select>
                    <button className="connect-button" onClick={() => devices.sentinel.connected ? disconnectDevice('sentinel') : connectDevice('sentinel')} disabled={bridgeState !== 'online' || (!devices.sentinel.connected && !selectedPorts.sentinel)}>{devices.sentinel.connected ? <><X size={15} /> Disconnect ESP32</> : <><Plug size={15} /> Connect ESP32</>}</button>
                  </div>
                  <div className="bridge-caution"><CircleAlert size={14} /><span>Close Arduino IDE Serial Monitor before opening the same board's serial port here.</span></div>
                </div>

                <div className="panel protocol-panel">
                  <div className="panel-heading compact"><div><div className="panel-kicker">LINK TOPOLOGY</div><h2>How the system fits</h2></div><ArrowLeftRight size={18} className="heading-icon" /></div>
                  <div className="topology-node"><div className="topology-icon"><Monitor size={17} /></div><div><strong>MacBook simulator</strong><span>UI + virtual dispenser</span></div></div>
                  <div className="topology-line"><span />USB serial × 2</div>
                  <div className="topology-node"><div className="topology-icon uno-icon"><Cpu size={17} /></div><div><strong>Arduino Uno</strong><span>ATM controller model</span></div></div>
                  <div className="topology-line"><span />UART · current link</div>
                  <div className="topology-node"><div className="topology-icon esp-icon"><ShieldCheck size={17} /></div><div><strong>ESP32 SENTINEL</strong><span>Independent guardian</span></div></div>
                  <div className="topology-note">USB monitoring is a separate path. The Uno-to-ESP32 UART is retained for board-to-board messages.</div>
                </div>
              </aside>
            </section>
          )}

          <section className="bottom-grid">
            <div className="panel activity-panel">
              <div className="panel-heading compact"><div><div className="panel-kicker">AUDIT TRAIL / SESSION</div><h2>Recent events</h2></div><span className="event-count">{eventSummary.alerts} ALERTS</span></div>
              <div className="full-event-list">{feed.slice(-8).reverse().map(item => <EventRow key={item.id} item={item} />)}</div>
            </div>
            <div className="panel build-panel">
              <div className="panel-heading compact"><div><div className="panel-kicker">BUILD STATUS</div><h2>Prototype boundaries</h2></div><Gauge size={18} className="heading-icon" /></div>
              <div className="build-check"><CheckCircle2 size={16} /><span>Interactive ATM and virtual cash state</span><span className="build-status done">READY</span></div>
              <div className="build-check"><CheckCircle2 size={16} /><span>Local USB serial bridge scaffold</span><span className="build-status done">READY</span></div>
              <div className="build-check pending"><CircleDot size={16} /><span>Final Uno ↔ ESP32 monitoring protocol</span><span className="build-status next">NEXT</span></div>
              <div className="build-check pending"><CircleDot size={16} /><span>Hardware-backed integrity detection</span><span className="build-status next">NEXT</span></div>
              <div className="build-note">The baseline/protected comparison is presently a software model, not a claim of verified hardware compromise detection.</div>
            </div>
          </section>

          <footer className="page-footer"><div><ShieldCheck size={15} /><span>SENTINEL ATM GUARDIAN</span><span className="footer-divider">/</span><span>LOCAL EDUCATIONAL PROTOTYPE</span></div><span>v0.1.0 · ATM SIMULATOR FIRST</span></footer>
        </div>
      </main>
    </div>
  );
}

function EventRow({ item }: { item: FeedItem }) {
  const Icon = item.kind === 'success' ? CheckCircle2 : item.kind === 'warning' ? CircleAlert : item.kind === 'danger' ? AlertOctagon : Terminal;
  return (
    <div className={'event-row event-' + item.kind}>
      <div className="event-icon"><Icon size={15} /></div>
      <div className="event-copy"><strong>{item.title}</strong><span>{item.detail}</span></div>
      <time>{item.time}</time>
    </div>
  );
}
