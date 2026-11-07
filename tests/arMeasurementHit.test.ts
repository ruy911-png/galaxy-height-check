// @vitest-environment jsdom
// These are synthetic XR/Three contract tests, not phone or room-accuracy tests.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArDiagnostic } from '../src/arDiagnostic';
import { HeightMeasurement } from '../src/measurement';

const threeState = vi.hoisted(() => ({
  renderers: [] as Array<{
    callback: ((time: number, frame?: XRFrame) => void) | null;
    reference: EventTarget;
    loopRegisteredBeforeSession: boolean;
    render: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('three', () => {
  class WebGLRenderer {
    callback: ((time: number, frame?: XRFrame) => void) | null = null;
    reference = new EventTarget();
    loopRegisteredBeforeSession = false;
    domElement = document.createElement('canvas');
    xr = {
      enabled: false,
      setReferenceSpaceType: vi.fn(),
      setSession: vi.fn(async () => { this.loopRegisteredBeforeSession = this.callback !== null; }),
      getReferenceSpace: () => this.reference,
    };
    constructor() { threeState.renderers.push(this); }
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    setAnimationLoop(callback: ((time: number, frame?: XRFrame) => void) | null) { this.callback = callback; }
    render = vi.fn();
    dispose() {}
  }
  class RingGeometry {
    rotateX() { return this; }
    dispose() {}
  }
  class MeshBasicMaterial { dispose() {} }
  class Mesh {
    visible = false;
    matrixAutoUpdate = true;
    matrix = { fromArray: vi.fn() };
    constructor(public geometry: RingGeometry, public material: MeshBasicMaterial) {}
  }
  class Scene { add() {} clear() {} }
  class PerspectiveCamera {}
  return { WebGLRenderer, RingGeometry, MeshBasicMaterial, Mesh, Scene, PerspectiveCamera, DoubleSide: 2 };
});

const diagnostics: ArDiagnostic[] = [];

async function setup() {
  let now = 1000;
  let hidden = false;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal('isSecureContext', true);
  const sessions: Array<XRSession & { visibilityState: XRVisibilityState }> = [];
  const requestSession = vi.fn(async () => {
    const session = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as XRVisibilityState,
      requestReferenceSpace: vi.fn(async () => new EventTarget()),
      requestHitTestSource: vi.fn(async () => ({ cancel: vi.fn() })),
      end: vi.fn(async () => { session.dispatchEvent(new Event('end')); }),
    }) as unknown as XRSession & { visibilityState: XRVisibilityState };
    sessions.push(session);
    return session;
  });
  Object.defineProperty(navigator, 'xr', { configurable: true, value: { requestSession } });
  const onUpdate = vi.fn();
  const diagnostic = new ArDiagnostic({
    host: document.createElement('div'),
    overlay: document.createElement('div'),
    onUpdate,
  });
  diagnostics.push(diagnostic);
  await diagnostic.start();
  return {
    diagnostic,
    sessions,
    onUpdate,
    setNow(value: number) { now = value; },
    setHidden(value: boolean) { hidden = value; document.dispatchEvent(new Event('visibilitychange')); },
    windowFrame() {
      // Three's regular window RAF invokes this callback without an XRFrame.
      threeState.renderers.at(-1)!.callback!(now);
    },
    frame(options: FrameOptions = {}) {
      const renderer = threeState.renderers.at(-1)!;
      expect(renderer.callback).not.toBeNull();
      renderer.callback!(now, createFrame(options));
    },
  };
}

type HitOptions = {
  noPose?: boolean;
  emulatedHit?: boolean;
  position?: { x: number; y: number; z: number };
  normalColumn?: [number, number, number];
};

type FrameOptions = HitOptions & {
  noHit?: boolean;
  noViewer?: boolean;
  emulatedViewer?: boolean;
  viewerY?: number;
  // WebXR orders hits from nearest to farthest. Multiple fixtures must retain
  // that order; a more convenient distant plane cannot replace an obstruction.
  hits?: HitOptions[];
};

function createHitPose(options: HitOptions) {
  if (options.noPose) return null;
  const normal = options.normalColumn ?? [0, 1, 0];
  const position = options.position ?? { x: 1, y: 0, z: -2 };
  const matrix = new Float32Array([
    1, 0, 0, 0,
    normal[0], normal[1], normal[2], 0,
    0, 0, 1, 0,
    position.x, position.y, position.z, 1,
  ]);
  return {
    emulatedPosition: options.emulatedHit ?? false,
    transform: { position, matrix },
  };
}

function createFrame(options: FrameOptions): XRFrame {
  const viewer = options.noViewer ? null : {
    emulatedPosition: options.emulatedViewer ?? false,
    transform: { position: { x: 0, y: options.viewerY ?? 1.6, z: 0 } },
  };
  const hits = options.noHit ? [] : (options.hits ?? [options]);
  return {
    getViewerPose: vi.fn(() => viewer),
    getHitTestResults: vi.fn(() => hits.map(hit => ({ getPose: vi.fn(() => createHitPose(hit)) }))),
  } as unknown as XRFrame;
}

afterEach(async () => {
  for (const diagnostic of diagnostics.splice(0)) await diagnostic.stop();
  threeState.renderers.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'xr');
});

describe('furnished-room failure scenarios — synthetic plane signals, not object recognition', () => {
  const ceiling: HitOptions = { position: { x: 0, y: 2.5, z: -3 }, normalColumn: [0, -1, 0] };

  it.each([
    { scenario: 'bed headboard / vertical foreground', hit: { position: { x: 0, y: 1.9, z: -1 }, normalColumn: [0, 0, 1] } as HitOptions, reason: 'non-horizontal' },
    { scenario: 'tilted bed board / foreground', hit: { position: { x: 0, y: 1.9, z: -1 }, normalColumn: [0.6, 0.8, 0] } as HitOptions, reason: 'non-horizontal' },
  ])('$scenario is not skipped to select a farther ceiling', async ({ hit, reason }) => {
    const { diagnostic, frame, setNow } = await setup();
    const measurement = new HeightMeasurement();
    frame();
    expect(measurement.confirm(diagnostic.getCurrentHit(), 1000).ok).toBe(true);

    setNow(1010);
    frame({ hits: [hit, ceiling] });
    expect(diagnostic.getCurrentHit()?.position).toEqual(hit.position);
    expect(measurement.confirm(diagnostic.getCurrentHit(), 1010)).toEqual({ ok: false, reason });
    expect(measurement.getState().step).toBe('ceiling');
    expect(measurement.getState().result).toBeNull();
  });

  it.each([
    { scenario: 'missing nearest pose', bad: { noPose: true } as HitOptions },
    { scenario: 'emulated nearest pose', bad: { emulatedHit: true } as HitOptions },
    { scenario: 'invalid nearest normal', bad: { normalColumn: [0, Number.NaN, 0] } as HitOptions },
  ])('window-side failure: $scenario clears the old candidate and does not skip to a farther hit', async ({ bad }) => {
    const { diagnostic, frame, setNow, onUpdate } = await setup();
    frame();
    const oldHit = diagnostic.getCurrentHit()!;
    setNow(1010);
    frame({ hits: [bad, ceiling] });
    expect(diagnostic.getCurrentHit()).toBeNull();
    expect(diagnostic.confirmSurface()).toBeNull();
    expect(onUpdate.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'searching', canConfirm: false });

    setNow(1020);
    frame(ceiling);
    const recovered = diagnostic.getCurrentHit()!;
    expect(recovered.epoch).toBe(oldHit.epoch); // Phone tracking remained valid.
    expect(recovered.position).toEqual(ceiling.position);
    expect(recovered.timestamp).toBe(1020);
  });

  it('window-side no-hit intervals cannot confirm the previous ceiling but allow a fresh ceiling after recovery', async () => {
    const { diagnostic, frame, setNow } = await setup();
    const measurement = new HeightMeasurement();
    frame();
    measurement.confirm(diagnostic.getCurrentHit(), 1000);
    const savedFloor = measurement.getState().floor;
    setNow(1010);
    frame(ceiling);
    expect(measurement.canConfirm(diagnostic.getCurrentHit(), 1010)).toBe(true);

    for (const time of [1020, 1120, 1220]) {
      setNow(time);
      frame({ noHit: true });
      expect(measurement.confirm(diagnostic.getCurrentHit(), time)).toEqual({ ok: false, reason: 'no-hit' });
      expect(measurement.getState().floor).toEqual(savedFloor);
      expect(measurement.getState().result).toBeNull();
    }

    setNow(1230);
    frame({ ...ceiling, position: { x: 0, y: 2.6, z: -3 } });
    const completed = measurement.confirm(diagnostic.getCurrentHit(), 1230);
    expect(completed.ok).toBe(true);
    if (!completed.ok) throw new Error('Expected fresh ceiling after no-hit recovery');
    expect(completed.result?.meters).toBe(2.6); // Never the stale 2.5m candidate.
  });

  it('doorway-side vertical jamb is rejected while a later downward-facing horizontal ceiling can complete the same measurement', async () => {
    const { diagnostic, frame, setNow } = await setup();
    const measurement = new HeightMeasurement();
    frame();
    measurement.confirm(diagnostic.getCurrentHit(), 1000);
    const savedFloor = measurement.getState().floor;
    setNow(1010);
    frame({ position: { x: 0, y: 2, z: -1 }, normalColumn: [1, 0, 0] });
    expect(measurement.confirm(diagnostic.getCurrentHit(), 1010)).toEqual({ ok: false, reason: 'non-horizontal' });
    expect(measurement.getState().floor).toEqual(savedFloor);

    setNow(1020);
    frame(ceiling);
    expect(diagnostic.getCurrentHit()?.normalY).toBe(-1);
    const completed = measurement.confirm(diagnostic.getCurrentHit(), 1020);
    expect(completed.ok).toBe(true);
    if (!completed.ok) throw new Error('Expected a horizontal ceiling to recover');
    expect(completed.result?.meters).toBe(2.5);
  });

  it('doorway-side tracking loss cannot join the old floor to a ceiling after tracking recovers', async () => {
    const { diagnostic, frame, setNow } = await setup();
    const measurement = new HeightMeasurement();
    frame();
    measurement.confirm(diagnostic.getCurrentHit(), 1000);
    setNow(1010);
    frame({ emulatedViewer: true });
    expect(diagnostic.getCurrentHit()).toBeNull();

    setNow(1020);
    frame(ceiling);
    expect(measurement.confirm(diagnostic.getCurrentHit(), 1020)).toEqual({ ok: false, reason: 'coordinate-space-changed' });
    expect(measurement.getState()).toEqual({ step: 'floor', floor: null, result: null });
  });
});

describe('current real-hit metadata exposed to the measurement model', () => {
  it('registers the animation callback before attaching XR so sessionstart can stop the window loop', async () => {
    await setup();
    expect(threeState.renderers.at(-1)!.loopRegisteredBeforeSession).toBe(true);
  });

  it('ignores ordinary window callbacks between real XR frames without false tracking loss', async () => {
    const { diagnostic, frame, windowFrame, setNow, onUpdate } = await setup();
    frame();
    const initial = diagnostic.getCurrentHit();
    const renderer = threeState.renderers.at(-1)!;
    renderer.render.mockClear();
    onUpdate.mockClear();
    setNow(1010);
    windowFrame();
    expect(diagnostic.getCurrentHit()).toEqual(initial);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
    setNow(1020);
    frame();
    expect(diagnostic.getCurrentHit()?.epoch).toBe(initial?.epoch);
    expect(diagnostic.getCurrentHit()?.timestamp).toBe(1020);
  });

  it('ordinary callbacks cannot hide a gap in real XR frames when XR resumes before the watchdog', async () => {
    const { diagnostic, frame, windowFrame, setNow, onUpdate } = await setup();
    frame();
    const initial = diagnostic.getCurrentHit()!;
    for (const time of [1100, 1200, 1300]) {
      setNow(time);
      windowFrame();
    }
    onUpdate.mockClear();
    setNow(1310);
    frame();
    expect(onUpdate.mock.calls.map(([update]) => update.phase)).toEqual(['tracking-lost', 'surface']);
    expect(diagnostic.getCurrentHit()!.epoch).toBeGreaterThan(initial.epoch);
  });

  it('the watchdog still rejects an expired XR sample even if ordinary callbacks continue', async () => {
    vi.useFakeTimers();
    const { diagnostic, frame, windowFrame, setNow, onUpdate } = await setup();
    frame();
    for (const time of [1100, 1200, 1300]) {
      setNow(time);
      windowFrame();
    }
    onUpdate.mockClear();
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate.mock.calls.map(([update]) => update.phase)).toContain('tracking-lost');
    expect(diagnostic.getCurrentHit()).toBeNull();
  });

  it('returns a fresh snapshot from the same frame with plane provenance and viewer height', async () => {
    const { diagnostic, frame } = await setup();
    frame();
    expect(diagnostic.getCurrentHit()).toEqual({
      position: { x: 1, y: 0, z: -2 },
      normalY: 1,
      viewerY: 1.6,
      timestamp: 1000,
      sessionId: expect.any(String),
      epoch: expect.any(Number),
      source: 'webxr-plane-hit',
    });
    expect(diagnostic.confirmSurface()).toEqual({ x: 1, y: 0, z: -2 });
  });

  it('clears a no-hit frame without changing the coordinate epoch', async () => {
    const { diagnostic, frame, setNow } = await setup();
    frame();
    const initial = diagnostic.getCurrentHit()!;
    setNow(1010);
    frame({ noHit: true });
    expect(diagnostic.getCurrentHit()).toBeNull();
    setNow(1020);
    frame();
    expect(diagnostic.getCurrentHit()?.epoch).toBe(initial.epoch);
    expect(diagnostic.getCurrentHit()?.sessionId).toBe(initial.sessionId);
  });

  it.each([
    ['missing viewer pose', { noViewer: true }],
    ['emulated viewer pose', { emulatedViewer: true }],
  ] as const)('invalidates the epoch immediately on %s, including recovery in the same session', async (_label, failure) => {
    const { diagnostic, frame } = await setup();
    frame();
    const initial = diagnostic.getCurrentHit()!;
    frame(failure);
    expect(diagnostic.getCurrentHit()).toBeNull();
    frame();
    const recovered = diagnostic.getCurrentHit()!;
    expect(recovered.sessionId).toBe(initial.sessionId);
    expect(recovered.epoch).toBeGreaterThan(initial.epoch);
  });

  it('clears hidden-document samples and increases the epoch before recovery', async () => {
    const { diagnostic, frame, setHidden } = await setup();
    frame();
    const initial = diagnostic.getCurrentHit()!;
    setHidden(true);
    expect(diagnostic.getCurrentHit()).toBeNull();
    setHidden(false);
    frame();
    expect(diagnostic.getCurrentHit()!.epoch).toBeGreaterThan(initial.epoch);
  });

  it('clears session-visibility loss and increases the epoch before recovery', async () => {
    const { diagnostic, frame, sessions } = await setup();
    frame();
    const initial = diagnostic.getCurrentHit()!;
    sessions[0].visibilityState = 'visible-blurred';
    sessions[0].dispatchEvent(new Event('visibilitychange'));
    expect(diagnostic.getCurrentHit()).toBeNull();
    sessions[0].visibilityState = 'visible';
    sessions[0].dispatchEvent(new Event('visibilitychange'));
    frame();
    expect(diagnostic.getCurrentHit()!.epoch).toBeGreaterThan(initial.epoch);
  });

  it('rejects a stale getter even before the heartbeat has run', async () => {
    const { diagnostic, frame, setNow } = await setup();
    frame();
    setNow(1251);
    expect(diagnostic.getCurrentHit()).toBeNull();
    expect(diagnostic.confirmSurface()).toBeNull();
  });

  it('changes the epoch when frames resume after a long gap before the heartbeat fires', async () => {
    const { diagnostic, frame, setNow, onUpdate } = await setup();
    frame();
    const initial = diagnostic.getCurrentHit()!;
    onUpdate.mockClear();
    setNow(1300);
    frame({ position: { x: 1, y: 2.7, z: -2 } });
    const recovered = diagnostic.getCurrentHit()!;
    expect(recovered.sessionId).toBe(initial.sessionId);
    expect(recovered.epoch).toBeGreaterThan(initial.epoch);
    expect(onUpdate.mock.calls.map(([update]) => update.phase)).toEqual(['tracking-lost', 'surface']);
  });

  it('normalizes the surface Y axis instead of assuming every hit is horizontal', async () => {
    const { diagnostic, frame } = await setup();
    frame({ normalColumn: [3, 4, 0], viewerY: 1.2 });
    expect(diagnostic.getCurrentHit()?.normalY).toBeCloseTo(0.8, 8);
    expect(diagnostic.getCurrentHit()?.viewerY).toBe(1.2);
    frame({ normalColumn: [0, -2, 0], position: { x: 1, y: 2.7, z: -2 } });
    expect(diagnostic.getCurrentHit()?.normalY).toBe(-1);
  });

  it.each([
    ['nonfinite viewer height', { viewerY: Number.NaN }],
    ['degenerate surface normal', { normalColumn: [0, 0, 0] as [number, number, number] }],
    ['nonfinite surface normal', { normalColumn: [0, Number.NaN, 0] as [number, number, number] }],
  ])('rejects %s metadata', async (_label, options) => {
    const { diagnostic, frame } = await setup();
    frame(options as FrameOptions);
    expect(diagnostic.getCurrentHit()).toBeNull();
  });

  it('returns defensive copies and cannot mutate the tracked coordinates', async () => {
    const { diagnostic, frame } = await setup();
    frame();
    const snapshot = diagnostic.getCurrentHit()!;
    snapshot.position.y = 99;
    snapshot.normalY = 0;
    expect(diagnostic.getCurrentHit()?.position.y).toBe(0);
    expect(diagnostic.getCurrentHit()?.normalY).toBe(1);
  });

  it('ends all current hits and assigns a new identity when AR restarts', async () => {
    const { diagnostic, frame } = await setup();
    frame();
    const initial = diagnostic.getCurrentHit()!;
    await diagnostic.stop();
    expect(diagnostic.getCurrentHit()).toBeNull();
    await diagnostic.start();
    frame();
    expect(diagnostic.getCurrentHit()!.sessionId).not.toBe(initial.sessionId);
  });

  it('clears the snapshot synchronously on a reference-space reset', async () => {
    const { diagnostic, frame } = await setup();
    frame();
    expect(diagnostic.getCurrentHit()).not.toBeNull();
    threeState.renderers.at(-1)!.reference.dispatchEvent(new Event('reset'));
    expect(diagnostic.getCurrentHit()).toBeNull();
    await diagnostic.stop();
  });
});
