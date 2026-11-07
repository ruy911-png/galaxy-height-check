// @vitest-environment jsdom
// WebXR is mocked. These tests verify measurement UI behavior, not real AR or room accuracy.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArUpdate } from '../src/arDiagnostic';
import type { MeasurementHit } from '../src/measurement';
import MeasurementPanel from '../src/MeasurementPanel';

type MockDiagnostic = {
  hit: MeasurementHit | null;
  emit: (phase: ArUpdate['phase'], canConfirm?: boolean) => void;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getCurrentHit: ReturnType<typeof vi.fn>;
};

const hardware = vi.hoisted(() => ({ instances: [] as MockDiagnostic[] }));

vi.mock('../src/arDiagnostic', () => ({
  ArDiagnostic: class {
    hit: MeasurementHit | null = null;
    constructor(private options: { onUpdate: (update: ArUpdate) => void }) {
      hardware.instances.push(this);
    }
    emit = (phase: ArUpdate['phase'], canConfirm = phase === 'surface') => {
      this.options.onUpdate({ phase, canConfirm, hitCount: canConfirm ? 1 : 0, message: `모의 AR 상태: ${phase}` });
    };
    start = vi.fn(async () => { this.emit('starting', false); });
    stop = vi.fn(async () => { this.emit('stopping', false); this.emit('ended', false); });
    getCurrentHit = vi.fn((): MeasurementHit | null => this.hit);
    confirmSurface = vi.fn(() => this.hit?.position ?? null);
  },
}));

let now: number;

beforeEach(() => {
  hardware.instances.length = 0;
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ok => { resolve = ok; });
  return { promise, resolve };
}

function sample(y: number, overrides: Partial<MeasurementHit> = {}): MeasurementHit {
  return {
    position: { x: 0, y, z: -1 }, normalY: y > 1.4 ? -1 : 1, viewerY: 1.4,
    timestamp: now, sessionId: 'test-session-1', epoch: 0, source: 'webxr-plane-hit',
    ...overrides,
  };
}

const startButton = () => screen.getByRole('button', { name: '높이 측정 시작' }) as HTMLButtonElement;
const floorButton = () => screen.getByRole('button', { name: '바닥 지정' }) as HTMLButtonElement;
const ceilingButton = () => screen.getByRole('button', { name: '천장 지정' }) as HTMLButtonElement;

function startPanel() {
  const onBeforeStart = vi.fn();
  const onActivityChange = vi.fn();
  render(<MeasurementPanel supported onBeforeStart={onBeforeStart} onActivityChange={onActivityChange} />);
  fireEvent.click(startButton());
  return { diagnostic: hardware.instances.at(-1)!, onBeforeStart, onActivityChange };
}

function showHit(diagnostic: MockDiagnostic, hit: MeasurementHit) {
  act(() => {
    diagnostic.hit = hit;
    diagnostic.emit('surface');
  });
}

function captureFloor(diagnostic: MockDiagnostic) {
  showHit(diagnostic, sample(0));
  expect(floorButton().disabled).toBe(false);
  fireEvent.click(floorButton());
}

async function captureCeiling(diagnostic: MockDiagnostic, hit = sample(2.4)) {
  showHit(diagnostic, hit);
  await act(async () => { fireEvent.click(ceilingButton()); });
}

describe('높이 측정 화면 — 테스트 먼저, 모의 WebXR', () => {
  it('AR 미지원 또는 다른 카메라 작업 중이면 측정을 시작하지 않는다', () => {
    const props = { onBeforeStart: vi.fn(), onActivityChange: vi.fn() };
    const { rerender } = render(<MeasurementPanel supported={false} {...props} />);
    expect(startButton().disabled).toBe(true);
    fireEvent.click(startButton());
    rerender(<MeasurementPanel supported blocked {...props} />);
    expect(startButton().disabled).toBe(true);
    fireEvent.click(startButton());
    expect(hardware.instances).toHaveLength(0);
    expect(props.onBeforeStart).not.toHaveBeenCalled();
    expect(screen.queryByText('2.40 m')).toBeNull();
  });

  it('기존 카메라 정리를 먼저 호출하고 실제 종료 신호 전에는 다시 시작하지 않는다', async () => {
    const { diagnostic, onBeforeStart, onActivityChange } = startPanel();
    expect(onBeforeStart).toHaveBeenCalledOnce();
    expect(diagnostic.start).toHaveBeenCalledOnce();
    expect(onBeforeStart.mock.invocationCallOrder[0]).toBeLessThan(diagnostic.start.mock.invocationCallOrder[0]);
    expect(onActivityChange).toHaveBeenLastCalledWith(true);

    diagnostic.stop.mockImplementation(async () => {
      diagnostic.emit('stopping', false);
      // A failed native session.end() leaves the session alive, despite this attempt settling.
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '높이 측정 종료' })); });
    expect(onActivityChange).toHaveBeenLastCalledWith(true);
    const blockedStart = screen.queryByRole('button', { name: '높이 측정 시작' }) as HTMLButtonElement | null;
    if (blockedStart) {
      expect(blockedStart.disabled).toBe(true);
      fireEvent.click(blockedStart);
    }
    expect(hardware.instances).toHaveLength(1);

    const pending = deferred();
    diagnostic.stop.mockImplementation(() => {
      diagnostic.emit('stopping', false);
      return pending.promise;
    });
    fireEvent.click(screen.getByRole('button', { name: '높이 측정 종료' }));
    expect(onActivityChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      diagnostic.emit('ended', false);
      pending.resolve();
      await pending.promise;
    });
    await waitFor(() => expect(onActivityChange).toHaveBeenLastCalledWith(false));
    expect(startButton().disabled).toBe(false);
  });

  it('바닥에서 천장까지 수직 차이를 m와 cm로 표시하고 정상 종료 뒤 결과를 보존한다', async () => {
    const { diagnostic, onActivityChange } = startPanel();
    captureFloor(diagnostic);
    // Horizontal displacement is 5m. Vertical height must remain 2.4m, never the diagonal.
    await captureCeiling(diagnostic, sample(2.4, { position: { x: 3, y: 2.4, z: 3 } }));
    expect(await screen.findByText('2.40 m')).toBeTruthy();
    expect(screen.getByText('240 cm')).toBeTruthy();
    expect(screen.getAllByText(/정확도 미검증/).length).toBeGreaterThan(0);
    expect(diagnostic.stop).toHaveBeenCalledOnce();
    expect(onActivityChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: '다시 측정' })).toBeTruthy();
    act(() => diagnostic.emit('ended', false));
    expect(screen.getByText('2.40 m')).toBeTruthy();
  });

  it('활성 버튼이 남아 있어도 누르는 순간 유효한 hit가 없으면 바닥을 확정하지 않는다', () => {
    const { diagnostic } = startPanel();
    showHit(diagnostic, sample(0));
    expect(floorButton().disabled).toBe(false);
    diagnostic.hit = null; // Deliberately no UI notification: the rendered button is stale.
    diagnostic.getCurrentHit.mockClear();
    fireEvent.click(floorButton());
    expect(diagnostic.getCurrentHit).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '천장 지정' })).toBeNull();
    expect(floorButton()).toBeTruthy();
    expect(screen.queryByText('2.40 m')).toBeNull();
  });

  it('초록 원이 있어도 기울어진 면이면 구체적인 차단 이유를 유지하고 유효한 바닥에서 복구한다', () => {
    const { diagnostic } = startPanel();
    showHit(diagnostic, sample(0, { normalY: 0.5 }));
    expect(floorButton().disabled).toBe(true);
    expect(screen.getByText(/기울어진 면으로 인식/)).toBeTruthy();
    act(() => diagnostic.emit('surface'));
    expect(screen.getByText(/기울어진 면으로 인식/)).toBeTruthy();
    showHit(diagnostic, sample(0));
    expect(floorButton().disabled).toBe(false);
    expect(screen.queryByText(/기울어진 면으로 인식/)).toBeNull();
    fireEvent.click(floorButton());
    expect(ceilingButton()).toBeTruthy();
  });

  it('카메라보다 낮은 바닥이 아니면 기울기와 다른 이유를 표시하고 확정을 막는다', () => {
    const { diagnostic } = startPanel();
    showHit(diagnostic, sample(1.4));
    expect(floorButton().disabled).toBe(true);
    expect(screen.getByText(/휴대폰보다 낮은 바닥/)).toBeTruthy();
    expect(screen.queryByText(/기울어진 면으로 인식/)).toBeNull();
    fireEvent.click(floorButton());
    expect(screen.queryByRole('button', { name: '천장 지정' })).toBeNull();
  });

  it('천장으로 움직이며 표면이 잠시 안 보여도 저장한 바닥을 유지하고 현재 표면만 기다린다', async () => {
    const { diagnostic } = startPanel();
    captureFloor(diagnostic);
    act(() => {
      diagnostic.hit = null;
      diagnostic.emit('searching', false);
    });
    expect(ceilingButton().disabled).toBe(true);
    now = 5000; // The saved floor may age; only the live ceiling candidate must be fresh.
    await captureCeiling(diagnostic);
    expect(await screen.findByText('2.40 m')).toBeTruthy();
  });

  // The following bed/window/door labels describe synthetic scenarios only.
  // This mock has plane geometry, not image recognition or object identities.
  it('가구 위 벽에 잡힌 천장 후보는 거부하고 천장에 맞는 안내 후 같은 바닥으로 복구한다', async () => {
    const { diagnostic } = startPanel();
    captureFloor(diagnostic);
    showHit(diagnostic, sample(2.1, { normalY: 0 }));
    expect(ceilingButton().disabled).toBe(true);
    expect(screen.getByText(/머리 바로 위 천장/)).toBeTruthy();
    fireEvent.click(ceilingButton());
    expect(screen.queryByText('2.10 m')).toBeNull();
    expect(screen.queryByText('2.40 m')).toBeNull();
    await captureCeiling(diagnostic);
    expect(await screen.findByText('2.40 m')).toBeTruthy();
  });

  it('수평 침대 윗면과 바닥은 자동 구분할 수 없으므로 인식 성공으로 단정하지 않는다', () => {
    const { diagnostic } = startPanel();
    showHit(diagnostic, sample(0.5)); // Same plane data could describe a raised floor or a bed.
    expect(floorButton().disabled).toBe(false); // Geometry alone cannot identify the object.
    const guidance = document.getElementById('measurement-guidance')!.textContent!;
    expect(guidance).not.toContain('바닥 위치를 인식했어요');
    expect(guidance).toContain('침대');
    expect(guidance).toContain('실제 바닥');
    expect(screen.getByText(/자동으로 구분하지 못해요/)).toBeTruthy();
    expect(screen.queryByText('2.40 m')).toBeNull();
  });

  it('수평 문틀과 천장은 자동 구분할 수 없으므로 천장 인식 성공으로 단정하지 않는다', () => {
    const { diagnostic } = startPanel();
    captureFloor(diagnostic);
    showHit(diagnostic, sample(2.05)); // A lintel and a low ceiling can have identical geometry.
    expect(ceilingButton().disabled).toBe(false);
    const guidance = document.getElementById('measurement-guidance')!.textContent!;
    expect(guidance).not.toContain('천장 위치를 인식했어요');
    expect(guidance).toContain('창틀');
    expect(guidance).toContain('문틀');
    expect(screen.queryByText('2.05 m')).toBeNull(); // Eligibility is not confirmation.
  });

  it('창가에서 현재 hit가 사라진 뒤 눌러도 직전 천장을 저장하지 않고 새 hit에서 복구한다', async () => {
    const { diagnostic } = startPanel();
    captureFloor(diagnostic);
    showHit(diagnostic, sample(2.4));
    expect(ceilingButton().disabled).toBe(false);
    diagnostic.hit = null; // No UI update yet: a tap races with a no-hit frame.
    fireEvent.click(ceilingButton());
    expect(ceilingButton().disabled).toBe(true);
    expect(diagnostic.stop).not.toHaveBeenCalled();
    expect(screen.queryByText('2.40 m')).toBeNull();
    now = 3000;
    await captureCeiling(diagnostic, sample(2.7));
    expect(await screen.findByText('2.70 m')).toBeTruthy();
  });

  it('천장 버튼이 켜진 직후 프레임이 멈추면 오래된 후보를 거부하고 새 후보만 저장한다', async () => {
    const { diagnostic } = startPanel();
    captureFloor(diagnostic);
    showHit(diagnostic, sample(2.4));
    now += 251;
    fireEvent.click(ceilingButton());
    expect(ceilingButton().disabled).toBe(true);
    expect(diagnostic.stop).not.toHaveBeenCalled();
    expect(screen.queryByText('2.40 m')).toBeNull();
    await captureCeiling(diagnostic, sample(2.6));
    expect(await screen.findByText('2.60 m')).toBeTruthy();
  });

  it.each([
    { label: '추적 epoch', identity: { epoch: 1 } },
    { label: '세션 ID', identity: { sessionId: 'test-session-2' } },
  ])('$label 변경은 중단 알림이 없어도 기존 바닥을 지우고 바닥 재지정을 허용한다', async ({ identity }) => {
    const { diagnostic } = startPanel();
    captureFloor(diagnostic);
    diagnostic.getCurrentHit.mockClear();
    act(() => {
      diagnostic.hit = sample(2.4, identity);
      // No tracking-lost/paused/reset notification. Even a false UI flag must
      // not prevent checking the current hit's coordinate-space identity.
      diagnostic.emit('surface', false);
    });
    expect(floorButton().disabled).toBe(true); // A ceiling is not a valid new floor.
    expect(screen.queryByRole('button', { name: '천장 지정' })).toBeNull();
    expect(diagnostic.getCurrentHit).toHaveBeenCalled();
    expect(screen.queryByText('2.40 m')).toBeNull();

    showHit(diagnostic, sample(0, identity));
    expect(floorButton().disabled).toBe(false);
    fireEvent.click(floorButton());
    await captureCeiling(diagnostic, sample(2.4, identity));
    expect(await screen.findByText('2.40 m')).toBeTruthy();
  });

  it.each(['tracking-lost', 'paused', 'reset'] as const)('%s 후에는 이전 바닥과 새 천장을 조합하지 않는다', async phase => {
    const { diagnostic } = startPanel();
    captureFloor(diagnostic);
    act(() => {
      diagnostic.hit = null;
      diagnostic.emit(phase, false);
    });
    expect(screen.queryByText('2.40 m')).toBeNull();
    let current = diagnostic;
    if (phase === 'reset') {
      fireEvent.click(startButton());
      current = hardware.instances.at(-1)!;
      expect(current).not.toBe(diagnostic);
    }
    showHit(current, sample(2.4, { epoch: 1 }));
    expect(floorButton().disabled).toBe(true); // The ceiling cannot act as a replacement floor.
    expect(screen.queryByRole('button', { name: '천장 지정' })).toBeNull();
    expect(screen.queryByText('2.40 m')).toBeNull();
  });

  it('다시 측정은 지난 높이와 바닥을 지우고 새 AR 세션에서 바닥부터 시작한다', async () => {
    const { diagnostic } = startPanel();
    captureFloor(diagnostic);
    await captureCeiling(diagnostic);
    await screen.findByText('2.40 m');
    fireEvent.click(screen.getByRole('button', { name: '다시 측정' }));
    expect(hardware.instances).toHaveLength(2);
    expect(screen.queryByText('2.40 m')).toBeNull();
    expect(floorButton()).toBeTruthy();
    const current = hardware.instances.at(-1)!;
    showHit(current, sample(2.4, { sessionId: 'test-session-2' }));
    expect(floorButton().disabled).toBe(true);
    act(() => diagnostic.emit('ended', false));
    expect(floorButton()).toBeTruthy(); // Late callbacks from the old run cannot erase the new one.
    expect(screen.queryByRole('button', { name: '천장 지정' })).toBeNull();
  });
});
