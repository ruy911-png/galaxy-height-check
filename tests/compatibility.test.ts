import { describe, expect, it, vi } from 'vitest';
import { cameraErrorMessage, checkCompatibility } from '../src/compatibility';

describe('호환성 확인을 실제 표면 성공과 구분', () => {
  it('일반 HTTP에서는 AR API를 호출하지 않는다', async () => {
    const isSessionSupported = vi.fn();
    expect((await checkCompatibility(false, true, { isSessionSupported })).ar).toBe('unsupported');
    expect(isSessionSupported).not.toHaveBeenCalled();
  });
  it('WebXR API 없음은 지원 안 됨으로 설명한다', async () => {
    expect((await checkCompatibility(true, true)).message).toContain('Chrome');
  });
  it('지원 응답은 AR 세션/표면 인식 성공으로 처리하지 않는다', async () => {
    const isSessionSupported = vi.fn().mockResolvedValue(true);
    const result = await checkCompatibility(true, true, { isSessionSupported });
    expect(isSessionSupported).toHaveBeenCalledWith('immersive-ar');
    expect(result.ar).toBe('supported');
    expect(result.message).toContain('실제 표면 인식도 확인');
  });
  it('지원하지 않는 기기의 업데이트 안내', async () => {
    expect((await checkCompatibility(true, true, { isSessionSupported: vi.fn().mockResolvedValue(false) })).message).toContain('Google Play AR 서비스');
  });
  it('권한/보안 예외는 미확인 실패로 남긴다', async () => {
    expect((await checkCompatibility(true, true, { isSessionSupported: vi.fn().mockRejectedValue(new Error('denied')) })).ar).toBe('error');
  });
  it('카메라 거부와 점유 오류의 조작 안내를 구분한다', () => {
    expect(cameraErrorMessage({ name: 'NotAllowedError' })).toContain('권한');
    expect(cameraErrorMessage({ name: 'NotReadableError' })).toContain('다른 카메라 앱');
    expect(cameraErrorMessage({ name: 'NotFoundError' })).toContain('찾지 못');
    expect(cameraErrorMessage(null)).toContain('다시 시도');
  });
});
