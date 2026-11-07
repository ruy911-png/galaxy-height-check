import { describe, expect, it } from 'vitest';
import {
  calculateVerticalHeight,
  HeightMeasurement,
  type MeasurementHit,
} from '../src/measurement';

// Known coordinates are synthetic test inputs, never camera or accuracy evidence.
const horizontalLimit = Math.cos(20 * Math.PI / 180);
const floorHit = (overrides: Partial<MeasurementHit> = {}): MeasurementHit => ({
  position: { x: 0, y: 0, z: -1 },
  normalY: 1,
  viewerY: 1.4,
  timestamp: 1000,
  sessionId: 'run-A',
  epoch: 0,
  source: 'webxr-plane-hit',
  ...overrides,
});
const ceilingHit = (overrides: Partial<MeasurementHit> = {}): MeasurementHit => ({
  ...floorHit(),
  position: { x: 0, y: 2.4, z: -1 },
  normalY: -1,
  timestamp: 1100,
  ...overrides,
});

function recordFloor(measurement: HeightMeasurement) {
  expect(measurement.confirm(floorHit(), 1000).ok).toBe(true);
  expect(measurement.getState().step).toBe('ceiling');
}

function recordResult(measurement: HeightMeasurement) {
  recordFloor(measurement);
  const confirmation = measurement.confirm(ceilingHit(), 1100);
  expect(confirmation.ok).toBe(true);
  expect(measurement.getState().step).toBe('result');
  return confirmation;
}

describe('중력 방향 높이와 단위 — 알려진 좌표의 순수 계산', () => {
  it('대각선 3m인 두 점에서 수직 높이 2.4m와 옆으로 벌어진 거리 1.8m를 구분한다', () => {
    const result = calculateVerticalHeight({ x: 0, y: 0, z: 0 }, { x: 1.8, y: 2.4, z: 0 });
    expect(result.meters).toBeCloseTo(2.4, 10);
    expect(result.centimeters).toBeCloseTo(240, 8);
    expect(result.lateralMeters).toBeCloseTo(1.8, 10);
    expect(result.meters).not.toBeCloseTo(3, 8);
  });

  it('바닥의 Y가 0이 아니어도 차이를 계산하고 공통 좌표 원점 이동의 영향을 받지 않는다', () => {
    const original = calculateVerticalHeight({ x: 2, y: -0.6, z: 4 }, { x: 2, y: 1.8, z: 4 });
    const translated = calculateVerticalHeight({ x: 7, y: 9.4, z: -3 }, { x: 7, y: 11.8, z: -3 });
    expect(original.meters).toBeCloseTo(2.4, 10);
    expect(translated.meters).toBeCloseTo(original.meters, 10);
    expect(original.lateralMeters).toBe(0);
  });

  it('m→cm 변환 시 100을 곱하고 계산 내부에서는 표시용 반올림을 하지 않는다', () => {
    const result = calculateVerticalHeight({ x: 0, y: 0, z: 0 }, { x: 0, y: 2.456789, z: 0 });
    expect(result.meters).toBeCloseTo(2.456789, 10);
    expect(result.centimeters).toBeCloseTo(245.6789, 8);
  });

  it('무한·NaN 좌표와 바닥 이하의 천장을 거부하고 절댓값으로 뒤집지 않는다', () => {
    const floor = { x: 0, y: 0, z: 0 };
    for (const ceiling of [
      { x: NaN, y: 2, z: 0 },
      { x: 0, y: Infinity, z: 0 },
      { x: 0, y: 2, z: -Infinity },
      { x: 1, y: 0, z: 1 },
      { x: 0, y: -2, z: 0 },
    ]) expect(() => calculateVerticalHeight(floor, ceiling)).toThrow();
    expect(() => calculateVerticalHeight({ x: 0, y: NaN, z: 0 }, { x: 0, y: 2, z: 0 })).toThrow();
  });
});

describe('실제 hit를 받는 측정 상태 계약 — 하드웨어 검증 아님', () => {
  it('바닥→천장→결과 순서를 지키고 결과에는 직접 hit 출처와 정확도 미검증을 남긴다', () => {
    const measurement = new HeightMeasurement();
    expect(measurement.getState()).toEqual({ step: 'floor', floor: null, result: null });
    expect(measurement.confirm(null, 1000).ok).toBe(false);
    recordFloor(measurement);
    expect(measurement.getState().result).toBeNull();
    const confirmation = measurement.confirm(ceilingHit(), 1100);
    expect(confirmation.ok).toBe(true);
    if (!confirmation.ok) throw new Error('Expected a successful ceiling confirmation');
    expect(confirmation.result).toMatchObject({ meters: 2.4, centimeters: 240, lateralMeters: 0, source: 'webxr-plane-hit', accuracy: 'unverified' });
    expect(measurement.getState().step).toBe('result');
    expect(measurement.canConfirm(ceilingHit(), 1100)).toBe(false);
    expect(measurement.confirm(ceilingHit(), 1100).ok).toBe(false);
  });

  it('후보 좌표는 250ms까지 허용하고 251ms·미래 시각·비정상 시계에서는 거부한다', () => {
    const measurement = new HeightMeasurement();
    expect(measurement.canConfirm(floorHit(), 1250)).toBe(true);
    expect(measurement.canConfirm(floorHit(), 1251)).toBe(false);
    expect(measurement.confirm(floorHit(), 1251).ok).toBe(false);
    expect(measurement.canConfirm(floorHit(), 999)).toBe(false);
    expect(measurement.canConfirm(floorHit(), Infinity)).toBe(false);
    expect(measurement.getState().step).toBe('floor');
  });

  it('손상된 위치·법선·카메라 높이·시각·좌표계 식별자와 가상 평면 출처를 거부한다', () => {
    const invalidHits: MeasurementHit[] = [
      floorHit({ position: { x: NaN, y: 0, z: 0 } }),
      floorHit({ normalY: Infinity }),
      floorHit({ normalY: 1.1 }),
      floorHit({ viewerY: NaN }),
      floorHit({ timestamp: Infinity }),
      floorHit({ sessionId: '' }),
      floorHit({ sessionId: '  ' }),
      floorHit({ epoch: -1 }),
      floorHit({ epoch: 0.5 }),
      floorHit({ source: 'virtual-plane' as MeasurementHit['source'] }),
    ];
    for (const hit of invalidHits) {
      const measurement = new HeightMeasurement();
      expect(measurement.canConfirm(hit, 1000)).toBe(false);
      const confirmation = measurement.confirm(hit, 1000);
      expect(confirmation.ok).toBe(false);
      if (!confirmation.ok) expect(confirmation.reason.length).toBeGreaterThan(0);
      expect(measurement.getState().floor).toBeNull();
    }
  });

  it('현재 방향에 hit가 없거나 후보가 오래되면 확정을 막되 이미 찍은 바닥은 보존한다', () => {
    const measurement = new HeightMeasurement();
    recordFloor(measurement);
    const before = measurement.getState();
    expect(measurement.canConfirm(null, 1100)).toBe(false);
    expect(measurement.confirm(null, 1100).ok).toBe(false);
    expect(measurement.confirm(ceilingHit(), 1351).ok).toBe(false);
    expect(measurement.getState()).toEqual(before);
  });

  it('수평면에서 20도 경계를 포함하고 벽·그보다 기운 면은 거부하며 법선 부호만으로 면을 구분하지 않는다', () => {
    const measurement = new HeightMeasurement();
    expect(measurement.canConfirm(floorHit({ normalY: horizontalLimit }), 1000)).toBe(true);
    expect(measurement.canConfirm(floorHit({ normalY: -horizontalLimit }), 1000)).toBe(true);
    expect(measurement.canConfirm(floorHit({ normalY: horizontalLimit - 0.000001 }), 1000)).toBe(false);
    expect(measurement.canConfirm(floorHit({ normalY: 0 }), 1000)).toBe(false);
    expect(measurement.confirm(floorHit({ normalY: -1 }), 1000).ok).toBe(true);
    expect(measurement.confirm(ceilingHit({ normalY: 1 }), 1100).ok).toBe(true);
  });

  it('바닥은 카메라보다 5cm 넘게 아래, 천장은 5cm 넘게 위이며 바닥보다 높아야 한다', () => {
    const measurement = new HeightMeasurement();
    expect(measurement.canConfirm(floorHit({ viewerY: 0.05 }), 1000)).toBe(false);
    expect(measurement.canConfirm(floorHit({ viewerY: 0.051 }), 1000)).toBe(true);
    recordFloor(measurement);
    expect(measurement.canConfirm(ceilingHit({ position: { x: 0, y: 0.05, z: 0 }, viewerY: 0 }), 1100)).toBe(false);
    expect(measurement.canConfirm(ceilingHit({ position: { x: 0, y: 0, z: 0 }, viewerY: -1 }), 1100)).toBe(false);
    expect(measurement.confirm(floorHit({ timestamp: 1100 }), 1100).ok).toBe(false);
    expect(measurement.getState().step).toBe('ceiling');
  });

  it('추적이 이어지면 바닥 기록이 오래되고 카메라 높이·위치가 바뀌어도 같은 좌표계의 새 천장을 사용할 수 있다', () => {
    const measurement = new HeightMeasurement();
    recordFloor(measurement);
    const confirmation = measurement.confirm(ceilingHit({
      position: { x: 1.8, y: 2.4, z: -1 },
      viewerY: 1.8,
      timestamp: 11000,
    }), 11000);
    expect(confirmation.ok).toBe(true);
    if (!confirmation.ok) throw new Error('Expected continuous tracking to preserve floor');
    expect(confirmation.result?.meters).toBeCloseTo(2.4, 10);
    expect(confirmation.result?.lateralMeters).toBeCloseTo(1.8, 10);
  });

  it('새 세션에서 epoch 숫자가 같아도 이전 바닥과 결합하지 않고 전체 측정을 초기화한다', () => {
    const measurement = new HeightMeasurement();
    recordFloor(measurement);
    expect(measurement.canConfirm(ceilingHit({ sessionId: 'run-B', epoch: 0 }), 1100)).toBe(false);
    expect(measurement.confirm(ceilingHit({ sessionId: 'run-B', epoch: 0 }), 1100).ok).toBe(false);
    expect(measurement.getState()).toEqual({ step: 'floor', floor: null, result: null });
  });

  it('세션이 같아도 추적 epoch가 달라지면 이전 바닥과 결합하지 않고 초기화한다', () => {
    const measurement = new HeightMeasurement();
    recordFloor(measurement);
    expect(measurement.confirm(ceilingHit({ epoch: 1 }), 1100).ok).toBe(false);
    expect(measurement.getState()).toEqual({ step: 'floor', floor: null, result: null });
  });

  it('추적 상실·좌표계 reset·세션 종료를 전달받으면 바닥과 결과를 모두 무효화한다', () => {
    for (const completed of [false, true]) {
      const measurement = new HeightMeasurement();
      if (completed) recordResult(measurement); else recordFloor(measurement);
      measurement.invalidate();
      expect(measurement.getState()).toEqual({ step: 'floor', floor: null, result: null });
      expect(measurement.confirm(ceilingHit(), 1100).ok).toBe(false);
    }
  });

  it('재측정은 이전 바닥·결과를 지우고 새 바닥부터 시작한다', () => {
    const measurement = new HeightMeasurement();
    recordResult(measurement);
    measurement.reset();
    expect(measurement.getState()).toEqual({ step: 'floor', floor: null, result: null });
    expect(measurement.confirm(ceilingHit(), 1100).ok).toBe(false);
    expect(measurement.confirm(floorHit({ timestamp: 1200 }), 1200).ok).toBe(true);
    expect(measurement.getState().step).toBe('ceiling');
    expect(measurement.getState().result).toBeNull();
  });

  it('입력·조회 상태·반환 결과를 변경해도 보관한 바닥과 결과 좌표가 변하지 않는다', () => {
    const measurement = new HeightMeasurement();
    const floor = floorHit();
    measurement.confirm(floor, 1000);
    floor.position.y = 99;
    const state = measurement.getState();
    state.floor!.position.y = 88;
    state.floor!.epoch = 17;
    expect(measurement.getState().floor?.position.y).toBe(0);
    const confirmation = measurement.confirm(ceilingHit(), 1100);
    expect(confirmation.ok).toBe(true);
    if (!confirmation.ok || !confirmation.result) throw new Error('Expected stored result');
    confirmation.result.floor.position.y = 77;
    confirmation.result.ceiling.position.y = 66;
    confirmation.result.meters = 55;
    const resultState = measurement.getState();
    resultState.result!.ceiling.position.y = 44;
    expect(measurement.getState().result?.floor.position.y).toBe(0);
    expect(measurement.getState().result?.ceiling.position.y).toBe(2.4);
    expect(measurement.getState().result?.meters).toBe(2.4);
  });
});
