import { useEffect, useRef, useState } from 'react';
import { ArDiagnostic, type ArPhase, type ArUpdate } from './arDiagnostic';
import { HeightMeasurement, type HeightResult, type MeasurementStep } from './measurement';

export interface MeasurementPanelProps {
  supported: boolean;
  blocked?: boolean;
  onBeforeStart: () => void;
  onActivityChange: (active: boolean) => void;
}

const issues: Record<string, string> = {
  'no-hit': '현재 표면을 찾지 못했어요. 원이 다시 나타날 때까지 천천히 움직여 주세요.',
  'invalid-hit': '위치 정보를 확인하지 못했어요. 표면을 다시 비춰 주세요.',
  'stale-hit': '위치 정보가 오래됐어요. 현재 표면을 다시 찾아 주세요.',
  'future-hit': '위치 정보의 시간이 맞지 않아요. AR을 종료하고 다시 시작해 주세요.',
  'non-horizontal': '벽 대신 실제 바닥이나 천장을 비춰 주세요. 많이 기울어진 면은 지정할 수 없어요.',
  'floor-not-below-camera': '휴대폰 아래의 실제 바닥을 비춰 주세요. 탁자나 의자는 바닥으로 지정하지 마세요.',
  'ceiling-not-above-camera': '휴대폰 위의 실제 천장을 비춰 주세요.',
  'ceiling-not-above-floor': '천장 지점이 바닥보다 높지 않아요. 천장을 다시 맞춰 주세요.',
  'coordinate-space-changed': '위치 기준이 바뀌어 이전 바닥을 지웠어요. 바닥부터 다시 지정해 주세요.',
  'already-complete': '측정이 끝났어요. 다시 측정을 눌러 새로 시작해 주세요.',
};

const interrupted: ArPhase[] = ['tracking-lost', 'paused', 'reset', 'error'];
const terminal: ArPhase[] = ['ended', 'reset', 'error'];

export default function MeasurementPanel({ supported, blocked = false, onBeforeStart, onActivityChange }: MeasurementPanelProps) {
  const [active, setActive] = useState(false);
  const [closing, setClosing] = useState(false);
  const [phase, setPhase] = useState<ArPhase>('idle');
  const [step, setStep] = useState<MeasurementStep>('floor');
  const [canConfirm, setCanConfirm] = useState(false);
  const [message, setMessage] = useState('실내에서 실제 바닥과 그 위 천장을 차례로 지정해 주세요.');
  const [result, setResult] = useState<HeightResult | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ArDiagnostic | null>(null);
  const controller = useRef(new HeightMeasurement());
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

  async function stop() {
    const engine = engineRef.current;
    if (!engine || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    try { await engine.stop(); }
    finally {
      closingRef.current = false;
      setClosing(false);
      // Keep the screen/session until a native terminal update arrives. A
      // rejected native end may resolve this attempt while AR is still alive.
    }
  }

  function start() {
    if (!supported || blocked || closingRef.current || engineRef.current || !hostRef.current || !overlayRef.current) return;
    callbacks.current.onBeforeStart();
    controller.current.reset();
    setResult(null);
    setStep('floor');
    setCanConfirm(false);
    setActive(true);
    callbacks.current.onActivityChange(true);
    const engine = new ArDiagnostic({
      host: hostRef.current,
      overlay: overlayRef.current,
      onUpdate(update: ArUpdate) {
        if (engineRef.current !== engine) return;
        setPhase(update.phase);
        if (interrupted.includes(update.phase)) {
          controller.current.invalidate();
          setStep('floor');
          setMessage('이전 바닥 기록을 지웠어요. 바닥부터 다시 지정해 주세요. ' + update.message);
        } else setMessage(update.message);

        if (terminal.includes(update.phase)) {
          controller.current.invalidate();
          setStep('floor');
          setCanConfirm(false);
          setActive(false);
          engineRef.current = null;
          callbacks.current.onActivityChange(false);
          return;
        }

        // A native visibility transition may change the coordinate epoch before
        // its interruption status reaches this UI. Compare live provenance even
        // when the displayed confirm button is disabled, so recovery cannot stick.
        const hit = engine.getCurrentHit();
        const floor = controller.current.getState().floor;
        const coordinateChanged = !!(floor && hit && (floor.sessionId !== hit.sessionId || floor.epoch !== hit.epoch));
        if (coordinateChanged) {
          controller.current.invalidate();
          setStep('floor');
          setMessage(issues['coordinate-space-changed']);
        }
        const allowed = update.canConfirm && controller.current.canConfirm(hit, performance.now());
        setCanConfirm(allowed);
        if (update.phase === 'surface' && !allowed && !coordinateChanged && controller.current.getState().step !== 'result') {
          setMessage(controller.current.getState().step === 'floor'
            ? '원은 실제 바닥에 맞춰 주세요. 휴대폰 아래의 수평면이 필요해요.'
            : '원은 실제 천장에 맞춰 주세요. 휴대폰 위의 수평면이 필요해요.');
        }
      },
    });
    engineRef.current = engine;
    // All preparation above is synchronous so the user's tap remains active.
    void engine.start();
  }

  function confirm() {
    const engine = engineRef.current;
    if (!engine || closingRef.current) return;
    const current = engine.getCurrentHit();
    const outcome = controller.current.confirm(current, performance.now());
    setStep(controller.current.getState().step);
    if (!outcome.ok) {
      setMessage(issues[outcome.reason] ?? '표면을 다시 확인해 주세요.');
      setCanConfirm(controller.current.canConfirm(engine.getCurrentHit(), performance.now()));
      return;
    }
    if (outcome.result) {
      // This immutable, completed result is historical. End/reset events clear
      // the controller's live coordinates, never combine them into a new run.
      setResult(outcome.result);
      setCanConfirm(false);
      void stop();
    } else {
      setMessage('바닥을 기록했어요. 같은 자리에서 천천히 위로 기울여 천장을 비춰 주세요.');
      setCanConfirm(controller.current.canConfirm(engine.getCurrentHit(), performance.now()));
    }
  }

  const roundedCm = result ? Math.round(result.centimeters) : null;
  return <>
    <section className="measurement-card" aria-label="수직 높이 측정">
      <div className="measurement-heading"><span className="measurement-icon" aria-hidden="true">↕</span><div><p className="eyebrow">바닥에서 천장까지</p><h2>수직 높이 측정</h2></div><span className="accuracy-pill">정확도 미검증</span></div>
      {result ? <div className="measurement-result" aria-live="polite">
        <p className="result-label">지정한 두 표면의 수직 높이</p>
        <strong className="result-meters">{(roundedCm! / 100).toFixed(2)} m</strong>
        <span className="result-centimeters">{roundedCm} cm</span>
        <p className="result-provenance">카메라의 표면 인식 위치로 계산했어요.<br />실제 줄자와의 차이는 아직 검증하지 않았어요.</p>
        {result.lateralMeters > 0.5 && <p className="offset-note">두 지점이 옆으로 {result.lateralMeters.toFixed(1)}m 떨어져 있어요. 천장 높이가 달라지는 곳에서는 바닥 바로 위의 천장을 맞춰 다시 측정해 주세요.</p>}
        <button className="primary-button" onClick={start} disabled={!supported || blocked || active || closing}>다시 측정</button>
      </div> : <>
        <div className="measurement-flow" aria-label="측정 순서"><span><b>1</b>바닥 지정</span><i aria-hidden="true">→</i><span><b>2</b>천장 지정</span><i aria-hidden="true">→</i><span><b>3</b>높이 확인</span></div>
        <p className="measurement-intro">실제 바닥과 천장에 원을 맞추고 눌러 주세요.<br />카메라 영상은 휴대폰 안에서 처리해요.</p>
        <button className="primary-button" onClick={start} disabled={!supported || blocked || active || closing}>높이 측정 시작</button>
        {!supported && <p className="button-note">아래 AR 지원 확인을 먼저 살펴봐 주세요.</p>}
      </>}
      <p className="measurement-status" role="status">{active ? 'AR 카메라에서 측정하고 있어요.' : result ? '측정 완료 · 표시값은 참고용입니다.' : message}</p>
    </section>

    <div ref={hostRef} className="xr-canvas-host" aria-hidden="true" />
    <div ref={overlayRef} className={`xr-overlay measurement-overlay ${active ? 'xr-open' : ''} ${phase === 'starting' ? 'xr-starting' : ''}`}>
      {active && <>
        <div className="xr-top"><span className="xr-pill">높이 측정 · 정확도 미검증</span><button className="exit-button" aria-label="높이 측정 종료" onClick={() => void stop()}>종료 ✕</button></div>
        <div className="xr-aim" aria-hidden="true">+</div>
        <div className="xr-panel">
          <p className="eyebrow">{step === 'floor' ? '01 / 바닥 지정' : step === 'ceiling' ? '02 / 천장 지정' : '03 / 측정 완료'}</p>
          <h2>{step === 'floor' ? '실제 바닥에 원을 맞춰요' : step === 'ceiling' ? '그 위 천장에 원을 맞춰요' : 'AR을 종료하고 있어요'}</h2>
          <p role="status">{message}</p>
          {step !== 'result' && <>
            <p className="xr-small">{step === 'floor' ? '탁자나 의자가 아닌, 발을 딛는 바닥을 비춰 주세요.' : '바닥 바로 위 천장을 비춰 주세요. 조명 기구는 피해주세요.'}</p>
            <button className="primary-button" disabled={!canConfirm || closing} onClick={confirm}>{step === 'floor' ? '바닥 지정' : '천장 지정'}</button>
          </>}
          <small>표면이 보이지 않으면 높이값을 만들지 않아요.</small>
        </div>
      </>}
    </div>
  </>;
}
