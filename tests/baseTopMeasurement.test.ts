import { describe, expect, it } from 'vitest';
import { BaseTopMeasurement, type AimFrame } from '../src/baseTopMeasurement';
import type { Point3 } from '../src/measurement';

// Synthetic XR coordinates verify logic, not camera performance or room accuracy.
function unit(x: number, y: number, z: number): Point3 {
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}

function frame(time = 1000, height: number | null = 0): AimFrame {
  const common = { timestamp: time, sessionId: 'session-a', epoch: 0, viewerY: 1.4 };
  return {
    ...common, origin: { x: 0, y: 1.4, z: 0 },
    direction: unit(0, (height ?? 2.4) - 1.4, -2), source: 'webxr-view-ray',
    hitState: height === null ? 'none' : 'valid',
    hit: height === null ? null : {
      ...common, position: { x: 0, y: height, z: -2 }, normalY: height === 0 ? 1 : 0,
      source: 'webxr-plane-hit',
    },
  };
}

function based() {
  const model = new BaseTopMeasurement();
  expect(model.confirm(frame(), 1000)).toEqual({ ok: true, result: null });
  return model;
}

describe('원본 방식의 기준점→상단 측정 — 합성 좌표, 실측 아님', () => {
  it('실제 바닥을 먼저 기록하고 상단 단계로 넘어간다', () => {
    const model = new BaseTopMeasurement();
    expect(model.getState()).toEqual({ step: 'base', base: null, result: null });
    expect(model.preview(frame(), 1000)).toEqual({ ok: false, reason: 'base-required' });
    expect(model.canConfirm(frame(), 1000)).toBe(true);
    expect(model.confirm(frame(), 1000)).toEqual({ ok: true, result: null });
    expect(model.getState()).toMatchObject({ step: 'top', base: { position: { y: 0 } }, result: null });
  });

  it.each([
    ['no-hit', (f: AimFrame) => { f.hit = null; f.hitState = 'none'; }],
    ['non-horizontal-base', (f: AimFrame) => { f.hit!.normalY = 0; }],
    ['base-not-below-camera', (f: AimFrame) => { f.hit!.position.y = 1.4; }],
    ['base-too-close', (f: AimFrame) => { f.hit!.position.z = -.1; }],
  ] as const)('바닥 단계에서 %s를 차단한다', (reason, change) => {
    const model = new BaseTopMeasurement();
    const value = frame(); change(value);
    expect(model.getRejectionReason(value, 1000)).toBe(reason);
    expect(model.confirm(value, 1000)).toEqual({ ok: false, reason });
    expect(model.getState().step).toBe('base');
  });

  it('상단의 수직 벽 hit를 허용하고 대각선 대신 Y 차이를 m/cm로 계산한다', () => {
    const model = based();
    const top = frame(1100, 2.4);
    top.hit!.position.x = 3; top.hit!.position.z = 2;
    expect(model.canConfirm(top, 1100)).toBe(true);
    const live = model.preview(top, 1100);
    expect(live).toMatchObject({ ok: true, result: {
      meters: 2.4, centimeters: 240, lateralMeters: 5,
      source: 'webxr-plane-hit', accuracy: 'unverified', top: { y: 2.4 },
    } });
    expect(model.getState().step).toBe('top'); // Preview never commits.
    expect(model.confirm(top, 1100)).toMatchObject({ ok: true, result: { meters: 2.4 } });
    expect(model.getState().step).toBe('result');
  });

  it('상단은 바닥 위에 있으면 휴대폰보다 낮아도 허용한다', () => {
    expect(based().preview(frame(1100, .8), 1100)).toMatchObject({ ok: true, result: { meters: .8, source: 'webxr-plane-hit' } });
  });

  it('상단 hit가 없고 현재 추적 ray가 유효하면 가상 수직면 추정값으로 구분한다', () => {
    const model = based();
    const value = frame(1100, null);
    expect(model.preview(value, 1100)).toMatchObject({ ok: true, result: {
      meters: 2.4, centimeters: 240, source: 'virtual-vertical-plane', accuracy: 'unverified',
      top: { x: 0, y: 2.4, z: -2 }, timestamp: 1100,
    } });
    expect(model.confirm(value, 1100)).toMatchObject({ ok: true, result: { source: 'virtual-vertical-plane' } });
  });

  it('휴대폰이 옆으로 움직여도 기준점을 저장할 때 만든 수직면을 유지한다', () => {
    const model = based();
    const value = frame(1100, null); value.origin.x = 1;
    const result = model.preview(value, 1100);
    expect(result).toMatchObject({ ok: true, result: { meters: 2.4, top: { x: 1, y: 2.4, z: -2 } } });
  });

  it('가상면 추정은 실제 상단의 깊이를 알아낸 결과라고 표시하지 않는다', () => {
    const result = based().preview(frame(1100, null), 1100);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected estimate');
    // The same ray could point to an object behind the assumed z=-2 plane.
    // Geometry alone cannot determine its actual depth, so it remains an estimate.
    expect(result.result.source).toBe('virtual-vertical-plane');
    expect(result.result.accuracy).toBe('unverified');
  });

  it.each([0, -.5, .005])('가까운 실제 hit의 높이차 %s는 가상면으로 우회하지 않는다', height => {
    const model = based();
    const value = frame(1100, height); value.direction = unit(0, 1, -2);
    expect(model.preview(value, 1100)).toEqual({ ok: false, reason: 'top-not-above-base' });
    expect(model.confirm(value, 1100)).toEqual({ ok: false, reason: 'top-not-above-base' });
    expect(model.getState().step).toBe('top');
  });

  it('가까운 hit가 무효이면 hit 없음으로 간주해 가상면으로 우회하지 않는다', () => {
    const model = based(); const value = frame(1100, null); value.hitState = 'invalid';
    expect(model.preview(value, 1100)).toEqual({ ok: false, reason: 'invalid-hit' });
    expect(model.getState().step).toBe('top');
  });

  it.each(['none', 'valid'] as const)('hitState %s와 실제 hit 유무가 다르면 차단한다', hitState => {
    const value = frame(1100, hitState === 'none' ? 2.4 : null); value.hitState = hitState;
    expect(based().preview(value, 1100)).toEqual({ ok: false, reason: 'invalid-hit' });
  });

  it.each(['timestamp', 'sessionId', 'epoch', 'viewerY'] as const)('직접 hit와 현재 frame의 %s가 다르면 조합하지 않는다', key => {
    const value = frame(1100, 2.4);
    if (key === 'sessionId') value.hit![key] = 'other'; else value.hit![key] += 1;
    expect(based().preview(value, 1100)).toEqual({ ok: false, reason: 'hit-frame-mismatch' });
  });

  it('실제 hit의 NaN 법선·좌표·잘못된 출처는 가상면으로 우회하지 않는다', () => {
    for (const alter of [
      (f: AimFrame) => { f.hit!.position.x = NaN; },
      (f: AimFrame) => { f.hit!.normalY = NaN; },
      (f: AimFrame) => { f.hit!.source = 'virtual-vertical-plane' as never; },
    ]) {
      const value = frame(1100, 2.4); alter(value);
      expect(based().preview(value, 1100)).toEqual({ ok: false, reason: 'invalid-hit' });
    }
  });

  it.each([
    ['parallel-ray', unit(1, 1, 0)],
    ['parallel-ray', unit(1, 1, -.01)],
    ['behind-camera', unit(0, 1, 2)],
    ['top-not-above-base', unit(0, -3, -2)],
  ] as const)('가상면과 광선의 %s 계산을 차단한다', (reason, direction) => {
    const value = frame(1100, null); value.direction = direction;
    expect(based().preview(value, 1100)).toEqual({ ok: false, reason });
  });

  it('카메라가 가상면 위에 있거나 교점이 너무 멀면 차단한다', () => {
    const onPlane = frame(1100, null); onPlane.origin.z = -2;
    expect(based().preview(onPlane, 1100)).toEqual({ ok: false, reason: 'behind-camera' });
    const tooFar = frame(1100, null); tooFar.origin.z = 40;
    expect(based().preview(tooFar, 1100)).toEqual({ ok: false, reason: 'intersection-too-far' });
  });

  it('바닥 기록은 오래되어도 연속 추적 중 현재 상단 ray만 새 것이면 계산한다', () => {
    expect(based().preview(frame(9000, null), 9000)).toMatchObject({ ok: true, result: { meters: 2.4 } });
  });

  it('250ms 경계·미래 시각·확정 직전 오래된 ray를 차단한다', () => {
    const model = based(); const value = frame(1100, null);
    expect(model.preview(value, 1350).ok).toBe(true);
    expect(model.confirm(value, 1351)).toEqual({ ok: false, reason: 'stale-frame' });
    expect(model.getState().step).toBe('base');
    expect(new BaseTopMeasurement().confirm(frame(), 999)).toEqual({ ok: false, reason: 'future-frame' });
  });

  it('미추적 frame은 이전 바닥을 지워 복구한 상단과 결합하지 않는다', () => {
    const model = based();
    expect(model.preview(null, 1100)).toEqual({ ok: false, reason: 'no-frame' });
    expect(model.getState().step).toBe('base');
    expect(model.confirm(frame(1200, null), 1200)).toEqual({ ok: false, reason: 'no-hit' });
  });

  it.each(['sessionId', 'epoch'] as const)('현재 frame의 %s 변경은 이전 기준점을 초기화한다', key => {
    const model = based(); const value = frame(1100, null);
    if (key === 'sessionId') value.sessionId = 'other'; else value.epoch += 1;
    expect(model.confirm(value, 1100)).toEqual({ ok: false, reason: 'coordinate-space-changed' });
    expect(model.getState().step).toBe('base');
  });

  it('잘못된 ray·시계·좌표는 결과를 만들지 않는다', () => {
    const changes: Array<(f: AimFrame) => void> = [
      f => { f.origin.x = NaN; }, f => { f.direction = { x: 0, y: 0, z: 0 }; },
      f => { f.direction.z = Infinity; }, f => { f.direction = { x: 0, y: 1, z: -2 }; },
      f => { f.source = 'simulated' as never; }, f => { f.viewerY = NaN; },
      f => { f.sessionId = ''; }, f => { f.epoch = -1; },
    ];
    for (const change of changes) {
      const value = frame(1100, null); change(value);
      expect(based().preview(value, 1100)).toEqual({ ok: false, reason: 'invalid-frame' });
    }
    expect(based().preview(frame(1100, null), NaN)).toEqual({ ok: false, reason: 'invalid-frame' });
  });

  it('완료 결과는 불변 복사이며 재측정은 기준점·결과를 모두 지운다', () => {
    const model = based();
    const top = frame(1100, 2.4); const result = model.confirm(top, 1100);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.result) throw new Error('result missing');
    result.result.top.y = 500; result.result.base.position.y = -50; top.hit!.position.y = 99;
    expect(model.getState().result).toMatchObject({ meters: 2.4, top: { y: 2.4 }, base: { position: { y: 0 } } });
    expect(model.confirm(frame(1200, 3), 1200)).toEqual({ ok: false, reason: 'already-complete' });
    model.reset(); expect(model.getState()).toEqual({ step: 'base', base: null, result: null });
    expect(model.confirm(frame(1300), 1300)).toEqual({ ok: true, result: null });
    model.invalidate(); expect(model.getState().step).toBe('base');
  });

  it('입력 기준점과 반환 state 변경이 저장한 기준 높이나 평면을 바꾸지 않는다', () => {
    const model = new BaseTopMeasurement(); const base = frame();
    model.confirm(base, 1000); base.hit!.position.y = 10; base.origin.z = 100;
    const state = model.getState(); state.base!.position.y = 20;
    expect(model.preview(frame(1100, null), 1100)).toMatchObject({ ok: true, result: { meters: 2.4, base: { position: { y: 0 } } } });
  });

  it('수평 침대 윗면과 상단 문틀의 실제 정체를 기하 정보만으로 판정하지 못한다', () => {
    const model = new BaseTopMeasurement();
    expect(model.confirm(frame(1000, .5), 1000)).toEqual({ ok: false, reason: 'non-horizontal-base' });
    const bed = frame(1000, .5); bed.hit!.normalY = 1;
    expect(model.confirm(bed, 1000)).toEqual({ ok: true, result: null });
    expect(model.preview(frame(1100, 2.1), 1100)).toMatchObject({ ok: true, result: { meters: 1.6, source: 'webxr-plane-hit', accuracy: 'unverified' } });
  });
});
