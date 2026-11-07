import { useEffect, useRef, useState } from 'react';
import { ArDiagnostic, type ArPhase, type ArUpdate } from './arDiagnostic';
import { BaseTopMeasurement, type AimFrame, type BaseTopResult, type BaseTopState } from './baseTopMeasurement';
import type { MeasurementPanelProps } from './MeasurementPanel';

const interrupted: ArPhase[] = ['starting', 'tracking-lost', 'paused', 'reset', 'error', 'stopping', 'ended'];
const terminal: ArPhase[] = ['ended', 'reset', 'error'];
const estimateExplanation = '상단이 바닥 기준점을 지나는 가상의 수직면에 있다고 가정해요. 실제 천장 표면을 인식한 값은 아니에요.';
const failures: Record<string, string> = {
  'no-frame': '현재 휴대폰 위치를 확인하지 못해 기준점을 지웠어요. 바닥부터 다시 지정해 주세요.',
  'invalid-frame': '위치 정보를 확인하지 못해 기준점을 지웠어요. 바닥부터 다시 지정해 주세요.',
  'future-frame': '위치 정보의 시간이 맞지 않아요. AR을 종료하고 다시 시작해 주세요.',
  'stale-frame': '새 위치를 받지 못해 기준점을 지웠어요. 바닥부터 다시 지정해 주세요.',
  'coordinate-space-changed': '위치 기준이 바뀌어 바닥 기록을 지웠어요. 바닥부터 다시 지정해 주세요.',
  'no-hit': '아직 바닥 표면을 찾지 못했어요. 벽 바로 앞의 드러난 바닥을 천천히 비춰 주세요.',
  'invalid-hit': '현재 표면 위치를 신뢰할 수 없어요. 같은 곳을 천천히 다시 비춰 주세요.',
  'hit-frame-mismatch': '표면과 카메라 위치의 시점이 맞지 않아요. 새 위치를 기다려 주세요.',
  'non-horizontal-base': '바닥 기준점은 평평한 바닥에 맞춰 주세요. 벽면이나 가구에는 지정하지 마세요.',
  'base-not-below-camera': '발을 딛는 바닥에 조준점을 맞춰 주세요. 휴대폰보다 낮은 바닥이 필요해요.',
  'base-too-close': '발 바로 밑보다 조금 앞쪽, 벽 가까이에 보이는 바닥을 맞춰 주세요.',
  'top-not-above-base': '같은 벽의 위쪽, 벽과 천장이 만나는 경계로 휴대폰을 천천히 기울여 주세요.',
  'parallel-ray': '이 각도로는 추정하기 어려워요. 같은 벽의 천장 경계를 정면으로 비춰 주세요.',
  'behind-camera': '기준점 방향을 벗어났어요. 기준점을 정한 벽 쪽으로 다시 향해 주세요.',
  'intersection-too-far': '이 각도로는 추정이 불안정해요. 기준점을 정한 벽 쪽으로 다시 향해 주세요.',
  'invalid-intersection': '현재 방향으로 높이를 계산하지 못했어요. 같은 벽의 상단을 다시 비춰 주세요.',
  'already-complete': '측정을 마쳤어요. 다시 측정을 누르면 새로 시작해요.',
};
function issue(reason: string): string { return failures[reason] ?? '현재 위치를 다시 확인해 주세요.'; }

function UsageDiagram() {
  return <svg className="base-top-diagram" viewBox="0 0 380 198" role="img" aria-label="바닥을 지정한 뒤 위로 기울여 상단을 지정하는 두 단계 사용법">
    <g stroke="#a5b59a" strokeWidth="1.3">
      <rect x="6" y="5" width="166" height="160" rx="15" fill="#edf2e7" />
      <path d="M7 6H171V76H7Z" fill="#e1e9d9" stroke="none" />
      <path d="M7 76H171V150Q171 164 157 164H21Q7 164 7 150Z" fill="#cddbb6" stroke="none" />
      <path d="M7 76H171" />
      <rect x="208" y="5" width="166" height="160" rx="15" fill="#e1e9d9" />
      <path d="M209 20Q209 6 223 6H359Q373 6 373 20V85H209Z" fill="#fafaf1" stroke="none" />
      <path d="M209 85H373" />
    </g>
    <g fill="none" stroke="#2b7455" strokeWidth="2.5">
      <circle cx="89" cy="85" r="13" /><path d="M83 85H95M89 79V91" />
      <circle cx="291" cy="85" r="13" /><path d="M285 85H297M291 79V91" />
      <path d="M181 85H198M191 78L198 85L191 92" />
    </g>
    <g fill="#3e6249" fontSize="12" textAnchor="middle">
      <text x="89" y="43">벽을 정면으로</text>
      <text x="89" y="130">벽 바로 앞 바닥</text>
      <text x="291" y="130">같은 벽의 천장 경계</text>
      <text x="89" y="186">1. 바닥 기준점 지정</text>
      <text x="291" y="186">2. 위로 기울여 상단 지정</text>
    </g>
  </svg>;
}

function HeightValue({ value }: { value: BaseTopResult }) {
  const cm = Math.round(value.centimeters);
  return <>
    <p className={`base-top-source ${value.source === 'virtual-vertical-plane' ? 'is-estimate' : ''}`}>{value.source === 'virtual-vertical-plane' ? '추정 높이' : '표면 인식 높이'}</p>
    <strong className="base-top-meters">{(cm / 100).toFixed(2)} m</strong><span className="base-top-centimeters">{cm} cm</span>
  </>;
}

export default function BaseTopMeasurementPanel({ supported, blocked = false, onBeforeStart, onActivityChange }: MeasurementPanelProps) {
  const [active, setActive] = useState(false);
  const [closing, setClosing] = useState(false);
  const [phase, setPhase] = useState<ArPhase>('idle');
  const [step, setStep] = useState<BaseTopState['step']>('base');
  const [canConfirm, setCanConfirm] = useState(false);
  const [message, setMessage] = useState('바닥 기준점을 지정하고 같은 벽의 위쪽으로 천천히 기울여 주세요.');
  const [preview, setPreview] = useState<BaseTopResult | null>(null);
  const [result, setResult] = useState<BaseTopResult | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ArDiagnostic | null>(null);
  const controller = useRef(new BaseTopMeasurement());
  const closingRef = useRef(false);
  const callbacks = useRef({ onBeforeStart, onActivityChange });
  callbacks.current = { onBeforeStart, onActivityChange };

  useEffect(() => () => {
    const engine = engineRef.current;
    engineRef.current = null;
    controller.current.invalidate();
    void engine?.stop();
    callbacks.current.onActivityChange(false);
  }, []);

  function clearLive() {
    controller.current.invalidate();
    setStep('base');
    setCanConfirm(false);
    setPreview(null);
  }

  async function stop() {
    const engine = engineRef.current;
    if (!engine || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    clearLive();
    try { await engine.stop(); }
    finally { closingRef.current = false; setClosing(false); }
  }

  function refresh(frame: AimFrame | null, update?: ArUpdate) {
    const model = controller.current;
    let reason: string | null;
    let candidate: BaseTopResult | null = null;
    if (model.getState().step === 'top') {
      const outcome = model.preview(frame, performance.now());
      reason = outcome.ok ? null : outcome.reason;
      if (outcome.ok) candidate = outcome.result;
    } else reason = model.getRejectionReason(frame, performance.now());
    const nextStep = model.getState().step;
    setStep(nextStep);
    setPreview(candidate);
    setCanConfirm(reason === null && nextStep !== 'result');
    if (reason) setMessage(!frame && update?.phase === 'searching' ? update.message : issue(reason));
    else setMessage(nextStep === 'base'
      ? '벽 바로 앞의 실제 바닥인지 확인하고 기준점을 지정해 주세요.'
      : '같은 벽과 천장이 만나는 경계인지 확인하고 상단을 지정해 주세요.');
  }

  function start() {
    if (!supported || blocked || closingRef.current || engineRef.current || !hostRef.current || !overlayRef.current) return;
    callbacks.current.onBeforeStart();
    clearLive();
    setResult(null);
    setActive(true);
    callbacks.current.onActivityChange(true);
    const engine = new ArDiagnostic({
      host: hostRef.current,
      overlay: overlayRef.current,
      measurementMode: 'base-top',
      onUpdate(update: ArUpdate) {
        if (engineRef.current !== engine) return;
        setPhase(update.phase);
        if (interrupted.includes(update.phase)) {
          clearLive();
          setMessage(update.phase === 'tracking-lost' || update.phase === 'paused'
            ? '위치 추적이 끊겨 기준점을 지웠어요. 바닥부터 다시 지정해 주세요.' : update.message);
          if (terminal.includes(update.phase)) {
            setActive(false);
            engineRef.current = null;
            callbacks.current.onActivityChange(false);
          }
          return;
        }
        // update.canConfirm describes a direct hit. A current, tracked ray with
        // no hit is still eligible for explicitly labelled virtual-plane height.
        refresh(engine.getCurrentAimFrame(), update);
      },
    });
    engineRef.current = engine;
    void engine.start();
  }

  function confirm() {
    const engine = engineRef.current;
    if (!engine || closingRef.current) return;
    const frame = engine.getCurrentAimFrame();
    const outcome = controller.current.confirm(frame, performance.now());
    setStep(controller.current.getState().step);
    if (!outcome.ok) {
      setPreview(null);
      setCanConfirm(false);
      setMessage(issue(outcome.reason));
      return;
    }
    if (outcome.result) {
      setResult(outcome.result);
      setPreview(null);
      setCanConfirm(false);
      void stop();
    } else {
      setPreview(null);
      setCanConfirm(false);
      setMessage('바닥을 기록했어요. 같은 자리에 머물며 휴대폰을 위로 기울여, 같은 벽과 천장이 만나는 경계를 맞춰 주세요.');
    }
  }

  return <>
    <section className="measurement-card base-top-card" aria-label="수직 높이 측정">
      <div className="measurement-heading"><span className="measurement-icon" aria-hidden="true">↕</span><div><p className="eyebrow">바닥에서 천장까지</p><h2>기준점에서 위로 높이 측정</h2></div><span className="accuracy-pill">정확도 미검증</span></div>
      {result ? <div className="measurement-result base-top-result" aria-live="polite">
        <HeightValue value={result} />
        <p className="result-provenance">{result.source === 'virtual-vertical-plane' ? estimateExplanation : '지정한 두 표면 위치의 수직 높이 차이예요. 표면이 실제 바닥과 원하는 상단인지 확인해야 해요.'}</p>
        <p className="result-provenance">실제 줄자와의 차이는 아직 검증하지 않았어요.</p>
        <button className="primary-button" disabled={!supported || blocked || active || closing} onClick={start}>다시 측정</button>
      </div> : <>
        {!active && <>
          <UsageDiagram />
          <ol className="base-top-instructions">
            <li>벽을 정면으로 보고, <b>벽 바로 앞의 드러난 바닥</b>에 조준점을 맞춘 뒤 <b>바닥 기준점 지정</b>을 눌러요.</li>
            <li>같은 자리에서 휴대폰을 천천히 위로 기울여요. <b>같은 벽과 천장이 만나는 경계</b>를 조준하고 <b>상단 지정</b>을 눌러요.</li>
          </ol>
          <p className="base-top-note">한 화면에 모두 담을 필요는 없어요. 휴대폰을 손에 들고 편하게 서거나 앉아 사용하세요.</p>
          <p className="base-top-note">상단 표면을 못 찾으면 가상의 수직면으로 계산한 <b>추정 높이</b>를 표시해요. 기준점보다 앞뒤로 떨어진 상단은 오차가 커질 수 있어요.</p>
          <p className="base-top-note">빈방일 필요는 없어요. 침대·가구·창틀·문틀은 자동으로 구분하지 못해요. 바닥과 실제 천장 경계가 가리지 않는 벽 쪽을 고르세요.</p>
        </>}
        <button className="primary-button" disabled={!supported || blocked || active || closing} onClick={start}>높이 측정 시작</button>
        {!supported && <p className="button-note">아래 AR 지원 확인을 먼저 살펴봐 주세요.</p>}
      </>}
      <p className="measurement-status" role="status">{active ? 'AR 카메라에서 기준점과 상단을 차례로 확인하고 있어요.' : result ? '측정 완료 · 정확도 미검증' : message}</p>
    </section>
    <div ref={hostRef} className="xr-canvas-host" aria-hidden="true" />
    <div ref={overlayRef} className={`xr-overlay measurement-overlay base-top-overlay ${active ? 'xr-open' : ''} ${phase === 'starting' ? 'xr-starting' : ''}`}>
      {active && <>
        <div className="xr-top"><span className="xr-pill">기준점 → 상단 · 정확도 미검증</span><button className="exit-button" aria-label="높이 측정 종료" disabled={closing} onClick={() => void stop()}>종료 ✕</button></div>
        <div className="xr-aim" aria-hidden="true">+</div>
        <div className="measurement-guide base-top-guide">
          <p className="eyebrow">{step === 'base' ? '01 / 바닥 기준점' : '02 / 상단 지정'}</p>
          <h2>{phase === 'stopping' ? '측정을 마무리하고 있어요' : step === 'base' ? '벽 바로 앞 바닥을 맞춰요' : '같은 벽의 천장 경계로 올려요'}</h2>
          <p id="base-top-guidance" role="status">{message}</p>
          {preview?.source === 'virtual-vertical-plane' && <p className="base-top-estimate-note">{estimateExplanation}</p>}
        </div>
        <div className="xr-panel measurement-actions base-top-actions">
          {preview && <div className="base-top-preview" aria-live="polite"><HeightValue value={preview} /></div>}
          <p className={`measurement-ready ${canConfirm ? 'is-ready' : ''}`}>{closing || phase === 'stopping' ? '종료를 기다리고 있어요' : canConfirm ? '● 현재 위치를 지정할 수 있어요' : '○ 위 안내를 확인해 주세요'}</p>
          <button className="primary-button" aria-describedby="base-top-guidance" disabled={!canConfirm || closing || phase === 'stopping'} onClick={confirm}>{step === 'base' ? '바닥 기준점 지정' : '상단 지정'}</button>
        </div>
      </>}
    </div>
  </>;
}
