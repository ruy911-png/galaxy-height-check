// @vitest-environment jsdom
// Synthetic XR frames verify the UI contract, never actual camera accuracy.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArUpdate } from '../src/arDiagnostic';
import type { AimFrame } from '../src/baseTopMeasurement';
import type { MeasurementHit } from '../src/measurement';
import BaseTopMeasurementPanel from '../src/BaseTopMeasurementPanel';

type MockEngine = {
  options: { measurementMode?: string; onUpdate: (update: ArUpdate) => void };
  frame: AimFrame | null;
  emit: (phase: ArUpdate['phase'], message?: string) => void;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getCurrentAimFrame: ReturnType<typeof vi.fn>;
};
const hardware = vi.hoisted(() => ({ instances: [] as MockEngine[] }));
vi.mock('../src/arDiagnostic', () => ({
  ArDiagnostic: class {
    frame: AimFrame | null = null;
    constructor(public options: MockEngine['options']) { hardware.instances.push(this); }
    emit = (phase: ArUpdate['phase'], message = `모의 상태: ${phase}`) => {
      this.options.onUpdate({ phase, message, canConfirm: phase === 'surface', hitCount: 0 });
    };
    start = vi.fn(async () => this.emit('starting'));
    stop = vi.fn(async () => { this.emit('stopping'); this.emit('ended'); });
    getCurrentAimFrame = vi.fn(() => this.frame);
  },
}));
let now: number;
beforeEach(() => {
  hardware.instances.length = 0;
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function hit(y: number, extra: Partial<MeasurementHit> = {}): MeasurementHit {
  return { position: { x: 0, y, z: -2 }, normalY: 1, viewerY: 1.4, timestamp: now, sessionId: 'run-a', epoch: 0, source: 'webxr-plane-hit', ...extra };
}
function frame(y = 0, extra: Partial<AimFrame> = {}): AimFrame {
  const dy = y - 1.4, length = Math.hypot(dy, 2);
  return { origin: { x: 0, y: 1.4, z: 0 }, direction: { x: 0, y: dy / length, z: -2 / length }, viewerY: 1.4, timestamp: now, sessionId: 'run-a', epoch: 0, source: 'webxr-view-ray', hitState: 'valid', hit: hit(y), ...extra };
}
function emit(engine: MockEngine, input: AimFrame | null, phase: ArUpdate['phase'] = input?.hit ? 'surface' : 'searching', message?: string) {
  act(() => { engine.frame = input; engine.emit(phase, message); });
}
const startButton = () => screen.getByRole('button', { name: '높이 측정 시작' }) as HTMLButtonElement;
const baseButton = () => screen.getByRole('button', { name: '바닥 기준점 지정' }) as HTMLButtonElement;
const topButton = () => screen.getByRole('button', { name: '상단 지정' }) as HTMLButtonElement;
function start() {
  const onBeforeStart = vi.fn(), onActivityChange = vi.fn();
  render(<BaseTopMeasurementPanel supported onBeforeStart={onBeforeStart} onActivityChange={onActivityChange} />);
  fireEvent.click(startButton());
  return { engine: hardware.instances.at(-1)!, onBeforeStart, onActivityChange };
}
function base(engine: MockEngine) {
  emit(engine, frame());
  expect(baseButton().disabled).toBe(false);
  fireEvent.click(baseButton());
  expect(topButton()).toBeTruthy();
}
async function confirmTop(engine: MockEngine, input = frame(2.4, { hit: hit(2.4, { normalY: 0 }) })) {
  emit(engine, input);
  expect(topButton().disabled).toBe(false);
  await act(async () => fireEvent.click(topButton()));
}

describe('원본처럼 기준점에서 상단으로 — 모의 AR UI', () => {
  it('앱 안에서 두 단계 사용법과 추정값의 가정을 설명한다', () => {
    render(<BaseTopMeasurementPanel supported onBeforeStart={vi.fn()} onActivityChange={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '기준점에서 위로 높이 측정' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /바닥을 지정한 뒤 위로 기울여 상단을 지정/ })).toBeTruthy();
    expect(screen.getByText(/한 화면에 모두 담을 필요는 없어요/)).toBeTruthy();
    expect(screen.getByText(/가상의 수직면/)).toBeTruthy();
  });
  it('지원하지 않거나 다른 카메라 작업 중이면 시작하지 않는다', () => {
    const props = { onBeforeStart: vi.fn(), onActivityChange: vi.fn() };
    const { rerender } = render(<BaseTopMeasurementPanel supported={false} {...props} />);
    expect(startButton().disabled).toBe(true);
    rerender(<BaseTopMeasurementPanel supported blocked {...props} />);
    expect(startButton().disabled).toBe(true);
    fireEvent.click(startButton());
    expect(hardware.instances).toHaveLength(0);
  });
  it('원본 두 단계 모드로 시작하며 바닥 기준점 버튼부터 보여 준다', () => {
    const { engine, onBeforeStart } = start();
    expect(engine.options.measurementMode).toBe('base-top');
    expect(onBeforeStart.mock.invocationCallOrder[0]).toBeLessThan(engine.start.mock.invocationCallOrder[0]);
    expect(baseButton().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '상단 지정' })).toBeNull();
    expect(screen.queryByText('2.40 m')).toBeNull();
  });
  it('실제 바닥 표면 없이 시작할 때 가상 바닥을 만들지 않는다', () => {
    const { engine } = start();
    emit(engine, frame(0, { hitState: 'none', hit: null }));
    expect(baseButton().disabled).toBe(true);
    fireEvent.click(baseButton());
    expect(screen.queryByRole('button', { name: '상단 지정' })).toBeNull();
  });
  it('수직 벽의 상단점도 직접 높이로 표시하며 두 번째 탭 후 결과를 보존한다', async () => {
    const { engine, onActivityChange } = start();
    base(engine);
    now += 100;
    emit(engine, frame(2.4, { hit: hit(2.4, { normalY: 0 }) }));
    expect(screen.getByText('표면 인식 높이')).toBeTruthy();
    expect(screen.getByText('2.40 m')).toBeTruthy();
    expect(screen.getByText('240 cm')).toBeTruthy();
    expect(engine.stop).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(topButton()));
    expect(screen.getByText('2.40 m')).toBeTruthy();
    expect(onActivityChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: '다시 측정' })).toBeTruthy();
  });
  it('상단 hit가 없어도 현재 추적 광선이면 추정 높이라고 표시하고 확정한다', async () => {
    const { engine } = start();
    base(engine);
    now += 100;
    emit(engine, frame(2.4, { hitState: 'none', hit: null }), 'searching');
    expect(topButton().disabled).toBe(false);
    expect(screen.getByText('추정 높이')).toBeTruthy();
    expect(screen.getByText(/실제 천장 표면을 인식한 값은 아니에요/)).toBeTruthy();
    expect(screen.getByText('2.40 m')).toBeTruthy();
    await act(async () => fireEvent.click(topButton()));
    expect(screen.getByText('추정 높이')).toBeTruthy();
    expect(screen.getByText(/가상의 수직면/)).toBeTruthy();
    expect(screen.getByText('2.40 m')).toBeTruthy();
  });
  it('직접 표면과 추정 계산이 전환될 때 출처 표시도 바뀐다', () => {
    const { engine } = start(); base(engine);
    now += 100; emit(engine, frame(2.4));
    expect(screen.getByText('표면 인식 높이')).toBeTruthy();
    now += 100; emit(engine, frame(2.4, { hitState: 'none', hit: null }));
    expect(screen.queryByText('표면 인식 높이')).toBeNull();
    expect(screen.getByText('추정 높이')).toBeTruthy();
    now += 100; emit(engine, frame(2.4));
    expect(screen.queryByText('추정 높이')).toBeNull();
    expect(screen.getByText('표면 인식 높이')).toBeTruthy();
  });
  it('유효하지 않은 가장 가까운 면이 있으면 가상 평면으로 우회하지 않는다', () => {
    const { engine } = start(); base(engine);
    now += 100; emit(engine, frame(2.4, { hitState: 'invalid', hit: null }));
    expect(topButton().disabled).toBe(true);
    expect(screen.queryByText('2.40 m')).toBeNull();
    expect(screen.queryByText('추정 높이')).toBeNull();
  });
  it('표시된 버튼이 켜져 있어도 클릭 시 오래된 광선이면 확정하지 않는다', async () => {
    const { engine } = start(); base(engine);
    now += 100; emit(engine, frame(2.4, { hitState: 'none', hit: null }));
    expect(topButton().disabled).toBe(false);
    now += 251;
    await act(async () => fireEvent.click(topButton()));
    expect(engine.getCurrentAimFrame).toHaveBeenCalled();
    expect(engine.stop).not.toHaveBeenCalled();
    expect(screen.queryByText('2.40 m')).toBeNull();
  });
  it('표시된 버튼이 켜져 있어도 클릭 순간 추적 광선이 없으면 이전 바닥도 지운다', () => {
    const { engine } = start(); base(engine);
    now += 100; emit(engine, frame(2.4));
    engine.frame = null;
    fireEvent.click(topButton());
    expect(baseButton().disabled).toBe(true);
    expect(screen.queryByText('2.40 m')).toBeNull();
    expect(engine.stop).not.toHaveBeenCalled();
  });
  it.each(['tracking-lost', 'paused', 'reset', 'error'] as const)('%s 후에는 이전 바닥과 새 상단을 합치지 않는다', phase => {
    const { engine } = start(); base(engine);
    now += 100; emit(engine, frame(2.4));
    act(() => engine.emit(phase));
    expect(screen.queryByText('2.40 m')).toBeNull();
    if (phase === 'tracking-lost' || phase === 'paused') {
      expect(baseButton().disabled).toBe(true);
      expect(screen.queryByRole('button', { name: '상단 지정' })).toBeNull();
    } else expect(startButton().disabled).toBe(false);
  });
  it('중단 알림 없이 epoch가 바뀌어도 기준점을 초기화한다', () => {
    const { engine } = start(); base(engine);
    now += 100;
    emit(engine, frame(2.4, { epoch: 1, hit: hit(2.4, { epoch: 1 }) }));
    expect(baseButton().disabled).toBe(true);
    expect(screen.queryByText('2.40 m')).toBeNull();
  });
  it('재측정은 결과를 지우고 새 세션에서 기준점부터 시작한다', async () => {
    const { engine } = start(); base(engine); now += 100; await confirmTop(engine);
    fireEvent.click(screen.getByRole('button', { name: '다시 측정' }));
    expect(hardware.instances).toHaveLength(2);
    expect(screen.queryByText('2.40 m')).toBeNull();
    expect(baseButton().disabled).toBe(true);
    act(() => engine.emit('ended'));
    expect(baseButton()).toBeTruthy();
  });
  it('네이티브 종료가 실패하면 새 세션을 열지 않고 종료 재시도를 허용한다', async () => {
    const { engine, onActivityChange } = start();
    engine.stop.mockImplementation(async () => engine.emit('stopping'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '높이 측정 종료' })));
    expect(onActivityChange).toHaveBeenLastCalledWith(true);
    expect(startButton().disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '높이 측정 종료' })));
    expect(engine.stop).toHaveBeenCalledTimes(2);
  });
  it('늦게 종료되는 동안 다시 측정 버튼을 잠근다', async () => {
    const { engine } = start(); base(engine);
    let resolve!: () => void;
    const pending = new Promise<void>(ok => { resolve = ok; });
    engine.stop.mockImplementation(() => { engine.emit('stopping'); return pending; });
    now += 100; emit(engine, frame(2.4));
    fireEvent.click(topButton());
    act(() => engine.emit('ended'));
    expect((screen.getByRole('button', { name: '다시 측정' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolve(); await pending; });
    await waitFor(() => expect((screen.getByRole('button', { name: '다시 측정' }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('여러 프레임 중간값 — 모의 AR UI, 실측 아님', () => {
  const wall = (y: number) => frame(y, { hit: hit(y, { normalY: 0 }) });
  it('바닥을 누르는 순간 흔들려도 직전의 안정된 바닥 화면들을 기준점으로 쓴다', async () => {
    const { engine } = start();
    for (let i = 0; i < 3; i += 1) { emit(engine, frame()); now += 33; }
    emit(engine, frame(.04));
    fireEvent.click(baseButton());
    now += 100;
    await confirmTop(engine);
    expect(screen.getByText('240 cm')).toBeTruthy();
  });
  it('상단에 안정된 화면 여러 개를 썼으면 결과에 중간값 사용을 알린다', async () => {
    const { engine } = start();
    base(engine);
    now += 100;
    for (const y of [2.4, 2.41]) { emit(engine, wall(y)); now += 33; }
    await confirmTop(engine, wall(2.39));
    expect(screen.getByText('240 cm')).toBeTruthy();
    expect(screen.getByText(/지정 직전 3개 화면의 중간값/)).toBeTruthy();
  });
  it('한 화면만 썼으면 중간값 안내를 보이지 않는다', async () => {
    const { engine } = start();
    base(engine);
    now += 100;
    await confirmTop(engine);
    expect(screen.queryByText(/중간값/)).toBeNull();
  });
});
