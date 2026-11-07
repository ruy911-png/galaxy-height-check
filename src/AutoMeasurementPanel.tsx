import { useEffect, useRef, useState } from 'react';
import { ArDiagnostic, type ArPhase, type ArUpdate } from './arDiagnostic';
import { AutoHeightMeasurement, type AutoReading } from './autoMeasurement';
import type { MeasurementPanelProps } from './MeasurementPanel';

const emptyReading = (): AutoReading => ({ status: 'searching', reason: 'missing-both', result: null, progress: 0 });
const terminal: ArPhase[] = ['ended', 'reset', 'error'];
const interrupted: ArPhase[] = ['starting', 'tracking-lost', 'paused', 'reset', 'error', 'stopping', 'ended'];

function guidance(reading: AutoReading): string {
  const { reason, status } = reading;
  if (status === 'ready') return '위 표시는 실제 천장, 아래 표시는 실제 바닥에 있는지 확인해 주세요.';
  if (reason === 'missing-ceiling') return '위쪽 천장의 표면 신호를 기다려요. 천장이 위 표시까지 들어오게 구도를 바꿔 주세요.';
  if (reason === 'missing-floor') return '아래쪽 바닥의 표면 신호를 기다려요. 가구가 가리지 않는 바닥을 보여 주세요.';
  if (reason.startsWith('ceiling:')) return '위쪽 표시가 벽이나 문틀에 걸렸는지 확인하고, 실제 천장이 보이도록 구도를 바꿔 주세요.';
  if (reason.startsWith('floor:')) return '아래쪽 표시가 벽이나 가구에 걸렸는지 확인하고, 발을 딛는 바닥을 보여 주세요.';
  if (status === 'stabilizing') return reason === 'height-moved'
    ? '읽은 높이가 바뀌었어요. 두 표시를 같은 면에 두고 잠시 유지해 주세요.'
    : '두 곳의 표면 신호를 함께 읽고 있어요. 이 구도를 잠시 유지해 주세요.';
  if (status === 'blocked') return '두 곳의 현재 위치를 함께 확인하지 못했어요. 이전 값은 지우고 다시 읽고 있어요.';
  return '위 표시에 천장, 아래 표시에 바닥이 함께 보이게 해 주세요. 벽 쪽을 천천히 비추면 자동으로 읽어요.';
}

function FramingDiagram() {
  return <svg className="auto-framing-diagram" viewBox="0 0 340 218" role="img" aria-label="천장과 바닥을 한 화면에 담는 구도 예시: 위 표시는 천장, 아래 표시는 바닥">
    <rect x="4" y="4" width="332" height="210" rx="16" fill="#edf2e7" stroke="#bdcdb6" />
    <path d="M4 4H336L299 61H41Z" fill="#fafaf3" />
    <path d="M41 61H299V161H41Z" fill="#e0e7d8" />
    <path d="M4 214H336L299 161H41Z" fill="#d3debd" />
    <path d="M4 4L41 61V161L4 214M336 4L299 61V161L336 214M41 61H299M41 161H299" fill="none" stroke="#a0b08e" />
    <rect x="222" y="89" width="41" height="72" rx="2" fill="#c4d0ba" stroke="#91a581" />
    <circle cx="253" cy="126" r="2" fill="#698461" />
    {[44, 174].map(y => <g key={y} stroke="#2c7354" fill="none" strokeWidth="2"><circle cx="170" cy={y} r="14" /><path d={`M164 ${y}H176M170 ${y - 6}V${y + 6}`} /></g>)}
    <text x="195" y="48" fill="#31563e" fontSize="13">실제 천장</text>
    <text x="195" y="178" fill="#31563e" fontSize="13">실제 바닥</text>
    <text x="111" y="112" fill="#53694b" fontSize="13" textAnchor="middle">가리지 않는 벽 쪽</text>
    <text x="111" y="132" fill="#718369" fontSize="11" textAnchor="middle">두 곳을 한 화면에</text>
  </svg>;
}

export default function AutoMeasurementPanel({ supported, blocked = false, onBeforeStart, onActivityChange }: MeasurementPanelProps) {
  const [active, setActive] = useState(false);
  const [closing, setClosing] = useState(false);
  const [phase, setPhase] = useState<ArPhase>('idle');
  const [reading, setReading] = useState<AutoReading>(emptyReading);
  const [message, setMessage] = useState('평평한 바닥과 천장이 함께 보이는 실내에서 사용해 주세요.');
  const [signals, setSignals] = useState({ floor: false, ceiling: false });
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ArDiagnostic | null>(null);
  const controller = useRef(new AutoHeightMeasurement());
  const closingRef = useRef(false);
  const callbacks = useRef({ onBeforeStart, onActivityChange });
  callbacks.current = { onBeforeStart, onActivityChange };

  useEffect(() => () => {
    const engine = engineRef.current;
    engineRef.current = null;
    controller.current.reset();
    void engine?.stop();
    callbacks.current.onActivityChange(false);
  }, []);

  function clearReading() {
    controller.current.reset();
    setReading(emptyReading());
    setSignals({ floor: false, ceiling: false });
  }

  async function stop() {
    const engine = engineRef.current;
    if (!engine || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    clearReading();
    try { await engine.stop(); }
    finally {
      closingRef.current = false;
      setClosing(false);
      // Native end may fail. Only a terminal update releases the session lock.
    }
  }

  function start() {
    if (!supported || blocked || closingRef.current || engineRef.current || !hostRef.current || !overlayRef.current) return;
    callbacks.current.onBeforeStart();
    clearReading();
    setActive(true);
    callbacks.current.onActivityChange(true);
    const engine = new ArDiagnostic({
      host: hostRef.current,
      overlay: overlayRef.current,
      measurementMode: 'single-view',
      onUpdate(update: ArUpdate) {
        if (engineRef.current !== engine) return;
        setPhase(update.phase);
        if (interrupted.includes(update.phase)) {
          clearReading();
          setMessage(update.phase === 'tracking-lost' || update.phase === 'paused'
            ? '위치 추적이 끊겨 표시값을 지웠어요. 밝은 벽 주변을 천천히 비춰 주세요.'
            : update.message);
          if (terminal.includes(update.phase)) {
            setActive(false);
            engineRef.current = null;
            callbacks.current.onActivityChange(false);
          }
          return;
        }
        const now = performance.now();
        const pair = engine.getCurrentPair();
        const next = controller.current.update(pair, now);
        setReading(next);
        setMessage(update.phase === 'searching' && !pair.floor && !pair.ceiling ? update.message : guidance(next));
        setSignals({
          floor: !!pair.floor && now >= pair.floor.timestamp && now - pair.floor.timestamp <= 250,
          ceiling: !!pair.ceiling && now >= pair.ceiling.timestamp && now - pair.ceiling.timestamp <= 250,
        });
      },
    });
    engineRef.current = engine;
    // requestSession stays within the original tap's user activation.
    void engine.start();
  }

  function reread() {
    clearReading();
    setMessage('이전 값을 지웠어요. 천장과 바닥이 함께 보이는 구도를 잠시 유지해 주세요.');
  }

  const cm = reading.result ? Math.round(reading.result.centimeters) : null;
  return <>
    <section className="measurement-card auto-measurement-card" aria-label="수직 높이 측정">
      <div className="measurement-heading"><span className="measurement-icon" aria-hidden="true">↕</span><div><p className="eyebrow">바닥에서 천장까지</p><h2>한 화면에서 자동 계산</h2></div><span className="accuracy-pill">정확도 미검증</span></div>
      {!active && <>
        <FramingDiagram />
        <ol className="auto-instructions">
          <li><b>가구가 가리지 않는 벽 쪽</b>을 선택해 주세요. 빈방일 필요는 없어요.</li>
          <li>휴대폰으로 벽 쪽을 비추고 <b>천장과 바닥을 한 화면에</b> 담아 주세요. 뒤쪽에 안전한 공간이 있을 때만 물러나세요.</li>
          <li><b>위 표시에는 천장, 아래 표시에는 바닥</b>이 보이게 잠시 유지하면 자동으로 계산해요. 지정 버튼은 누르지 않아요.</li>
        </ol>
        <p className="auto-limitation">창문 유리나 문틀 대신 그 주변의 실제 바닥·천장을 보여 주세요. 두 곳이 함께 보이지 않는 좁은 방이나, 표면 인식이 안 되는 곳에서는 이 방식으로 측정할 수 없어요.</p>
        <p className="auto-limitation">가구·문틀·창틀은 자동 구분하지 못해요. 표시가 실제 바닥·천장에 있는지 확인해 주세요.</p>
      </>}
      <button className="primary-button" onClick={start} disabled={!supported || blocked || active || closing}>높이 측정 시작</button>
      {!supported && <p className="button-note">아래 AR 지원 확인을 먼저 살펴봐 주세요.</p>}
      <p className="measurement-status" role="status">{active ? '한 화면에서 두 곳을 함께 읽고 있어요.' : message}</p>
    </section>
    <div ref={hostRef} className="xr-canvas-host" aria-hidden="true" />
    <div ref={overlayRef} className={`xr-overlay auto-measurement-overlay ${active ? 'xr-open' : ''} ${phase === 'starting' ? 'xr-starting' : ''}`}>
      {active && <>
        <div className="xr-top"><span className="xr-pill">한 화면 자동 · 정확도 미검증</span><button className="exit-button" aria-label="높이 측정 종료" disabled={closing} onClick={() => void stop()}>종료 ✕</button></div>
        <div className={`auto-target auto-target-ceiling ${signals.ceiling ? 'has-signal' : ''}`} aria-label="위쪽 천장 표시"><span className="auto-target-cross" aria-hidden="true">+</span><span className="auto-target-label">천장이 보이게<small>{signals.ceiling ? '표면 신호 있음' : '표면 찾는 중'}</small></span></div>
        <div className={`auto-target auto-target-floor ${signals.floor ? 'has-signal' : ''}`} aria-label="아래쪽 바닥 표시"><span className="auto-target-cross" aria-hidden="true">+</span><span className="auto-target-label">바닥이 보이게<small>{signals.floor ? '표면 신호 있음' : '표면 찾는 중'}</small></span></div>
        <div className="auto-feedback" aria-live="polite">
          {reading.result ? <>
            <p className="auto-result-label">두 표면 사이 · 자동 계산(참고값)</p>
            <strong className="auto-result-meters">{(cm! / 100).toFixed(2)} m</strong><span className="auto-result-cm">{cm} cm</span>
          </> : <h2>{reading.status === 'stabilizing' ? '잠시 유지해 주세요' : '천장과 바닥을 함께 보여 주세요'}</h2>}
          <p className="auto-guidance" role="status">{message}</p>
          {reading.status === 'stabilizing' && <progress aria-label="연속 표면 신호 확인" value={reading.progress} max={1} />}
          <p className="auto-caveat">가구·문틀·창틀은 자동 구분하지 못해요.</p>
          <button className="auto-reread" onClick={reread} disabled={closing || phase === 'starting' || phase === 'stopping'}>다시 읽기</button>
        </div>
      </>}
    </div>
  </>;
}
