import { useCallback, useEffect, useRef, useState } from 'react';
import { ArDiagnostic, type ArUpdate } from './arDiagnostic';
import { cameraErrorMessage, checkCompatibility, type Compatibility } from './compatibility';
import MeasurementPanel from './MeasurementPanel';

const idleAr: ArUpdate = { phase: 'idle', message: 'AR을 켠 뒤 바닥과 천장에 표면 표시가 나타나는지 확인해요.', canConfirm: false, hitCount: 0 };
type CameraStatus = 'idle' | 'opening' | 'granted' | 'error';

function Mark({ state }: { state: 'good' | 'bad' | 'waiting' }) {
  return <span className={`mark ${state}`} aria-hidden="true">{state === 'good' ? '✓' : state === 'bad' ? '!' : '·'}</span>;
}

export default function App() {
  const [compat, setCompat] = useState<Compatibility>({ secure: window.isSecureContext, cameraApi: !!navigator.mediaDevices?.getUserMedia, ar: 'checking', message: '지원 여부를 확인하고 있어요.' });
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [cameraMessage, setCameraMessage] = useState('버튼을 누르면 카메라 권한을 요청해요. 영상은 휴대폰 안에서만 처리해요.');
  const [previewOn, setPreviewOn] = useState(false);
  const [ar, setAr] = useState<ArUpdate>(idleAr);
  const [arOpen, setArOpen] = useState(false);
  const [arStopping, setArStopping] = useState(false);
  const [measurementActive, setMeasurementActive] = useState(false);
  const [target, setTarget] = useState<'floor' | 'ceiling'>('floor');
  const [observed, setObserved] = useState({ floor: false, ceiling: false });
  const [copyMessage, setCopyMessage] = useState('');
  const [showReport, setShowReport] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const removeCameraListeners = useRef<() => void>(() => {});
  const cameraRun = useRef(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const diagnosticRef = useRef<ArDiagnostic | null>(null);
  const compatRun = useRef(0);

  const refreshCompatibility = useCallback(async () => {
    const run = ++compatRun.current;
    setCompat(c => ({ ...c, ar: 'checking' }));
    const result = await checkCompatibility(window.isSecureContext, !!navigator.mediaDevices?.getUserMedia, navigator.xr);
    if (run === compatRun.current) setCompat(result);
  }, []);

  const stopCamera = useCallback(() => {
    cameraRun.current++;
    removeCameraListeners.current();
    removeCameraListeners.current = () => {};
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setPreviewOn(false);
  }, []);

  useEffect(() => {
    void refreshCompatibility();
    return () => {
      compatRun.current++;
      stopCamera();
      void diagnosticRef.current?.stop();
      diagnosticRef.current = null;
    };
  }, [refreshCompatibility, stopCamera]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        stopCamera();
        setCameraStatus(status => status === 'opening' ? 'idle' : status);
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [stopCamera]);

  async function openCamera() {
    if (measurementActive || arOpen || arStopping) return;
    stopCamera();
    const run = cameraRun.current;
    setCameraStatus('opening');
    setCameraMessage('Chrome의 카메라 권한 창에서 ‘허용’을 눌러 주세요.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      if (run !== cameraRun.current) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      const tracks = stream.getVideoTracks();
      if (!tracks.length || tracks.every(track => track.readyState === 'ended')) throw new Error('Camera stream ended');
      const onCameraEnded = () => {
        if (run !== cameraRun.current) return;
        stopCamera();
        setCameraStatus('error');
        setCameraMessage('카메라 영상이 중단됐어요. 권한을 확인하고 카메라를 다시 켜 주세요.');
      };
      tracks.forEach(track => track.addEventListener('ended', onCameraEnded));
      removeCameraListeners.current = () => tracks.forEach(track => track.removeEventListener('ended', onCameraEnded));
      if (!videoRef.current) throw new Error('Preview unavailable');
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      if (run !== cameraRun.current) return;
      setCameraStatus('granted');
      setPreviewOn(true);
      setCameraMessage('카메라 영상이 열렸어요. 이제 AR 표면 인식을 확인해 주세요.');
    } catch (error) {
      if (run !== cameraRun.current) return;
      stopCamera();
      setCameraStatus('error');
      setCameraMessage(cameraErrorMessage(error));
    }
  }

  function startAr() {
    if (!hostRef.current || !overlayRef.current || diagnosticRef.current || arStopping || measurementActive) return;
    stopCamera();
    setCameraStatus(status => status === 'opening' ? 'idle' : status);
    setObserved({ floor: false, ceiling: false });
    setTarget('floor');
    setArOpen(true);
    const diagnostic = new ArDiagnostic({
      host: hostRef.current,
      overlay: overlayRef.current,
      onUpdate(update) {
        if (diagnosticRef.current !== diagnostic) return;
        setAr(update);
        if (['tracking-lost', 'paused', 'reset', 'error'].includes(update.phase)) {
          setObserved({ floor: false, ceiling: false });
          setTarget('floor');
        }
        if (['ended', 'error', 'reset'].includes(update.phase)) {
          setArOpen(false);
          diagnosticRef.current = null;
        }
      },
    });
    diagnosticRef.current = diagnostic;
    // Do not await anything before this call: WebXR requires the tap's user activation.
    void diagnostic.start();
  }

  async function stopAr() {
    const current = diagnosticRef.current;
    setArStopping(true);
    try { await current?.stop(); }
    finally {
      // Only a terminal onUpdate can release the native session. A failed
      // session.end() must leave this screen open so the user can retry/exit.
      setArStopping(false);
    }
  }

  function confirmSurface() {
    // Recheck the latest XR frame at the moment of tapping; React UI state may lag.
    if (!diagnosticRef.current?.confirmSurface()) return;
    setObserved(previous => ({ ...previous, [target]: true }));
    if (target === 'floor') setTarget('ceiling');
  }

  const report = [
    '높이 보기 — 1단계 호환성 확인',
    '휴대폰: 갤럭시 Z 폴드7로 가정 (사용자 입력: 폴더7)',
    '목표: 대략적인 높이 확인',
    `보안 연결: ${compat.secure ? '사용 가능' : 'HTTPS 필요'}`,
    `WebXR AR 지원 응답: ${compat.ar}`,
    `별도 카메라 확인: ${cameraStatus}`,
    `AR 현재 상태: ${ar.phase} / ${ar.message}`,
    `바닥 방향 표면 신호를 보고 누른 확인: ${observed.floor ? '있음' : '없음'}`,
    `천장 방향 표면 신호를 보고 누른 확인: ${observed.ceiling ? '있음' : '없음'}`,
    '이 기록은 표면의 실제 종류나 방 높이를 검증하지 않습니다.',
    '높이 측정: 구현됨 / 실제 높이 정확도: 미검증',
    `브라우저: ${navigator.userAgent}`,
  ].join('\n');

  async function copyReport() {
    setShowReport(true);
    try { await navigator.clipboard.writeText(report); setCopyMessage('복사했어요. 이 대화에 붙여 넣어 주세요.'); }
    catch { setCopyMessage('아래 기록을 길게 눌러 복사할 수 있어요.'); }
  }

  const arReady = compat.ar === 'supported';
  return <>
    <div className="app-shell">
      <header className="header"><a href="./" className="brand" aria-label="높이 보기 처음으로"><span className="brand-icon" aria-hidden="true">↕</span> 높이 보기</a><span className="stage-pill">측정 시험용 · v0.2.2</span></header>
      <main>
        <section className="hero">
          <p className="eyebrow">내 휴대폰으로, 공간의 높이를</p>
          <h1>바닥에서 천장까지,<br />높이를 확인해요.</h1>
          <p className="hero-copy">휴대폰으로 두 지점을 차례로 맞춰요.<br />실제 높이와의 차이는 아직 검증 전이에요.</p>
          <div className="device-chip"><span className="tiny-dot" />갤럭시 Z 폴드7 가정<span className="chip-divider">/</span>대략적인 확인용</div>
        </section>

        <MeasurementPanel supported={arReady} blocked={arOpen || arStopping || cameraStatus === 'opening'} onBeforeStart={() => { stopCamera(); setCameraStatus(status => status === 'opening' ? 'idle' : status); }} onActivityChange={setMeasurementActive} />
        <p className="diagnostics-heading">잘 안 되나요? 카메라와 AR을 확인해요.</p>

        <div className="steps">
          <section className="card">
            <div className="card-heading"><span className="step-number">01</span><div><h2>AR 지원 확인</h2><p>휴대폰과 브라우저가 준비됐는지</p></div></div>
            <ul className="check-list">
              <li><span><Mark state={compat.secure ? 'good' : 'bad'} />보안 연결</span><strong>{compat.secure ? '사용 가능' : 'HTTPS 필요'}</strong></li>
              <li><span><Mark state={arReady ? 'good' : compat.ar === 'checking' ? 'waiting' : 'bad'} />WebXR AR</span><strong>{arReady ? '지원 응답 확인' : compat.ar === 'checking' ? '확인 중' : compat.ar === 'error' ? '확인 실패' : '지원 안 됨'}</strong></li>
            </ul>
            <p className="status-copy" role="status">{compat.message}</p>
            <button className="text-button" onClick={() => void refreshCompatibility()} disabled={compat.ar === 'checking'}>지원 여부 다시 확인 <span aria-hidden="true">↻</span></button>
          </section>

          <section className="card">
            <div className="card-heading"><span className="step-number">02</span><div><h2>카메라 확인</h2><p>권한을 허용하고 영상 보기</p></div><span className={`small-label ${cameraStatus === 'granted' ? 'success' : ''}`}>{cameraStatus === 'granted' ? '확인됨' : cameraStatus === 'error' ? '재확인 필요' : '직접 확인'}</span></div>
            <div className={`camera-preview ${previewOn ? 'is-on' : ''}`}>
              <video ref={videoRef} muted playsInline aria-label="휴대폰 카메라 미리보기" />
              {!previewOn && <div className="camera-placeholder"><svg viewBox="0 0 48 48" width="40" height="40" fill="none" aria-hidden="true"><path d="M8 14h8l3-5h10l3 5h8v25H8z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><circle cx="24" cy="26" r="8" stroke="currentColor" strokeWidth="2" /></svg><span>내 카메라 화면이 여기에 보여요</span></div>}
              {previewOn && <span className="live-label">카메라 켜짐 · 전송 없음</span>}
            </div>
            <p className="status-copy" role="status">{cameraMessage}</p>
            {cameraStatus === 'opening' ? <button className="secondary-button" onClick={() => { stopCamera(); setCameraStatus('idle'); setCameraMessage('확인을 취소했어요. 다시 시작할 수 있어요.'); }}>카메라 요청 취소</button>
              : previewOn ? <button className="secondary-button" onClick={stopCamera}>카메라 끄기</button>
                : <button className="secondary-button" onClick={() => void openCamera()} disabled={!compat.secure || !compat.cameraApi || arOpen || arStopping || measurementActive}>카메라 확인하기</button>}
          </section>

          <section className="card ar-card">
            <div className="card-heading"><span className="step-number">03</span><div><h2>바닥 · 천장 인식 확인</h2><p>실제 AR에서 표면 신호 확인하기</p></div></div>
            <ol className="instructions"><li>AR을 켜고, 권한 요청에 <b>허용</b>을 눌러요.</li><li>밝은 곳에서 바닥을 향해 천천히 움직여요.</li><li>초록 원이 보이면 확인하고, 천장도 살펴봐요.</li></ol>
            <p className="status-copy" role="status">{ar.message}</p>
            <button className="primary-button" onClick={startAr} disabled={!arReady || arOpen || arStopping || measurementActive}>AR 표면 확인 시작 <span aria-hidden="true">↗</span></button>
            <p className="button-note">카메라 미리보기는 AR을 켤 때 자동으로 꺼져요.</p>
            {(observed.floor || observed.ceiling) && <div className="observation"><span>바닥 방향 신호: {observed.floor ? '확인' : '미확인'}</span><span>천장 방향 신호: {observed.ceiling ? '확인' : '미확인'}</span><small>사용자가 바라본 방향의 표면 신호 기록이며, 높이 측정 결과는 아니에요.</small></div>}
          </section>
        </div>

        <aside className="privacy-note"><span aria-hidden="true">◇</span><p><strong>카메라 영상은 휴대폰 안에만</strong><br />영상 업로드·광고·로그인·유료 측정 API가 없어요.</p></aside>
        <section className="help-section">
          <details><summary>지원이 안 되거나 초록 원이 안 보여요</summary><p>카카오톡 등의 앱 안에서 열었다면 링크를 복사해 <b>Chrome 주소창</b>에 붙여 넣어 주세요. Chrome과 Play 스토어의 <b>Google Play AR 서비스</b>를 업데이트해 주세요.</p><p>조명을 켜고 휴대폰을 천천히 움직여 주세요. 무늬 없는 흰 천장, 유리·거울, 어두운 곳에서는 인식이 어려울 수 있어요. 표면이 인식되지 않으면 이전 위치를 대신 사용하지 않아요.</p><p>AR 지원 응답, 카메라 성공, 실제 표면 인식, 높이 정확도는 각각 다른 확인 항목이에요.</p></details>
          <button className="secondary-button report-button" onClick={() => void copyReport()}>확인 기록 복사하기</button>
          {copyMessage && <p className="status-copy" role="status">{copyMessage}</p>}
          {showReport && <textarea className="report-text" aria-label="호환성 확인 기록" value={report} readOnly rows={10} />}
        </section>
      </main>
      <footer><span>실제 높이 정확도 <b>미검증</b></span><p>측정 시험용 v0.2.2 · 실제 줄자와의 비교가 필요해요.</p></footer>
    </div>

    <div ref={hostRef} className="xr-canvas-host" aria-hidden="true" />
    <div ref={overlayRef} className={`xr-overlay diagnostic-overlay ${arOpen ? 'xr-open' : ''} ${ar.phase === 'starting' ? 'xr-starting' : ''}`}>
      <div className="xr-top"><span className="xr-pill">표면 인식 확인 · 높이 측정 아님</span><button className="exit-button" onClick={() => void stopAr()} aria-label="AR 확인 종료">종료 ✕</button></div>
      <div className="xr-aim" aria-hidden="true">+</div>
      <div className="xr-panel">
        <p className="eyebrow">{target === 'floor' ? '01 / 바닥 방향' : '02 / 천장 방향'}</p>
        <h2>{observed.ceiling ? '표면 신호를 확인했어요' : target === 'floor' ? '바닥을 천천히 비춰 주세요' : '천천히 천장을 비춰 주세요'}</h2>
        <p role="status">{ar.message}</p>
        <p className="xr-small">초록 원이 원하는 표면에 보일 때만 눌러 주세요.</p>
        {observed.ceiling ? <button className="primary-button" onClick={() => void stopAr()}>확인 마치기</button>
          : <button className="primary-button" disabled={!ar.canConfirm} onClick={confirmSurface}>{ar.canConfirm ? `${target === 'floor' ? '바닥' : '천장'} 방향 표면 신호 확인` : '표면 인식을 기다리는 중…'}</button>}
        {target === 'ceiling' && !observed.ceiling && <button className="xr-skip" onClick={() => void stopAr()}>천장이 인식되지 않아요 · 종료</button>}
        <small>표면 신호만 확인해요. 높이값은 만들지 않아요.</small>
      </div>
    </div>
  </>;
}
