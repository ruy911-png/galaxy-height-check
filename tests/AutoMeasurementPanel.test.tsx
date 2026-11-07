// @vitest-environment jsdom
// Synthetic WebXR pairs test interaction and failure handling, not room accuracy.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArUpdate } from '../src/arDiagnostic';
import type { MeasurementHit } from '../src/measurement';
import AutoMeasurementPanel from '../src/AutoMeasurementPanel';

type Pair = { floor: MeasurementHit | null; ceiling: MeasurementHit | null };
type MockEngine = {
  pair: Pair;
  options: { measurementMode?: string; onUpdate: (update: ArUpdate) => void };
  emit: (phase: ArUpdate['phase']) => void;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getCurrentPair: ReturnType<typeof vi.fn>;
};
const hardware = vi.hoisted(() => ({ instances: [] as MockEngine[] }));
vi.mock('../src/arDiagnostic', () => ({
  ArDiagnostic: class {
    pair: Pair = { floor: null, ceiling: null };
    constructor(public options: MockEngine['options']) { hardware.instances.push(this); }
    emit = (phase: ArUpdate['phase']) => this.options.onUpdate({ phase, canConfirm: phase === 'surface', hitCount: phase === 'surface' ? 2 : 0, message: `모의 상태 ${phase}` });
    start = vi.fn(async () => { this.emit('starting'); });
    stop = vi.fn(async () => { this.emit('stopping'); this.emit('ended'); });
    getCurrentPair = vi.fn(() => this.pair);
  },
}));
let now = 1000;
beforeEach(() => {
  hardware.instances.length = 0;
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function hit(y: number, overrides: Partial<MeasurementHit> = {}): MeasurementHit {
  return { position: { x: 0, y, z: -2 }, normalY: 1, viewerY: 1.4, timestamp: now,
    sessionId: 'auto-session', epoch: 0, source: 'webxr-plane-hit', ...overrides };
}
function startPanel() {
  const onBeforeStart = vi.fn();
  const onActivityChange = vi.fn();
  render(<AutoMeasurementPanel supported onBeforeStart={onBeforeStart} onActivityChange={onActivityChange} />);
  fireEvent.click(screen.getByRole('button', { name: '높이 측정 시작' }));
  return { engine: hardware.instances.at(-1)!, onBeforeStart, onActivityChange };
}
function frame(engine: MockEngine, pair: Pair = { floor: hit(0), ceiling: hit(2.4) }, phase: ArUpdate['phase'] = 'surface') {
  act(() => { engine.pair = pair; engine.emit(phase); });
}
function stable(engine: MockEngine) {
  for (let i = 0; i <= 10; i++) { now += 100; frame(engine); }
}

describe('한 화면 자동 높이 UI — 모의 AR', () => {
  it('시작 전에 벽면 구도와 가구·문틀·창틀 구분 한계를 앱에서 설명한다', () => {
    render(<AutoMeasurementPanel supported onBeforeStart={vi.fn()} onActivityChange={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '한 화면에서 자동 계산' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /천장과 바닥을 한 화면/ })).toBeTruthy();
    expect(screen.getByText(/가구·문틀·창틀은 자동 구분하지 못해요/)).toBeTruthy();
    expect(screen.getByText(/뒤쪽에 안전한 공간/)).toBeTruthy();
    expect(screen.getByText(/창문 유리나 문틀/)).toBeTruthy();
    expect(screen.queryByText('2.40 m')).toBeNull();
  });
  it('지원하지 않거나 다른 카메라 사용 중이면 시작하지 않는다', () => {
    const props = { onBeforeStart: vi.fn(), onActivityChange: vi.fn() };
    const { rerender } = render(<AutoMeasurementPanel supported={false} {...props} />);
    const start = screen.getByRole('button', { name: '높이 측정 시작' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    rerender(<AutoMeasurementPanel supported blocked {...props} />);
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(hardware.instances).toHaveLength(0);
  });
  it('한 화면 모드로 시작하고 바닥·천장 지정 버튼을 요구하지 않는다', () => {
    const { engine, onBeforeStart, onActivityChange } = startPanel();
    expect(engine.options.measurementMode).toBe('single-view');
    expect(onBeforeStart.mock.invocationCallOrder[0]).toBeLessThan(engine.start.mock.invocationCallOrder[0]);
    expect(onActivityChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('button', { name: '바닥 지정' })).toBeNull();
    expect(screen.queryByRole('button', { name: '천장 지정' })).toBeNull();
    expect(document.querySelector('.auto-target-ceiling')).toBeTruthy();
    expect(document.querySelector('.auto-target-floor')).toBeTruthy();
  });
  it('두 곳의 연속된 현재 좌표가 안정되면 추가 탭 없이 수직 높이를 자동 표시한다', () => {
    const { engine } = startPanel();
    stable(engine);
    expect(screen.getByText('2.40 m')).toBeTruthy();
    expect(screen.getByText('240 cm')).toBeTruthy();
    expect(screen.getByText('두 표면 사이 · 자동 계산(참고값)')).toBeTruthy();
    expect(screen.getByText(/가구·문틀·창틀은 자동 구분하지 못해요/)).toBeTruthy();
    expect(engine.stop).not.toHaveBeenCalled();
  });
  it('천장 신호가 사라지면 지난 값을 지우고 새 두 좌표가 안정될 때까지 기다린다', () => {
    const { engine } = startPanel();
    stable(engine);
    now += 100;
    frame(engine, { floor: hit(0), ceiling: null }, 'searching');
    expect(screen.queryByText('2.40 m')).toBeNull();
    expect(screen.getByText(/위쪽 천장의 표면 신호/)).toBeTruthy();
    now += 100; frame(engine);
    expect(screen.queryByText('2.40 m')).toBeNull();
    stable(engine);
    expect(screen.getByText('2.40 m')).toBeTruthy();
  });
  it('기울어진 문·벽 후보는 숫자를 표시하지 않고 위쪽 천장 구도를 안내한다', () => {
    const { engine } = startPanel();
    for (let i = 0; i <= 12; i++) { now += 100; frame(engine, { floor: hit(0), ceiling: hit(2.4, { normalY: 0 }) }); }
    expect(screen.queryByText('2.40 m')).toBeNull();
    expect(screen.getByText(/위쪽 표시가 벽이나 문틀/)).toBeTruthy();
  });
  it('카메라 시야가 바뀌면 이전 값을 지우고 재인식 안내 뒤 새 좌표만 계산한다', () => {
    const { engine } = startPanel();
    stable(engine);
    act(() => {
      engine.pair = { floor: null, ceiling: null };
      engine.options.onUpdate({ phase: 'searching', canConfirm: false, hitCount: 0,
        message: '카메라 시야가 바뀌어 두 위치를 다시 읽고 있어요.' });
    });
    expect(screen.queryByText('2.40 m')).toBeNull();
    expect(screen.getByText('카메라 시야가 바뀌어 두 위치를 다시 읽고 있어요.')).toBeTruthy();
    now += 100;
    frame(engine, { floor: hit(0), ceiling: hit(2.8) });
    expect(screen.queryByText('2.80 m')).toBeNull();
    for (let i = 0; i < 10; i++) {
      now += 100;
      frame(engine, { floor: hit(0), ceiling: hit(2.8) });
    }
    expect(screen.getByText('2.80 m')).toBeTruthy();
    expect(screen.queryByText('2.40 m')).toBeNull();
  });
  it('한쪽의 오래된 좌표를 다른 쪽의 새 좌표와 섞지 않는다', () => {
    const { engine } = startPanel();
    stable(engine);
    const staleFloor = engine.pair.floor;
    now += 300;
    frame(engine, { floor: staleFloor, ceiling: hit(2.4) });
    expect(screen.queryByText('2.40 m')).toBeNull();
  });
  it.each(['tracking-lost', 'paused', 'reset', 'error'] as const)('%s는 표시값과 누적 안정성을 즉시 지운다', phase => {
    const { engine } = startPanel();
    stable(engine);
    act(() => engine.emit(phase));
    expect(screen.queryByText('2.40 m')).toBeNull();
    if (phase === 'tracking-lost' || phase === 'paused') {
      now += 100; frame(engine);
      expect(screen.queryByText('2.40 m')).toBeNull();
    }
  });
  it('다시 읽기는 현재 숫자를 지우며 새 안정 구간을 기다린다', () => {
    const { engine } = startPanel();
    stable(engine);
    fireEvent.click(screen.getByRole('button', { name: '다시 읽기' }));
    expect(screen.queryByText('2.40 m')).toBeNull();
    now += 100; frame(engine);
    expect(screen.queryByText('2.40 m')).toBeNull();
    stable(engine);
    expect(screen.getByText('2.40 m')).toBeTruthy();
  });
  it('종료 신호 뒤 새 세션을 시작하고 이전 콜백은 새 화면을 닫지 않는다', async () => {
    const { engine, onActivityChange } = startPanel();
    stable(engine);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '높이 측정 종료' })); });
    expect(screen.queryByText('2.40 m')).toBeNull();
    expect(onActivityChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: '높이 측정 시작' }));
    expect(hardware.instances).toHaveLength(2);
    act(() => engine.emit('ended'));
    expect(screen.getByRole('button', { name: '높이 측정 종료' })).toBeTruthy();
  });
  it('실제 종료가 실패하면 재시작을 잠그고 종료 재시도를 허용한다', async () => {
    const { engine, onActivityChange } = startPanel();
    engine.stop.mockImplementation(async () => engine.emit('stopping'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '높이 측정 종료' })); });
    expect(onActivityChange).toHaveBeenLastCalledWith(true);
    expect((screen.getByRole('button', { name: '높이 측정 시작' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '높이 측정 종료' })); });
    expect(engine.stop).toHaveBeenCalledTimes(2);
  });
});
