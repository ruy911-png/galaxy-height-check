export type CheckResult = 'checking' | 'supported' | 'unsupported' | 'error';

export interface Compatibility {
  secure: boolean;
  cameraApi: boolean;
  ar: CheckResult;
  message: string;
}

export async function checkCompatibility(
  secure: boolean,
  cameraApi: boolean,
  xr?: Pick<XRSystem, 'isSessionSupported'>,
): Promise<Compatibility> {
  if (!secure) return { secure, cameraApi, ar: 'unsupported', message: 'HTTPS 주소로 열어야 카메라와 AR을 사용할 수 있어요.' };
  if (!xr) return { secure, cameraApi, ar: 'unsupported', message: '이 브라우저에는 WebXR이 없어요. 갤럭시의 Chrome에서 직접 열어 주세요.' };
  try {
    const supported = await xr.isSessionSupported('immersive-ar');
    return { secure, cameraApi, ar: supported ? 'supported' : 'unsupported', message: supported
      ? 'AR 지원 응답을 받았어요. 아래에서 카메라와 실제 표면 인식도 확인해 주세요.'
      : 'AR 지원 응답을 받지 못했어요. Chrome과 Google Play AR 서비스를 업데이트해 주세요.' };
  } catch {
    return { secure, cameraApi, ar: 'error', message: 'AR 지원 여부를 확인하지 못했어요. Chrome에서 링크를 직접 열고 다시 확인해 주세요.' };
  }
}

export function cameraErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '카메라 권한이 허용되지 않았어요. Chrome 주소창 왼쪽 아이콘 → 권한 → 카메라를 허용해 주세요.';
  if (name === 'NotFoundError') return '사용할 수 있는 카메라를 찾지 못했어요.';
  if (name === 'NotReadableError') return '카메라를 열지 못했어요. 다른 카메라 앱을 닫은 뒤 다시 시도해 주세요.';
  return '카메라 확인에 실패했어요. Chrome에서 다시 시도해 주세요.';
}
