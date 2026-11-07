# 무료 HTTPS 배포 결과 — GitHub Pages

확인일: 2026-11-07. 사용자 승인에 따라 소스코드와 정적 앱을 공개했습니다. 유료 결제는 수행하지 않았습니다.

## 공개 주소와 범위

- 앱: https://ruy911-png.github.io/galaxy-height-check/
- 소스: https://github.com/ruy911-png/galaxy-height-check
- `main` 브랜치에는 소스·테스트·문서, `gh-pages`에는 검증한 정적 빌드가 있습니다.
- 카메라 영상·사용자 사진·실측 좌표는 업로드하지 않습니다. 런타임 서버 API·DB·로그인·광고·유료 측정 API도 없습니다.
- GitHub Free 공개 저장소와 기본 Pages 도메인을 사용하는 정적 호스팅 비용은 0원입니다. 유료 도메인·유료 러너는 사용하지 않습니다.

## v0.4.0 배포 준비

원본처럼 기준점→상단을 차례로 지정하는 흐름과 가상 수직면 추정을 구현했습니다. 257개 자동 테스트와 타입·빌드 검사를 통과했습니다. 같은 승인된 무료 주소에 반영합니다. 실제 갤럭시 사용·정확도는 미검증입니다.

## v0.3.0 과거 배포 완료

- [Pages 배포 작업](https://github.com/ruy911-png/galaxy-height-check/actions/runs/42359853546): 완료, 성공.
- 게시 커밋: `a62ea36e7e56cf1584b1eccfd986cc7df08a1cac` (`gh-pages`), 구현 소스: `46a7f30` (`main`).
- 한 화면 자동 계산, 앱 안 구도 그림, 시야 변경 안내, 브라우저 화면 확대 차단을 반영했습니다.
- 181개 자동 검사·타입 검사·빌드, 모의 AR 화면 4종 검사 통과.
- 공개 페이지의 실제 Chromium 156 검사 5건 통과: 화면 폭 4종 + 모의 카메라 권한 거부. 페이지 오류·가로 넘침·외부 런타임 요청·업로드 요청 없음. 실제 AR 하드웨어 검사는 아닙니다.
- 공개 HTML·JS·CSS 모두 HTTP 200이며 SHA-256이 검증한 빌드와 일치했습니다.
- 현재 JS `index-4FOw498Z.js`, CSS `index-iD6aTJAG.css`. 기존 캐시된 HTML의 로딩 실패를 피하려고 과거 해시 자산도 게시 브랜치에 유지했습니다.

같은 승인된 저장소·무료 Pages 주소를 사용합니다. 실제 휴대폰의 새 방식과 줌, 높이 정확도는 미검증입니다.

## v0.2.3 과거 배포와 검증 근거

- [Pages 배포 작업](https://github.com/ruy911-png/galaxy-height-check/actions/runs/42356328291): 완료, 성공.
- 게시 브랜치: `gh-pages`, 게시 커밋: `c0a609277ba70979a879866ee1482825d2d7d93c`.
- 공개 HTTPS의 HTML·JS·CSS 응답 200을 확인했고, 실제 응답 파일이 로컬 빌드와 SHA-256 기준으로 일치했습니다.
- 실제 Chromium에서 네 화면 폭의 공개 페이지 검사와 별도 모의 카메라 거부 검사, 총 5건이 통과했습니다. 실제 휴대폰 AR·높이 정확도 검증은 아닙니다.
- 타입 검사·프로덕션 빌드·자동 검사 95개가 통과했습니다. 상세 결과는 [검증 기록](verification.md)에 있습니다.

## 권한 제한의 의미

GitHub 연결 앱은 승인된 저장소의 소스·정적 파일 푸시를 수행할 수 있었으나, Pages 설정 변경 API는 `403 Resource not accessible by integration`을 반환했습니다. 사용자 계정의 저장소 관리 권한이 없다는 뜻은 아닙니다. 당시 설정 저장 동작을 사용자에게 안내했지만, 이후 실제 Pages 배포 성공과 공개 HTTPS 응답을 확인했으므로 추가 설정은 필요하지 않습니다.

공개 푸시는 사용자가 “소스코드 공개 커밋·푸시와 GitHub Pages 공개 배포를 승인합니다”라고 명시한 뒤 수행했습니다. 이 승인은 유료 서비스 사용까지 포함하지 않습니다.

## 호스팅 설정과 남은 확인

Vite의 `base: './'`와 `public/.nojekyll`을 사용합니다. `public/_headers`는 Cloudflare Pages·Netlify용 파일이며 GitHub Pages에서는 적용되지 않습니다. 실제 공개 페이지의 보안 문맥과 리소스 로드는 확인했습니다. WebXR은 HTTPS 최상위 페이지에서 실행하며, 사용자 사진에서 바닥 지정 후 천장 단계 진입을 확인했습니다. 천장은 아직 기울어진 면으로 판단되어 지정되지 않았으므로 실제 갤럭시 Chrome에서 확인이 필요합니다.

초기 내부 미리보기와 Cloudflare Quick Tunnel 연결을 사용할 수 없어 해당 경로는 채택하지 않았습니다. Cloudflare 사이트는 생성하지 않았습니다. 휴대폰에는 localhost가 아닌 위 공개 HTTPS 주소를 안내합니다.

남은 일은 자체 앱의 실내 바닥·천장 인식 확인, 줄자 기준과 5회 측정 비교입니다. 실제 정확도는 미검증이며 실측 후 화면과 결과 저장 기능을 마무리합니다.

공식 참고:

- https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https
- https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
