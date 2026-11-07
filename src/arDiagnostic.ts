import {
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  RingGeometry,
  Scene,
  WebGLRenderer,
} from 'three';
import { SurfaceGuard, type SurfaceSample } from './surfaceGuard';
import type { MeasurementHit } from './measurement';

export type { SurfaceSample } from './surfaceGuard';
export type ArPhase =
  | 'idle'
  | 'starting'
  | 'stopping'
  | 'searching'
  | 'surface'
  | 'tracking-lost'
  | 'paused'
  | 'reset'
  | 'ended'
  | 'error';

export interface ArUpdate {
  phase: ArPhase;
  message: string;
  canConfirm: boolean;
  hitCount: number;
}

interface Run {
  sessionId: string;
  epoch: number;
  currentHit: MeasurementHit | null;
  closed: boolean;
  released: boolean;
  nativeEnded: boolean;
  endListenerAdded: boolean;
  sessionRequest?: Promise<XRSession>;
  rendererSetup?: Promise<void>;
  closePromise?: Promise<void>;
  terminal?: { phase: ArPhase; message: string };
  session?: XRSession;
  renderer?: WebGLRenderer;
  scene?: Scene;
  camera?: PerspectiveCamera;
  reticle?: Mesh<RingGeometry, MeshBasicMaterial>;
  source?: XRHitTestSource;
  reference?: XRReferenceSpace;
  guard: SurfaceGuard;
  generation: number;
  hits: number;
  lastFrameAt: number;
  lastUpdateAt: number;
  lastMessage: string;
  phase: ArPhase;
  timer?: ReturnType<typeof setInterval>;
  removeListeners: Array<() => void>;
}

type Options = {
  host: HTMLDivElement;
  overlay: HTMLDivElement;
  onUpdate: (state: ArUpdate) => void;
};

// Hits stay in memory, so a monotonic identity is sufficient within this page.
let nextRunIdentity = 0;

function explainError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'AR 또는 카메라 사용이 허용되지 않았습니다. Chrome의 이 사이트 권한을 확인하고 다시 시작해 주세요.';
    case 'NotSupportedError':
      return '이 환경에서 필요한 AR·표면 인식·화면 버튼 기능을 사용할 수 없습니다. Chrome과 Google Play AR 서비스를 업데이트해 주세요.';
    case 'SecurityError':
      return '안전한 HTTPS 주소에서 Chrome으로 직접 열어 주세요. 다른 앱 안의 브라우저에서는 작동하지 않을 수 있습니다.';
    case 'InvalidStateError':
      return '다른 AR 화면이 열려 있거나 세션을 시작할 수 없습니다. AR 화면을 닫고 다시 시도해 주세요.';
    default:
      return 'AR 표면 확인을 시작하거나 유지하지 못했습니다. AR을 닫은 뒤 다시 시작해 주세요.';
  }
}

/** Real WebXR plane hits, with no estimated-plane or simulated-data fallback. */
export class ArDiagnostic {
  private run?: Run;

  constructor(private readonly options: Options) {}

  async start(): Promise<void> {
    // A closed run may still own a native permission prompt or AR session.
    if (this.run && !this.run.released) return;

    const run: Run = {
      sessionId: `ar-session-${++nextRunIdentity}`,
      epoch: 0,
      currentHit: null,
      closed: false,
      released: false,
      nativeEnded: false,
      endListenerAdded: false,
      guard: new SurfaceGuard(),
      generation: 0,
      hits: 0,
      lastFrameAt: performance.now(),
      lastUpdateAt: -Infinity,
      lastMessage: '',
      phase: 'starting',
      removeListeners: [],
    };
    this.run = run;
    this.publish(run, 'starting', '카메라와 AR 사용 허용 창을 확인해 주세요.');

    try {
      if (!window.isSecureContext || !navigator.xr) {
        throw new DOMException('WebXR is unavailable', 'NotSupportedError');
      }

      // Keep this call before the first await: Android requires a user gesture.
      run.sessionRequest = navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['local-floor', 'hit-test', 'dom-overlay'],
        domOverlay: { root: this.options.overlay },
      });
      const session = await run.sessionRequest;
      run.session = session;
      this.attachEndListener(run, session);
      // close() owns ending a session that arrives after cancellation.
      if (run.closed) return;

      const onVisibility = () => {
        if (run.closed) return;
        this.invalidate(run, true);
        if (session.visibilityState !== 'visible' || document.hidden) {
          this.publish(run, 'paused', 'AR 화면이 가려졌습니다. 화면으로 돌아와 표면을 다시 찾아 주세요.');
        } else {
          run.lastFrameAt = performance.now();
          this.publish(run, 'searching', '이전 위치를 지웠습니다. 휴대폰을 천천히 움직여 표면을 다시 찾아 주세요.');
        }
      };
      session.addEventListener('visibilitychange', onVisibility);
      document.addEventListener('visibilitychange', onVisibility);
      run.removeListeners.push(
        () => session.removeEventListener('visibilitychange', onVisibility),
        () => document.removeEventListener('visibilitychange', onVisibility),
      );

      const renderer = new WebGLRenderer({ alpha: true, antialias: true });
      run.renderer = renderer;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setClearColor(0x000000, 0);
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType('local-floor');
      renderer.domElement.setAttribute('aria-hidden', 'true');
      this.options.host.appendChild(renderer.domElement);

      run.scene = new Scene();
      run.camera = new PerspectiveCamera();
      const geometry = new RingGeometry(0.045, 0.06, 40);
      geometry.rotateX(-Math.PI / 2);
      run.reticle = new Mesh(
        geometry,
        new MeshBasicMaterial({ color: 0x64ffd2, side: DoubleSide, depthTest: false }),
      );
      run.reticle.matrixAutoUpdate = false;
      run.reticle.visible = false;
      run.scene.add(run.reticle);

      // Three starts its ordinary window RAF whenever setAnimationLoop receives
      // a callback. Register BEFORE setSession so XR's sessionstart stops that
      // window loop; registering afterward starts two competing frame sources.
      renderer.setAnimationLoop((_time, frame) => this.onFrame(run, frame));
      run.rendererSetup = renderer.xr.setSession(session);
      await run.rendererSetup;
      if (run.closed) return;
      const reference = renderer.xr.getReferenceSpace();
      if (!reference) throw new Error('Missing local-floor reference space');
      run.reference = reference;
      const onReset = () => {
        void this.close(run, 'reset', 'AR 좌표계가 초기화되었습니다. 기존 확인을 지웠습니다. AR을 다시 시작해 주세요.');
      };
      reference.addEventListener('reset', onReset);
      run.removeListeners.push(() => reference.removeEventListener('reset', onReset));

      const viewer = await session.requestReferenceSpace('viewer');
      if (run.closed) return;
      if (!session.requestHitTestSource) {
        throw new DOMException('Hit testing is unavailable', 'NotSupportedError');
      }
      const source = await session.requestHitTestSource({ space: viewer, entityTypes: ['plane'] });
      if (!source) throw new Error('Missing hit-test source');
      if (run.closed) {
        source.cancel();
        return;
      }
      run.source = source;
      run.generation = run.guard.begin();
      run.lastFrameAt = performance.now();
      this.publish(run, 'searching', '휴대폰을 천천히 움직여 표면 위에 초록 원이 나타나는지 확인해 주세요.');

      // A stopped frame loop must not leave the final rendered hit confirmable.
      run.timer = setInterval(() => {
        if (run.closed || run.phase === 'paused') return;
        if (performance.now() - run.lastFrameAt > run.guard.maxAgeMs) {
          this.invalidate(run, true);
          this.publish(run, 'tracking-lost', '새 AR 위치를 받지 못했습니다. 휴대폰을 천천히 움직여 다시 찾아 주세요.');
        }
      }, 100);
    } catch (error) {
      if (!run.closed) await this.close(run, 'error', explainError(error));
    }
  }

  async stop(): Promise<void> {
    if (!this.run) return;
    await this.close(this.run, 'ended', 'AR을 종료했습니다. 다시 시작하면 새로 확인합니다.');
  }

  confirmSurface(): SurfaceSample | null {
    const run = this.run;
    if (
      !run ||
      run.closed ||
      run.phase !== 'surface' ||
      run.session?.visibilityState !== 'visible' ||
      document.hidden
    ) return null;

    const point = run.guard.read(performance.now());
    if (!point) {
      this.invalidate(run, true);
      this.publish(run, 'tracking-lost', '현재 위치가 오래되어 확인할 수 없습니다. 표면을 다시 찾아 주세요.');
    }
    return point;
  }

  getCurrentHit(): MeasurementHit | null {
    // Reuse the diagnostic gate so freshness, session visibility, and native
    // lifecycle checks cannot diverge between diagnostic and measurement modes.
    const position = this.confirmSurface();
    const run = this.run;
    const hit = run?.currentHit;
    if (
      !position || !run || !hit ||
      hit.sessionId !== run.sessionId ||
      hit.epoch !== run.epoch ||
      ![hit.normalY, hit.viewerY, hit.timestamp, hit.epoch].every(Number.isFinite) ||
      Math.abs(hit.normalY) > 1
    ) return null;
    return { ...hit, position: { ...position } };
  }

  private onFrame(run: Run, frame?: XRFrame): void {
    if (run.closed || this.run !== run || !frame) return;
    // Ordinary window RAF has no XRFrame. It is not a failed AR pose and must
    // neither clear a valid hit nor refresh the real-XR heartbeat. Genuine XR
    // frames with a missing/emulated viewer pose are still rejected below.
    const { session, renderer, scene, camera, reference, source, reticle } = run;
    if (!session || !renderer || !scene || !camera || !reference || !source || !reticle) return;

    const now = performance.now();
    const frameGap = now - run.lastFrameAt;
    if (!Number.isFinite(frameGap) || frameGap < 0 || frameGap > run.guard.maxAgeMs) {
      this.invalidate(run, true);
      // A resumed RAF may run before the timer heartbeat after a suspension.
      // Notify synchronously so a saved floor is cleared before this new hit.
      this.publish(run, 'tracking-lost', 'AR 위치 갱신이 잠시 끊겨 이전 지점을 지웠습니다. 바닥부터 다시 지정해 주세요.');
    }
    run.lastFrameAt = now;
    // Always invalidate first. A frame with no hit never reuses an earlier hit.
    this.invalidate(run, false);

    if (session.visibilityState !== 'visible' || document.hidden) {
      this.invalidate(run, true);
      this.publish(run, 'paused', 'AR 화면이 가려졌습니다. 화면으로 돌아와 표면을 다시 찾아 주세요.');
      return;
    }

    try {
      const viewerPose = frame.getViewerPose(reference);
      if (
        !viewerPose || viewerPose.emulatedPosition ||
        !Number.isFinite(viewerPose.transform.position.y)
      ) {
        this.invalidate(run, true);
        this.publish(run, 'tracking-lost', '휴대폰 위치를 추적하지 못했습니다. 밝고 무늬가 있는 주변을 천천히 비춰 주세요.');
      } else {
        const results = frame.getHitTestResults(source);
        const pose = results[0]?.getPose(reference);
        if (pose && !pose.emulatedPosition) {
          const { x, y, z } = pose.transform.position;
          const matrix = pose.transform.matrix;
          // XR hit-test poses place the surface normal on their local Y axis.
          // Three/XR matrices are column-major; normalize before dotting with
          // world-up so tilted surfaces are distinguishable from horizontal ones.
          const normalLength = Math.hypot(matrix[4], matrix[5], matrix[6]);
          const normalY = matrix[5] / normalLength;
          if (
            Number.isFinite(normalLength) && normalLength > 0 && Number.isFinite(normalY) &&
            run.guard.offer({ x, y, z }, run.lastFrameAt, run.generation)
          ) {
            run.currentHit = {
              position: { x, y, z },
              normalY,
              viewerY: viewerPose.transform.position.y,
              timestamp: run.lastFrameAt,
              sessionId: run.sessionId,
              epoch: run.epoch,
              source: 'webxr-plane-hit',
            };
            reticle.matrix.fromArray(matrix);
            reticle.visible = true;
            run.hits += 1;
            this.publish(run, 'surface', '현재 카메라 방향에서 평면 위치를 인식했습니다. 원이 원하는 표면 위에 있는지 확인해 주세요.');
          } else {
            this.publish(run, 'searching', '유효한 표면 위치를 기다리고 있습니다. 천천히 움직여 주세요.');
          }
        } else {
          this.publish(run, 'searching', '현재 방향에서 표면을 찾지 못했습니다. 이전 원의 위치는 사용할 수 없습니다.');
        }
      }
      renderer.render(scene, camera);
    } catch (error) {
      void this.close(run, 'error', explainError(error));
    }
  }

  private invalidate(run: Run, resetCount: boolean): void {
    run.guard.clear();
    run.currentHit = null;
    if (run.reticle) run.reticle.visible = false;
    if (resetCount) {
      run.hits = 0;
      // This is synchronous even when identical UI status updates are throttled.
      // A floor from before tracking loss must not pair with a recovered ceiling.
      run.epoch += 1;
    }
  }

  private publish(run: Run, phase: ArPhase, message: string): void {
    if (this.run !== run) return;
    const now = performance.now();
    const changed = run.phase !== phase || run.lastMessage !== message;
    run.phase = phase;
    run.lastMessage = message;
    // Render camera frames at native speed, but update React status at most 10 Hz.
    if (!changed && now - run.lastUpdateAt < 100) return;
    run.lastUpdateAt = now;
    this.options.onUpdate({
      phase,
      message,
      canConfirm: !run.closed && phase === 'surface' && run.guard.read(now) !== null,
      hitCount: run.hits,
    });
  }

  private attachEndListener(run: Run, session: XRSession): void {
    if (run.endListenerAdded) return;
    run.endListenerAdded = true;
    const onEnd = () => {
      run.nativeEnded = true;
      run.closed = true;
      this.invalidate(run, true);
      run.guard.end();
      run.terminal ??= { phase: 'ended', message: 'AR을 종료했습니다. 다시 시작하면 새로 확인합니다.' };
      this.publish(run, 'stopping', 'AR 화면과 카메라를 종료하고 있습니다.');
      // Three's native end listener must restore its rendering state first.
      queueMicrotask(() => { void this.finalize(run); });
    };
    session.addEventListener('end', onEnd);
    run.removeListeners.push(() => session.removeEventListener('end', onEnd));
  }

  private close(run: Run, phase: ArPhase, message: string): Promise<void> {
    if (run.released) return Promise.resolve();
    if (run.closePromise) return run.closePromise;
    run.closed = true;
    run.terminal ??= { phase, message };
    this.invalidate(run, true);
    run.guard.end();
    run.renderer?.setAnimationLoop(null);
    this.publish(run, 'stopping', 'AR 종료를 기다리고 있습니다. 권한 창이 떠 있다면 허용 또는 취소를 눌러 닫아 주세요.');

    run.closePromise = (async () => {
      // Browser permission prompts cannot be cancelled by JavaScript. Keep the
      // screen locked until the native request settles, then end any new session.
      const session = run.session ?? await run.sessionRequest?.catch(() => undefined);
      if (session && !run.nativeEnded) {
        run.session = session;
        this.attachEndListener(run, session);
        try {
          await session.end();
          run.nativeEnded = true;
        } catch {
          if (!run.nativeEnded) {
            // Do not advertise a completed stop while the native camera may live.
            this.publish(run, 'stopping', 'AR 종료 요청이 완료되지 않았습니다. 브라우저의 AR 닫기 버튼으로 종료해 주세요.');
            return;
          }
        }
      }
      await this.finalize(run);
    })().finally(() => {
      // A failed native end can be retried; concurrent stops share one promise.
      if (!run.released) run.closePromise = undefined;
    });
    return run.closePromise;
  }

  private async finalize(run: Run): Promise<void> {
    // setSession can still be awaiting makeXRCompatible or a reference space.
    // Ending the native session normally rejects that work; either outcome must
    // settle before the renderer is disposed.
    await run.rendererSetup?.catch(() => undefined);
    if (run.released) return;
    this.release(run);
    const terminal = run.terminal ?? { phase: 'ended', message: 'AR을 종료했습니다. 다시 시작하면 새로 확인합니다.' };
    this.publish(run, terminal.phase, terminal.message);
  }

  private release(run: Run): void {
    run.released = true;
    this.invalidate(run, true);
    run.guard.end();
    if (run.timer !== undefined) clearInterval(run.timer);
    run.timer = undefined;
    for (const remove of run.removeListeners.splice(0)) remove();
    if (run.source) {
      try { run.source.cancel(); } catch { /* A native ended session already owns cleanup. */ }
      run.source = undefined;
    }
    run.renderer?.setAnimationLoop(null);
    run.reticle?.geometry.dispose();
    run.reticle?.material.dispose();
    run.scene?.clear();
    run.renderer?.dispose();
    run.renderer?.domElement.remove();
    run.reticle = undefined;
    run.renderer = undefined;
    run.scene = undefined;
    run.camera = undefined;
    run.reference = undefined;
    run.session = undefined;
  }
}
