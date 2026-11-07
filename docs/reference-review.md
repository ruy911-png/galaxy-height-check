# 참고 자료·라이선스·호환성 검토

확인일: 2026-11-07. 사용자 기기는 “폴더7” 답변을 **갤럭시 Z 폴드7**로 잠정 해석했으며, 목적은 대략적인 높이 확인이다. 아래 내용은 공개 소스와 패키지 메타데이터 검토 결과다. 설치·빌드·브라우저 검사 결과 또는 실제 휴대폰 정확도 검증 결과를 뜻하지 않는다.

## 선택한 구성

- React `19.3.1`, React DOM `19.3.1`, Three.js `0.187.0`을 직접 의존성의 정확한 버전으로 사용한다.
- React는 한글 안내와 버튼, Three.js는 AR 렌더링, 브라우저의 WebXR API는 세션·참조 좌표계·표면 hit 검사를 담당한다.
- 1단계의 작은 진단 화면에서는 세션과 좌표의 수명을 직접 관리하기 위해 `@react-three/fiber`와 `@react-three/xr`를 설치하지 않는다. 이후 필요할 때 추가할 수 있다.
- 런타임 라이브러리는 앱에 포함한다. 참고 앱의 CDN 스크립트, 시뮬레이터 및 높이 계산 코드를 복사하지 않는다. FreeRuler 소스가 공개되어 있다고 가정하지 않는다.

확인한 선택적 연결 라이브러리 조합은 다음과 같다. **npm peer dependency 범위가 맞는다는 확인이며, 이 조합의 설치·실행 검증은 수행한 것으로 보고하지 않는다.**

| 패키지 | 확인 버전 | 선언된 호환 조건 |
| --- | --- | --- |
| `react` | `19.3.1` | React DOM과 같은 버전 사용 |
| `react-dom` | `19.3.1` | React `^19.3.1` |
| `three` | `0.187.0` | 아래 두 패키지의 Three 범위 충족 |
| `@react-three/fiber` | `9.8.2` | React·React DOM `>=19 <19.4`, Three `>=0.156` |
| `@react-three/xr` | `6.6.32` | React·React DOM `>=18`, fiber `>=8`, Three `*` |

메타데이터 출처: [React](https://www.npmjs.com/package/react/v/19.3.1), [React DOM](https://www.npmjs.com/package/react-dom/v/19.3.1), [Three.js](https://www.npmjs.com/package/three/v/0.187.0), [fiber](https://www.npmjs.com/package/@react-three/fiber/v/9.8.2), [xr](https://www.npmjs.com/package/@react-three/xr/v/6.6.32).

## pmndrs/xr

- 검토한 `main` 커밋: `0e1acd868ca744032240db819d1e428bd1812901`.
- React + R3F + Three.js를 연결하며 연속·단발 hit 검사용 훅을 제공한다. [hit-test 문서](https://github.com/pmndrs/xr/blob/0e1acd868ca744032240db819d1e428bd1812901/docs/tutorials/hit-test.md)
- [React XR 패키지 LICENSE](https://github.com/pmndrs/xr/blob/0e1acd868ca744032240db819d1e428bd1812901/packages/react/xr/LICENSE)는 Copyright 2024 Bela Bohlender의 MIT 허가문이다. [루트 LICENSE](https://github.com/pmndrs/xr/blob/0e1acd868ca744032240db819d1e428bd1812901/LICENSE)에는 Bela Bohlender와 Coconut Capital의 MIT 허가문이 있다. 재사용·배포 시 해당 고지를 유지해야 한다.
- GitHub의 루트 라이선스 분류는 `NOASSERTION`, npm 표기는 `SEE LICENSE IN LICENSE`이므로 실제 LICENSE 원문으로 확인했다.
- 표면 위치를 화면에 표시하는 예제만으로 측정값의 최신성이나 실제 높이 정확도가 보장되지는 않는다.

## web-armeasure-

- 검토한 `main` 커밋: `91ad27d04930f4d8ba8bdbcb6836d0a48c547581`.
- React 없이 HTML과 Three.js `0.160.0`을 사용한다. Tailwind와 Three를 외부 CDN에서 읽으며 데스크톱 시뮬레이터도 포함한다.
- [README](https://github.com/Saicharantejapudi/web-armeasure-/blob/91ad27d04930f4d8ba8bdbcb6836d0a48c547581/README.md)는 MIT라고 밝히지만, 확인한 저장소에는 `.gitignore`, `README.md`, `index.html`만 있으며 별도 LICENSE 파일이나 완전한 허가문은 없다. 이 앱에서는 코드를 복사하지 않고 구현 방식과 결함을 참고한다.

현재 소스에서 재확인한 문제:

| 위치 | 확인 내용 | 본 앱에서 필요한 처리 |
| --- | --- | --- |
| [393행](https://github.com/Saicharantejapudi/web-armeasure-/blob/91ad27d04930f4d8ba8bdbcb6836d0a48c547581/index.html#L393) | `!hasRecentSurface && !hasEverHitSurface`일 때만 확정을 막으므로, 한 번 인식한 뒤에는 현재 hit가 없어도 진행할 수 있다. | 이전 성공 여부를 현재 좌표의 유효 근거로 사용하지 않는다. |
| [404행](https://github.com/Saicharantejapudi/web-armeasure-/blob/91ad27d04930f4d8ba8bdbcb6836d0a48c547581/index.html#L404) | 최근 hit가 없으면 이전 `smoothedTargetPos`를 사용한다. | 무효 hit에서 위치를 폐기하고 오래된 좌표의 확정을 막는다. |
| [827행](https://github.com/Saicharantejapudi/web-armeasure-/blob/91ad27d04930f4d8ba8bdbcb6836d0a48c547581/index.html#L827) | hit가 없어져도 650ms 동안 인식 성공 상태를 유지한다. | 현재 프레임 신호와 시각을 함께 검사한다. |
| [333행](https://github.com/Saicharantejapudi/web-armeasure-/blob/91ad27d04930f4d8ba8bdbcb6836d0a48c547581/index.html#L333) | 재측정 초기화가 바닥점과 화면을 지우지만 이전 목표 좌표·hit 상태를 모두 지우지는 않는다. | 세션·측정 초기화에서 좌표와 유효 상태를 함께 지운다. |
| [468행](https://github.com/Saicharantejapudi/web-armeasure-/blob/91ad27d04930f4d8ba8bdbcb6836d0a48c547581/index.html#L468) | Y 차이가 5mm를 넘으면 직접 높이, 그 외에는 가상 수직 평면 교차를 사용하지만 결과 종류를 구분하지 않는다. | 1단계에는 가상 평면 방식을 넣지 않는다. 추후 도입 시 가정과 결과 종류를 명시한다. |

추가로 참조 좌표계 `reset`, 세션 `visibilitychange`, `getViewerPose()` 상실 및 `emulatedPosition`에 대한 방어가 확인되지 않았다. README의 “anchors” 표현과 달리 실제 소스는 `XRAnchor`를 만들지 않고 `Vector3`와 마커를 저장한다. 따라서 높이 측정 코드로 그대로 가져오지 않는다.

## 공식 WebXR hit-test 예제

- 검토한 저장소 HEAD: `5d1b7460d1e924797b8c34c72f34fc399f55336f`.
- 해당 `hit-test.html`의 마지막 변경 커밋: `9e558a33d4531ef057bdb965d7d6864b1fd0f2a4`.
- [고정 버전 예제](https://github.com/immersive-web/webxr-samples/blob/5d1b7460d1e924797b8c34c72f34fc399f55336f/hit-test.html), [MIT LICENSE.md](https://github.com/immersive-web/webxr-samples/blob/5d1b7460d1e924797b8c34c72f34fc399f55336f/LICENSE.md). HTML 자체에도 저작권과 허가문이 포함된다.
- `local`·`hit-test` 기능, viewer 기준 ray, 동일한 local 좌표계에서의 hit pose를 참고한다. 매 프레임 표시를 먼저 숨기고 유효 hit에서 다시 표시하는 흐름이 유용하다.
- 예제의 선택 동작은 기존 reticle 행렬을 사용하므로, 최신 시각·null pose·좌표계 초기화·가시성 변화까지 방어하는 측정 코드로 간주하지 않는다.
- React 버튼을 AR 화면 위에 표시하려면 `dom-overlay`를 요청하고 실제 활성화 여부를 확인해야 한다. [Google WebXR codelab](https://codelabs.developers.google.com/ar-with-webxr)

## 갤럭시 Z 폴드7과 실행 조건

- [Google 공식 ARCore 지원 기기 목록](https://developers.google.com/ar/devices)에 **Galaxy Z Fold7**이 있으며 Depth API 지원으로 표시된다. 이는 해당 휴대폰의 현재 Chrome에서 WebXR·천장 인식이 성공한다는 실측 근거가 아니며, 본 앱이 Depth API를 사용한다는 뜻도 아니다.
- [Google WebXR 실행 조건](https://developers.google.com/ar/develop/webxr/requirements): ARCore 지원 기기, 호환 브라우저, 설치·활성화된 Google Play Services for AR, 보안 컨텍스트가 필요하다.
- 일반 접속에는 **HTTPS**를 사용한다. `localhost`는 개발용 예외지만 같은 Wi-Fi의 `http://192.168…` 주소는 그 예외에 해당하지 않는다. 클라우드의 `localhost` 주소를 휴대폰에 입력해도 클라우드 앱으로 연결되지 않는다.
- `getUserMedia()` 카메라 권한 성공과 `immersive-ar` 세션 성공은 별도 항목이다. AR 시작 전 별도 카메라 stream을 종료해 카메라 점유 충돌을 피한다.
- ARCore는 아래쪽을 향한 수평면도 지원하지만, 무늬 없는 천장·낮은 조도·빠른 움직임에서는 인식과 추적이 실패할 수 있다. [Plane.Type](https://developers.google.com/ar/reference/java/com/google/ar/core/Plane.Type), [Content placement](https://developers.google.com/ar/design/content/content-placement)

## 검증 결과를 해석하는 범위

표시는 **“WebXR 표면 인식 신호”**로 설명한다. hit 신호만으로 해당 위치가 정확한 물리적 천장점이라는 의미는 아니다. 특히 [Chromium의 ARCore hit-test 구현](https://chromium.googlesource.com/chromium/src/+/main/device/vr/android/arcore/arcore_impl.cc)에는 가장 먼 평면 hit를 polygon 내부 검사 없이 받아들이는 경로가 있다.

보안 연결, 브라우저 지원 응답, 카메라 권한, 실제 AR 세션 시작, 현재 표면 hit, 실제 높이 정확도는 각각 별개로 기록한다. 자동 검사나 화면 동작만으로 실제 측정 성공을 보고하지 않는다. 줄자 기준 높이와 휴대폰 반복 측정값을 받기 전까지 정확도는 **미검증**이다.


## 원본 사용법 재확인과 v0.4.0 적용

GitHub의 현재 README와 index.html을 다시 조회했으며 main은 위의 `91ad27d…`와 같았습니다. 원본은 한 화면 자동 계산이 아니라 **기준점 Place Point → 위로 조준 → 상단 Place Point**의 두 번 지정 방식입니다. 가상 수직면 계산도 포함되어 실제 수평 천장만을 기다리지 않습니다. 사용자의 요청으로 이 흐름을 새 기본 화면에 구현했습니다. 원본의 오래된 좌표 재사용은 도입하지 않았고, 표면 인식 결과와 가상면 추정 결과를 구분합니다. [v0.4.0 구현](base-top.md) 참고.

초광각 관련 [WebXR #1336](https://github.com/immersive-web/webxr/issues/1336)의 설명은 브라우저가 카메라 선택을 제공할 수 있으나 웹앱이 선택에 영향을 줄 표준 API가 없다는 것입니다. 이를 초광각이 원천적으로 불가능하다는 증거로 해석하지 않습니다. Galaxy Chrome에서 0.5배를 제어하는 검증 가능한 예제는 찾지 못했고 앱에 실제 줌 기능을 제공하지 않습니다.
