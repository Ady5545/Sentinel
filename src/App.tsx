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

type View = 'terminal' | 'machine' | 'sentinel' | 'experiments' | 'journal' | 'hardware';
type DeviceKey = 'uno' | 'sentinel';
type Port = { path: string; manufacturer?: string; vendorId?: string; productId?: string; serialNumber?: string };
type BoardState = { connected: boolean; path: string; lastLine: string; error?: string };
const serviceList: { id: Service; label: string; subtitle: string; icon: typeof Banknote }[] = [
  { id: 'withdrawal', label: 'Cash withdrawal', subtitle: 'Dispense virtual banknotes', icon: Banknote },
  { id: 'balance', label: 'Balance inquiry', subtitle: 'View available funds', icon: WalletCards },
  { id: 'statement', label: 'Mini statement', subtitle: 'Recent synthetic transactions', icon: FileText },
  { id: 'transfer', label: 'Funds transfer', subtitle: 'Fictional beneficiary only', icon: ArrowRight },
  { id: 'pin-change', label: 'PIN services', subtitle: 'Demonstration only', icon: LockKeyhole }
];
const initialBoards: Record<DeviceKey, BoardState> = {
  uno: { connected: false, path: '', lastLine: '' },
  sentinel: { connected: false, path: '', lastLine: '' }
};
const money = (value: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
const clock = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export default function App() {
  const [state, dispatch] = useReducer(atmReducer, undefined, () => initialAtmState('protected'));
  const [view, setView] = useState<View>('terminal');
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [ports, setPorts] = useState<Port[]>([]);
  const [chosenPort, setChosenPort] = useState<Record<DeviceKey, string>>({ uno: '', sentinel: '' });
  const [boards, setBoards] = useState<Record<DeviceKey, BoardState>>(initialBoards);
  const [runtime, setRuntime] = useState<{ platform: string; version: string; packaged: boolean } | null>(null);
  const [serialEvents, setSerialEvents] = useState<string[]>([]);
  const [portMessage, setPortMessage] = useState('Board access is optional. The virtual ATM works without hardware.');

  useEffect(() => {
    const api = window.sentinelDesktop;
    if (!api) return;
    void api.getRuntimeInfo().then(setRuntime).catch(() => undefined);
    void api.listSerialPorts().then(result => setPorts(result.ports)).catch(() => undefined);
    const unsubscribe = api.onSerialEvent(event => {
      const detail = event.kind === 'line' ? event.line : event.message || event.kind;
      setSerialEvents(previous => [...previous.slice(-79), clock() + '  ' + event.device.toUpperCase() + '  ' + detail]);
      setBoards(previous => ({
        ...previous,
        [event.device]: {
          ...previous[event.device],
          connected: event.kind === 'opened' || event.kind === 'line',
          path: event.path || previous[event.device].path,
          lastLine: event.kind === 'line' ? event.line : previous[event.device].lastLine,
          error: event.kind === 'error' ? event.message : undefined
        }
      }));
      if (event.kind === 'error') setPortMessage(event.message || 'USB serial error.');
    });
    return unsubscribe;
  }, []);

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
  const eventCount = state.events.length;
  const alerts = state.events.filter(event => event.severity === 'warning' || event.severity === 'critical').length;
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
    if (response.ok) setBoards(previous => ({ ...previous, [device]: { ...previous[device], connected: true, path } }));
  };
  const disconnectBoard = async (device: DeviceKey) => {
    if (!window.sentinelDesktop) return;
    await window.sentinelDesktop.disconnectBoard(device);
    setBoards(previous => ({ ...previous, [device]: { ...previous[device], connected: false, path: '' } }));
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
        {view === 'journal' && <JournalView events={[...state.events].reverse()} alerts={alerts} />}
        {view === 'hardware' && <HardwareView ports={ports} chosenPort={chosenPort} setChosenPort={setChosenPort} boards={boards} message={portMessage} serialEvents={serialEvents} refresh={refreshPorts} connect={connectBoard} disconnect={disconnectBoard} />}
        <footer className="status-footer"><span><i /> DOMAIN CORE ACTIVE</span><span>{eventCount.toString().padStart(3,'0')} EVENTS · {alerts.toString().padStart(2,'0')} ALERTS</span><span>FICTIONAL ACCOUNT · VIRTUAL CASH · RESEARCH PROTOTYPE</span></footer>
      </div>
    </main>
    </div>
    {launcherOpen && <div className="os-launcher-backdrop" onClick={() => setLauncherOpen(false)}><section className="os-launcher" onClick={event => event.stopPropagation()}><div className="os-launcher-heading"><div className="os-launcher-emblem"><ShieldCheck size={22} /></div><div><strong>SENTINEL WORKSPACE</strong><small>LOCAL SECURITY RESEARCH SYSTEM</small></div></div><label className="os-searchbox"><Activity size={16} /><span>Choose a workspace module</span><kbd>ESC</kbd></label><div className="os-app-grid">{appItems.map(item => { const Icon=item.icon; return <button key={item.id} className="os-app-tile" onClick={() => navigateTo(item.id)}><span className="os-app-icon"><Icon size={20} /></span><strong>{item.label}</strong><small>{item.detail}</small></button>; })}</div><div className="os-launcher-footer"><span><i /> ALL SYSTEMS LOCAL</span><span>NO CLOUD ACCOUNT REQUIRED</span></div></section></div>}
    {commandOpen && <div className="os-command-backdrop" onClick={() => setCommandOpen(false)}><section className="os-command" onClick={event => event.stopPropagation()}><div className="os-command-input"><Activity size={18} /><input autoFocus value={commandQuery} onChange={event => setCommandQuery(event.target.value)} placeholder="Search modules and commands…" /><kbd>ESC</kbd></div><div className="os-command-results">{appItems.filter(item => (item.label + ' ' + item.detail).toLowerCase().includes(commandQuery.toLowerCase())).map(item => { const Icon=item.icon; return <button key={item.id} onClick={() => navigateTo(item.id)}><Icon size={17} /><span><strong>{item.label}</strong><small>{item.detail}</small></span><kbd>OPEN</kbd></button>; })}{appItems.every(item => !(item.label + ' ' + item.detail).toLowerCase().includes(commandQuery.toLowerCase())) && <p>No matching workspace module.</p>}</div><div className="os-command-footer">COMMAND PALETTE <span>Navigate · Open modules · Escape to close</span></div></section></div>}
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
    <ScreenHeading number="01" eyebrow="CUSTOMER ENVIRONMENT" title="ATM terminal" description="Run a fictional customer session. Controller integrity and dispenser authority are enforced by the domain model." action={<button className="quiet-button" onClick={cancel}><RotateCcw size={14} /> End session</button>} />
    <div className="terminal-layout">
      <section className="terminal-hardware">
        <div className="hardware-label"><span>ATM UNIT / ATM-001</span><span>MODEL PROFILE 01</span></div>
        <div className="terminal-bezel">
          <div className="terminal-brand"><div className="terminal-brand-symbol"><ShieldCheck size={19} /></div><div><strong>NORTHSTAR</strong><small>DEMO BANKING SYSTEM</small></div><span className="terminal-indicator"><i /> ONLINE</span></div>
          <div className="terminal-screen">
            {state.screen === 'welcome' && <div className="customer-screen welcome-screen"><div className="screen-kicker">AUTOMATED TELLER TERMINAL</div><div className="welcome-symbol"><Landmark size={32} /></div><h2>Welcome</h2><p>Insert your demo card to begin a simulated session.</p><div className="account-preview"><span>DEMO ACCOUNT</span><strong>{state.accountId}</strong><small>Fictional account · no bank connected</small></div><button className="primary-action" onClick={() => dispatch({ type: 'INSERT_CARD' })}><WalletCards size={16} /> Insert virtual card <ArrowRight size={15} /></button></div>}
            {state.screen === 'pin' && <div className="customer-screen pin-screen"><div className="screen-kicker">CUSTOMER VERIFICATION</div><h2>Enter your PIN</h2><p>Use the keypad. Input is masked and never logged.</p><div className="pin-dots" aria-label={pinEntry.length + ' of 4 digits entered'}>{[0,1,2,3].map(i => <span key={i} className={i < pinEntry.length ? 'filled' : ''} />)}</div><div className="keypad">{['1','2','3','4','5','6','7','8','9','CLEAR','0','ENTER'].map(key => <button key={key} className={'key ' + (key === 'ENTER' ? 'enter-key' : key === 'CLEAR' ? 'clear-key' : '')} onClick={() => { if (key === 'ENTER') submitPin(); else if (key === 'CLEAR') { setPinEntry(''); dispatch({ type: 'PIN_CLEAR' }); } else enterPin(key); }}>{key}</button>)}</div><button className="screen-link" onClick={cancel}>Cancel and return card</button></div>}
            {state.screen === 'menu' && <div className="customer-screen menu-screen"><div className="screen-kicker">SESSION AUTHENTICATED · {state.accountId}</div><h2>Choose a service</h2><p>All operations run against fictional local state.</p><div className="service-list">{serviceList.map(service => { const Icon = service.icon; return <button className="service-button" key={service.id} onClick={() => dispatch({ type: 'SELECT_SERVICE', service: service.id })}><span className="service-icon"><Icon size={17} /></span><span><strong>{service.label}</strong><small>{service.subtitle}</small></span><ChevronRight size={15} /></button>; })}</div><button className="screen-link" onClick={cancel}>Cancel session</button></div>}
            {state.screen === 'amount' && <div className="customer-screen amount-screen"><div className="screen-kicker">{state.service === 'transfer' ? 'LOCAL TRANSFER DEMONSTRATION' : 'CASH WITHDRAWAL'}</div><h2>{state.service === 'transfer' ? 'Transfer amount' : 'Select an amount'}</h2><p>{state.service === 'transfer' ? 'Fictional beneficiary DEMO-2042; no network is used.' : 'Amount is checked against account and cassette state.'}</p><div className="amount-grid">{[500,1000,2000,5000].map(amount => <button key={amount} onClick={() => dispatch({ type: 'SELECT_AMOUNT', amount })} className={state.selectedAmount === amount ? 'amount-pick selected' : 'amount-pick'}>{money(amount)}</button>)}</div><div className="amount-selected"><span>SELECTED AMOUNT</span><strong>{money(state.selectedAmount)}</strong></div><button className="primary-action" onClick={() => dispatch({ type: 'CONFIRM_AMOUNT' })}>{state.service === 'transfer' ? 'Confirm local transfer' : 'Request cash dispense'} <ArrowRight size={15} /></button><button className="screen-link" onClick={() => dispatch({ type: 'RETURN_TO_MENU' })}>Back to services</button></div>}
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

function JournalView({ events, alerts }: { events: JournalEvent[]; alerts: number }) {
  return <>
    <ScreenHeading number="05" eyebrow="TRACEABLE RUN HISTORY" title="Event journal" description="Controller observations, policy findings and actual virtual-gate outcomes." />
    <div className="journal-stats"><div><span>RECORDED EVENTS</span><strong>{events.length.toString().padStart(3,'0')}</strong></div><div><span>ALERT / WARNING EVENTS</span><strong>{alerts.toString().padStart(3,'0')}</strong></div><div><span>DATA PROVENANCE</span><strong>SIMULATION</strong></div></div>
    <div className="journal-list">{events.length === 0 ? <div className="empty-state">No events in this run.</div> : events.map(event => <JournalRow key={event.id} event={event} />)}</div>
  </>;
}
function JournalRow({ event }: { event: JournalEvent }) {
  const icon = event.severity === 'critical' ? <XOctagon size={15} /> : event.severity === 'warning' ? <CircleAlert size={15} /> : event.severity === 'success' ? <CheckCircle2 size={15} /> : <Terminal size={15} />;
  return <article className={'journal-row severity-' + event.severity}><div className="journal-icon">{icon}</div><time>{event.at}</time><div className="journal-copy"><strong>{event.title}</strong><p>{event.detail}</p><small>{event.source} · {event.id}</small></div><span className="severity-tag">{event.severity.toUpperCase()}</span></article>;
}

function HardwareView({ ports, chosenPort, setChosenPort, boards, message, serialEvents, refresh, connect, disconnect }: {
  ports: Port[]; chosenPort: Record<DeviceKey, string>;
  setChosenPort: Dispatch<SetStateAction<Record<DeviceKey, string>>>;
  boards: Record<DeviceKey, BoardState>; message: string; serialEvents: string[];
  refresh: () => void; connect: (device: DeviceKey) => void; disconnect: (device: DeviceKey) => void;
}) {
  return <>
    <ScreenHeading number="06" eyebrow="HARDWARE-IN-THE-LOOP" title="Board bench" description="Native USB serial observation for the existing Arduino Uno and ESP32. The ATM model needs no boards." action={<button className="quiet-button" onClick={refresh}><RotateCcw size={14} /> Scan ports</button>} />
    <div className="hardware-notice"><CircleAlert size={16} /><p>{message}<br /><strong>Close Arduino IDE Serial Monitor before connecting the same port.</strong> Console output is observation, not proof of firmware integrity.</p></div>
    <div className="board-grid">{(['uno','sentinel'] as DeviceKey[]).map((device,index) => {
      const board = boards[device];
      return <section className="board-card" key={device}><div className="board-top"><div className={'board-symbol ' + device}>{device === 'uno' ? <Cpu size={22} /> : <ShieldCheck size={22} />}</div><div><small>DEVICE 0{index+1}</small><h2>{device === 'uno' ? 'Arduino Uno' : 'SENTINEL ESP32'}</h2><p>{device === 'uno' ? 'Primary ATM control microcontroller' : 'Independent guardian controller'}</p></div><span className={'board-status ' + (board.connected ? 'connected' : '')}><i />{board.connected ? 'CONNECTED' : 'DISCONNECTED'}</span></div><label className="field-label" htmlFor={'port-'+device}>USB SERIAL PORT</label><select id={'port-'+device} value={chosenPort[device]} disabled={board.connected} onChange={event => setChosenPort(previous => ({ ...previous, [device]: event.target.value }))}><option value="">Select a port</option>{ports.map(port => <option key={port.path} value={port.path}>{port.path}{port.manufacturer ? ' · ' + port.manufacturer : ''}</option>)}</select><div className="board-meta"><span>LAST SERIAL LINE</span><strong>{board.lastLine || 'Waiting for serial data'}</strong></div>{board.error && <p className="error-line">{board.error}</p>}<button className={'board-button ' + (board.connected ? 'disconnect' : '')} onClick={() => board.connected ? disconnect(device) : connect(device)} disabled={!board.connected && !chosenPort[device]}>{board.connected ? <><XOctagon size={15} /> Disconnect board</> : <><Plug size={15} /> Connect USB console</>}</button></section>;
    })}</div>
    <section className="data-panel serial-log"><PanelTitle icon={<Terminal size={16} />} title="USB SERIAL OBSERVATION" suffix="TEXT ONLY" />{serialEvents.length ? serialEvents.slice(-15).reverse().map((line,index) => <p key={index}>{line}</p>) : <div className="empty-state">No serial events yet. Simulation mode remains fully available.</div>}</section>
    <div className="scientific-note"><CircleAlert size={16} /><p>This initial adapter reads USB console lines only. Framed protocol parsing and security decisions based on validated hardware messages are later milestones. No serial message alone grants dispense authority.</p></div>
  </>;
}
