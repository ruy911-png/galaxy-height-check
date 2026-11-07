import { describe, expect, it } from 'vitest';
import { AutoHeightMeasurement, type AutoPair } from '../src/autoMeasurement';
import type { MeasurementHit } from '../src/measurement';

// Synthetic plane coordinates verify the contract, not camera accuracy or labels.
function pair(timestamp: number, floorY = 0, ceilingY = 2.4): AutoPair {
  const common = { viewerY: 1.3, timestamp, sessionId: 'session-a', epoch: 0, source: 'webxr-plane-hit' as const };
  return {
    floor: { ...common, position: { x: 0, y: floorY, z: -2 }, normalY: 1 },
    ceiling: { ...common, position: { x: 1.8, y: ceilingY, z: -2 }, normalY: -1 },
  };
}

function warmUp(model: AutoHeightMeasurement, start = 1000, floorY = 0, ceilingY = 2.4) {
  let reading = model.update(pair(start, floorY, ceilingY), start);
  for (let offset = 100; offset <= 1000; offset += 100) {
    reading = model.update(pair(start + offset, floorY, ceilingY), start + offset);
  }
  return reading;
}

describe('한 화면의 동시 두 표면 — 합성 입력, 실측 아님', () => {
  it('처음부터 높이를 확정하지 않고 1초 이상 이어진 서로 다른 10개 이상 프레임을 기다린다', () => {
    const model = new AutoHeightMeasurement();
    const first = model.update(pair(1000), 1000);
    expect(first).toMatchObject({ status: 'stabilizing', result: null, progress: 0 });
    for (let time = 1100; time <= 1900; time += 100) {
      expect(model.update(pair(time), time).result).toBeNull();
    }
    const ready = model.update(pair(2000), 2000);
    expect(ready.status).toBe('ready');
    expect(ready.progress).toBe(1);
    expect(ready.result).toMatchObject({ meters: 2.4, centimeters: 240, lateralMeters: 1.8, accuracy: 'unverified', source: 'webxr-plane-hit' });
    expect(ready.result?.meters).not.toBe(3);
  });

  it('1초가 지났더라도 다섯 프레임만 있으면 안정된 값으로 표시하지 않는다', () => {
    const model = new AutoHeightMeasurement();
    for (const time of [1000, 1250, 1500, 1750, 2000]) {
      expect(model.update(pair(time), time).result).toBeNull();
    }
    expect(model.update(pair(2100), 2100).status).toBe('stabilizing');
  });

  it('같은 프레임 재전달은 프레임 수나 안정 시간을 늘리지 않는다', () => {
    const model = new AutoHeightMeasurement();
    model.update(pair(1000), 1000);
    for (let time = 1010; time <= 1250; time += 10) {
      expect(model.update(pair(1000), time)).toMatchObject({ status: 'stabilizing', progress: 0, result: null });
    }
    expect(model.update(pair(1250), 1250).result).toBeNull();
  });

  it.each(['floor', 'ceiling'] as const)('%s hit가 사라지면 이전 결과를 즉시 버리고 복구 후 처음부터 기다린다', (side) => {
    const model = new AutoHeightMeasurement();
    expect(warmUp(model).status).toBe('ready');
    const missing = pair(2100);
    missing[side] = null;
    expect(model.update(missing, 2100)).toMatchObject({ status: 'searching', reason: `missing-${side}`, result: null, progress: 0 });
    expect(model.update(pair(2200), 2200)).toMatchObject({ status: 'stabilizing', result: null, progress: 0 });
  });

  it('두 hit가 모두 없으면 후보 높이를 만들지 않는다', () => {
    expect(new AutoHeightMeasurement().update({ floor: null, ceiling: null }, 1000)).toEqual({ status: 'searching', reason: 'missing-both', result: null, progress: 0 });
  });

  it.each(['timestamp', 'sessionId', 'epoch', 'viewerY'] as const)('같은 프레임의 %s를 공유하지 않는 두 hit를 결합하지 않는다', (key) => {
    const input = pair(1000);
    if (key === 'sessionId') input.ceiling!.sessionId = 'session-b';
    else input.ceiling![key] += 1;
    expect(new AutoHeightMeasurement().update(input, 1001)).toMatchObject({ status: 'blocked', result: null, progress: 0 });
  });

  it.each(['floor', 'ceiling'] as const)('%s의 수직 벽·문틀·창틀 표면은 차단하고 이전 결과도 남기지 않는다', (side) => {
    const model = new AutoHeightMeasurement();
    expect(warmUp(model).status).toBe('ready');
    const input = pair(2100);
    input[side]!.normalY = 0;
    expect(model.update(input, 2100)).toMatchObject({ status: 'blocked', reason: `${side}:non-horizontal`, result: null });
    expect(model.update(pair(2200), 2200).progress).toBe(0);
  });

  it('침대 윗면처럼 카메라 아래의 후보를 천장으로 사용하지 않는다', () => {
    const reading = new AutoHeightMeasurement().update(pair(1000, 0, 0.6), 1000);
    expect(reading).toMatchObject({ status: 'blocked', reason: 'ceiling:ceiling-not-above-camera', result: null });
  });

  it('카메라 위의 면을 바닥으로 사용하지 않는다', () => {
    expect(new AutoHeightMeasurement().update(pair(1000, 1.5, 2.4), 1000)).toMatchObject({ status: 'blocked', reason: 'floor:floor-not-below-camera', result: null });
  });

  it('250ms까지 허용하지만 251ms가 지난 hit와 미래 hit를 차단한다', () => {
    expect(new AutoHeightMeasurement().update(pair(1000), 1250).status).toBe('stabilizing');
    expect(new AutoHeightMeasurement().update(pair(1000), 1251)).toMatchObject({ status: 'blocked', reason: 'floor:stale-hit', result: null });
    expect(new AutoHeightMeasurement().update(pair(1000), 999)).toMatchObject({ status: 'blocked', reason: 'floor:future-hit', result: null });
    const model = new AutoHeightMeasurement();
    warmUp(model);
    expect(model.update(pair(2000), 2251).result).toBeNull();
  });

  it('NaN 좌표·법선·시계와 가상 출처를 거부한다', () => {
    const mutate: Array<(hit: MeasurementHit) => void> = [
      hit => { hit.position.y = NaN; },
      hit => { hit.normalY = NaN; },
      hit => { hit.source = 'virtual-plane' as MeasurementHit['source']; },
    ];
    for (const change of mutate) {
      const input = pair(1000);
      change(input.ceiling!);
      expect(new AutoHeightMeasurement().update(input, 1000)).toMatchObject({ status: 'blocked', result: null });
    }
    expect(new AutoHeightMeasurement().update(pair(1000), NaN).status).toBe('blocked');
  });

  it('새 세션 또는 epoch는 이전 안정 구간을 재사용하지 않는다', () => {
    for (const key of ['sessionId', 'epoch'] as const) {
      const model = new AutoHeightMeasurement();
      warmUp(model);
      const input = pair(2100);
      for (const hit of [input.floor!, input.ceiling!]) {
        if (key === 'sessionId') hit.sessionId = 'session-b';
        else hit.epoch = 1;
      }
      expect(model.update(input, 2100)).toMatchObject({ status: 'stabilizing', reason: 'coordinate-space-changed', result: null, progress: 0 });
    }
  });

  it('실제 프레임 간격이 250ms를 넘으면 오래된 안정 구간을 버린다', () => {
    const model = new AutoHeightMeasurement();
    warmUp(model);
    expect(model.update(pair(2251), 2251)).toMatchObject({ status: 'stabilizing', reason: 'frame-gap', result: null, progress: 0 });
  });

  it('시간 역전은 차단하고 다음 정상 프레임에서 새로 안정 시간을 센다', () => {
    const model = new AutoHeightMeasurement();
    warmUp(model);
    expect(model.update(pair(1999), 2000)).toMatchObject({ status: 'blocked', reason: 'out-of-order-frame', result: null, progress: 0 });
    expect(model.update(pair(2100), 2100).progress).toBe(0);
  });

  it.each(['floor', 'ceiling'] as const)('%s의 Y가 기준에서 2.5cm를 넘게 움직이면 안정 구간을 다시 시작한다', (side) => {
    const model = new AutoHeightMeasurement();
    warmUp(model);
    const moved = pair(2100);
    moved[side]!.position.y += 0.026;
    expect(model.update(moved, 2100)).toMatchObject({ status: 'stabilizing', reason: 'height-moved', result: null, progress: 0 });
  });

  it('X·Z 이동은 높이로 합산하지 않으며 최신 동시 두 점으로 계속 갱신한다', () => {
    const model = new AutoHeightMeasurement();
    warmUp(model);
    const moved = pair(2100, 0.01, 2.42);
    moved.floor!.position.x = -10;
    moved.ceiling!.position.x = 20;
    const reading = model.update(moved, 2100);
    expect(reading.status).toBe('ready');
    expect(reading.result?.meters).toBeCloseTo(2.41, 8);
    expect(reading.result?.centimeters).toBeCloseTo(241, 8);
    expect(reading.result?.lateralMeters).toBe(30);
    expect(reading.result?.floor.timestamp).toBe(2100);
  });

  it('재측정 초기화는 이전 결과와 안정 구간을 지운다', () => {
    const model = new AutoHeightMeasurement();
    warmUp(model);
    model.reset();
    expect(model.update(pair(2100), 2100)).toMatchObject({ status: 'stabilizing', result: null, progress: 0 });
  });

  it('입력과 반환 결과 변경이 다음 결과 및 저장된 안정 기준을 바꾸지 않는다', () => {
    const model = new AutoHeightMeasurement();
    const first = pair(1000);
    model.update(first, 1000);
    first.floor!.position.y = 1;
    for (let time = 1100; time < 2000; time += 100) model.update(pair(time), time);
    const ready = model.update(pair(2000), 2000);
    expect(ready.status).toBe('ready');
    ready.result!.floor.position.y = 88;
    ready.result!.ceiling.position.y = 99;
    ready.result!.meters = 500;
    expect(model.update(pair(2000), 2010).result).toMatchObject({ meters: 2.4, floor: { position: { y: 0 } }, ceiling: { position: { y: 2.4 } } });
  });

  it('한계: 수평 침대 윗면은 실제 바닥과 구분할 수 없어 값은 미검증 후보로 남는다', () => {
    const reading = warmUp(new AutoHeightMeasurement(), 1000, 0.6, 2.4);
    expect(reading.status).toBe('ready');
    expect(reading.result?.meters).toBeCloseTo(1.8, 8);
    expect(reading.result?.accuracy).toBe('unverified');
  });

  it('한계: 카메라 위 수평 문틀 아랫면은 천장과 구분할 수 없어 값은 미검증 후보로 남는다', () => {
    const reading = warmUp(new AutoHeightMeasurement(), 1000, 0, 2.1);
    expect(reading.status).toBe('ready');
    expect(reading.result?.meters).toBeCloseTo(2.1, 8);
    expect(reading.result?.accuracy).toBe('unverified');
  });
});
