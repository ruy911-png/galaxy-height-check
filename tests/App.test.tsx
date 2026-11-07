// @vitest-environment jsdom
// Hardware is mocked here. These tests verify UI state, not camera/AR capability or accuracy.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArUpdate, SurfaceSample } from '../src/arDiagnostic';
import App from '../src/App';

type MockDiagnostic = {
  emit: (phase: ArUpdate['phase'], canConfirm?: boolean) => void;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  confirmSurface: ReturnType<typeof vi.fn>;
  getCurrentHit: ReturnType<typeof vi.fn>;
};

const hardware = vi.hoisted(() => ({ instances: [] as MockDiagnostic[] }));

vi.mock('../src/arDiagnostic', () => ({
  ArDiagnostic: class {
    constructor(private options: { onUpdate: (update: ArUpdate) => void }) {
      hardware.instances.push(this);
    }
    emit = (phase: ArUpdate['phase'], canConfirm = phase === 'surface') => {
      this.options.onUpdate({ phase, message: `모의 AR 상태: ${phase}`, canConfirm, hitCount: canConfirm ? 1 : 0 });
    };
    start = vi.fn(async () => { this.emit('starting'); });
    stop = vi.fn(async () => { this.emit('ended'); });
    confirmSurface = vi.fn((): SurfaceSample | null => null);
    getCurrentHit = vi.fn(() => null);
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function cameraStream() {
  class Track extends EventTarget {
    kind = 'video';
    readyState = 'live';
    stop = vi.fn(() => { this.readyState = 'ended'; });
  }
  const track = new Track();
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

let getUserMedia: ReturnType<typeof vi.fn>;
let isSessionSupported: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hardware.instances.length = 0;
  getUserMedia = vi.fn();
  isSessionSupported = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  Object.defineProperty(navigator, 'xr', { configurable: true, value: { isSessionSupported } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const arStart = () => screen.getByRole('button', { name: /AR 표면 확인 시작/ }) as HTMLButtonElement;
const overlay = () => document.querySelector('.diagnostic-overlay')!;

async function readyApp() {
  render(<App />);
  await screen.findByText('지원 응답 확인');
}

async function startAr() {
  await readyApp();
  fireEvent.click(arStart());
  return hardware.instances.at(-1)!;
}

describe('1단계 React 사용 흐름 — 모의 하드웨어', () => {
  it('WebXR가 없으면 AR 시작을 막고 높이값을 만들어 표시하지 않는다', async () => {
    Object.defineProperty(navigator, 'xr', { configurable: true, value: undefined });
    render(<App />);
    await screen.findByText(/이 브라우저에는 WebXR이 없어요/);
    expect(arStart().disabled).toBe(true);
    expect(hardware.instances).toHaveLength(0);
    expect(screen.getByText('미검증')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '확인 기록 복사하기' }));
    const report = await screen.findByRole('textbox', { name: '호환성 확인 기록' });
    expect((report as HTMLTextAreaElement).value).toContain('높이 측정: 구현됨 / 실제 높이 정확도: 미검증');
    expect((report as HTMLTextAreaElement).value).not.toMatch(/\d+(?:\.\d+)?\s*(?:cm|미터|센티미터)/);
  });

  it('카메라 거부를 안내하고 마이크 권한을 요청하지 않는다', async () => {
    getUserMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    await readyApp();
    fireEvent.click(screen.getByRole('button', { name: '카메라 확인하기' }));
    await screen.findByText(/카메라 권한이 허용되지 않았어요/);
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: false, video: { facingMode: { ideal: 'environment' } } });
    expect(screen.queryByText('카메라 켜짐 · 전송 없음')).toBeNull();
    expect(screen.getByRole('button', { name: '카메라 확인하기' })).toBeTruthy();
  });

  it('높이 측정을 시작하면 카메라 미리보기를 중지하고 다른 AR 시작을 막는다', async () => {
    const { track, stream } = cameraStream();
    getUserMedia.mockResolvedValue(stream);
    await readyApp();
    fireEvent.click(screen.getByRole('button', { name: '카메라 확인하기' }));
    await screen.findByText('카메라 켜짐 · 전송 없음');
    fireEvent.click(screen.getByRole('button', { name: '높이 측정 시작' }));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(arStart().disabled).toBe(true);
    expect((screen.getByRole('button', { name: '카메라 확인하기' }) as HTMLButtonElement).disabled).toBe(true);
    const engine = hardware.instances.at(-1)!;
    act(() => engine.emit('ended', false));
    expect(arStart().disabled).toBe(false);
  });

  it('카메라 요청 취소 후 늦게 허용된 스트림은 즉시 종료한다', async () => {
    const pending = deferred<MediaStream>();
    const { track, stream } = cameraStream();
    getUserMedia.mockReturnValue(pending.promise);
    await readyApp();
    fireEvent.click(screen.getByRole('button', { name: '카메라 확인하기' }));
    fireEvent.click(screen.getByRole('button', { name: '카메라 요청 취소' }));
    await act(async () => { pending.resolve(stream); await pending.promise; });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(screen.queryByText('카메라 켜짐 · 전송 없음')).toBeNull();
    expect((screen.getByLabelText('휴대폰 카메라 미리보기') as HTMLVideoElement).srcObject).toBeNull();
  });

  it('AR 시작은 기존 카메라 스트림을 종료한 다음 실행한다', async () => {
    const { track, stream } = cameraStream();
    getUserMedia.mockResolvedValue(stream);
    await readyApp();
    fireEvent.click(screen.getByRole('button', { name: '카메라 확인하기' }));
    await screen.findByText('카메라 켜짐 · 전송 없음');
    fireEvent.click(arStart());
    const diagnostic = hardware.instances[0];
    expect(track.stop).toHaveBeenCalledOnce();
    expect(diagnostic.start).toHaveBeenCalledOnce();
    expect(track.stop.mock.invocationCallOrder[0]).toBeLessThan(diagnostic.start.mock.invocationCallOrder[0]);
    expect(screen.queryByText('카메라 켜짐 · 전송 없음')).toBeNull();
    expect(overlay().classList.contains('xr-open')).toBe(true);
  });

  it('예상하지 못한 카메라 중단은 켜짐 표시를 없애고 다시 켜기를 안내한다', async () => {
    const { track, stream } = cameraStream();
    getUserMedia.mockResolvedValue(stream);
    await readyApp();
    fireEvent.click(screen.getByRole('button', { name: '카메라 확인하기' }));
    await screen.findByText('카메라 켜짐 · 전송 없음');
    act(() => {
      track.readyState = 'ended';
      track.dispatchEvent(new Event('ended'));
    });
    expect(screen.queryByText('카메라 켜짐 · 전송 없음')).toBeNull();
    expect(screen.getByText(/카메라 영상이 중단됐어요/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '카메라 확인하기' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('휴대폰 카메라 미리보기') as HTMLVideoElement).srcObject).toBeNull();
  });

  it('버튼 표시가 늦어도 현재 표면이 무효하면 다음 방향으로 넘어가지 않는다', async () => {
    const diagnostic = await startAr();
    act(() => diagnostic.emit('surface'));
    diagnostic.confirmSurface.mockReturnValue(null);
    fireEvent.click(screen.getByRole('button', { name: '바닥 방향 표면 신호 확인' }));
    expect(diagnostic.confirmSurface).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: '바닥을 천천히 비춰 주세요' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '천장 방향 표면 신호 확인' })).toBeNull();
    expect(screen.queryByText('바닥 방향 신호: 확인')).toBeNull();
  });

  it('추적이 끊기면 방향 확인 기록과 확정 버튼을 초기화한다', async () => {
    const diagnostic = await startAr();
    act(() => diagnostic.emit('surface'));
    diagnostic.confirmSurface.mockReturnValue({ x: 0, y: 0, z: -1 });
    fireEvent.click(screen.getByRole('button', { name: '바닥 방향 표면 신호 확인' }));
    expect(screen.getByText('바닥 방향 신호: 확인')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '천천히 천장을 비춰 주세요' })).toBeTruthy();
    act(() => diagnostic.emit('tracking-lost', false));
    expect(screen.queryByText('바닥 방향 신호: 확인')).toBeNull();
    expect(screen.getByRole('heading', { name: '바닥을 천천히 비춰 주세요' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '표면 인식을 기다리는 중…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('좌표계 초기화가 완료되면 AR 안내를 닫고 새 세션 시작을 허용한다', async () => {
    const diagnostic = await startAr();
    act(() => diagnostic.emit('reset', false));
    expect(overlay().classList.contains('xr-open')).toBe(false);
    expect(arStart().disabled).toBe(false);
    fireEvent.click(arStart());
    expect(hardware.instances).toHaveLength(2);
    expect(overlay().classList.contains('xr-open')).toBe(true);
  });

  it('비동기 종료가 끝날 때까지 재시작을 잠그고 이전 콜백은 새 세션을 바꾸지 않는다', async () => {
    const diagnostic = await startAr();
    const pending = deferred<void>();
    diagnostic.stop.mockImplementation(() => {
      diagnostic.emit('stopping', false);
      return pending.promise;
    });
    fireEvent.click(screen.getByRole('button', { name: 'AR 확인 종료' }));
    expect(arStart().disabled).toBe(true);
    fireEvent.click(arStart());
    expect(hardware.instances).toHaveLength(1);

    // Even if a terminal callback precedes the promise continuation, restart stays locked.
    act(() => diagnostic.emit('ended', false));
    expect(arStart().disabled).toBe(true);
    await act(async () => { pending.resolve(); await pending.promise; });
    await waitFor(() => expect(arStart().disabled).toBe(false));
    fireEvent.click(arStart());
    expect(hardware.instances).toHaveLength(2);
    act(() => diagnostic.emit('ended', false));
    expect(overlay().classList.contains('xr-open')).toBe(true);
    expect(arStart().disabled).toBe(true);
  });

  it('네이티브 종료 실패로 최종 종료 신호가 없으면 화면과 세션을 유지하고 종료 재시도를 허용한다', async () => {
    const diagnostic = await startAr();
    diagnostic.stop.mockImplementation(async () => {
      diagnostic.emit('stopping', false);
      // Native end failed: this attempt resolves, but the session is still alive.
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'AR 확인 종료' }));
    });
    expect(overlay().classList.contains('xr-open')).toBe(true);
    expect(arStart().disabled).toBe(true);
    fireEvent.click(arStart());
    expect(hardware.instances).toHaveLength(1);

    diagnostic.stop.mockImplementation(async () => { diagnostic.emit('ended', false); });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'AR 확인 종료' }));
    });
    expect(diagnostic.stop).toHaveBeenCalledTimes(2);
    expect(overlay().classList.contains('xr-open')).toBe(false);
    expect(arStart().disabled).toBe(false);
  });
});
