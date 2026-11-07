# 휴대폰용 HTTPS 공개 계획 — GitHub Pages 승인됨

초기에는 별도 지시 없이 커밋·푸시·공개 배포·유료 결제를 하지 않도록 요청받았습니다. 이후 사용자가 `ruy911-png/galaxy-height-check` 공개 저장소 생성·코드 커밋·푸시·GitHub Pages 공개 배포를 명시적으로 승인했습니다. 유료 결제는 하지 않습니다. 배포 완료 여부는 실제 배포 결과로 갱신합니다.

## 준비된 대상

- 앱: 높이 보기 v0.2, 빌드·자동 검사 69개 통과.
- 공개할 파일: `dist/`의 HTML, JS, CSS, 오픈소스 라이선스 고지, 보안 헤더 설정.
- 코드 저장소·테스트·작업 기록·사용자 사진은 배포 압축 파일에 넣지 않습니다.
- 별도 서버 API·DB·유료 API·로그인 기능은 없습니다. 카메라 영상과 측정 좌표는 업로드하지 않습니다.
- 자체 앱의 실제 휴대폰 AR·실내 높이 정확도는 공개 후 별도 확인해야 합니다.

## 이전 검토 후보: Cloudflare Pages Direct Upload — 선택하지 않음

- 비용: 순수 정적 파일 요청은 무료·무제한이라는 공식 요금 안내를 확인했습니다. 이 앱은 유료 Functions, DB, 사용자 지정 유료 도메인을 사용하지 않습니다.
- 주소 형태: Cloudflare가 배정하는 HTTPS `프로젝트명.pages.dev`. 현재 실제 주소나 예약된 프로젝트는 없습니다.
- 공개 범위: 링크를 아는 누구나 정적 앱 파일을 받을 수 있습니다. 앱 방문자의 로그인은 요구하지 않습니다.
- 필요한 계정 작업: 사이트 소유자의 Cloudflare 계정 인증. 현재 이 작업 환경에는 해당 계정 인증이 연결되어 있지 않습니다. 비밀번호나 토큰을 채팅에 적도록 요구하지 않습니다.
- Git: 직접 업로드 방식이므로 커밋·푸시가 필요 없습니다.
- 공개 지시와 계정 인증을 받은 뒤 업로드하고, 배포 URL·보안 헤더·최상위 Chrome 실행을 확인합니다. 연결되지 않은 계정에 배포할 수 있다고 미리 보장하지 않습니다.

공식 근거:

- https://developers.cloudflare.com/pages/get-started/direct-upload/
- https://developers.cloudflare.com/pages/functions/pricing/

## 승인된 경로: GitHub Pages

연결된 GitHub 계정은 `ruy911-png`로 확인했습니다. 연결 도구와 GitHub CLI의 읽기 요청에서 같은 계정을 확인했습니다. 사용자가 공개 저장소를 생성했고, 로컬 소스·게시 커밋은 준비했습니다. 푸시·Pages 설정은 아직 실행하지 못했습니다.

- 저장소: `ruy911-png/galaxy-height-check`. 사용자 생성 완료 후 API에서 공개 저장소, 크기 0, main 기본 브랜치, 쓰기·관리 권한을 확인했습니다.
- 배포 후 예상 주소: `https://ruy911-png.github.io/galaxy-height-check/`. 아직 작동하는 주소가 아닙니다.
- 비용: GitHub Free의 공개 저장소와 기본 Pages 도메인을 사용하면 정적 호스팅은 0원입니다. 유료 러너·유료 도메인·서버·측정 API는 사용하지 않습니다.
- 공개 범위: 공개 저장소의 소스코드와 게시한 웹앱 파일. 카메라 영상·사용자 사진을 저장소나 서버로 업로드하지 않습니다.
- 준비: Vite의 상대 경로 `base: './'`는 프로젝트 하위 경로에서 작동하며, 정적 게시용 `public/.nojekyll`을 추가했습니다.
- 게시 방식: 승인 후 공개 저장소를 만들고 소스와 검증된 정적 빌드를 커밋·업로드합니다. 빌드 파일 게시 브랜치를 Pages에 연결합니다. 브랜치 게시에 필요한 기본 GitHub 처리 외에 별도 유료 CI를 구성하지 않습니다.
- GitHub Pages는 `public/_headers`의 Cloudflare 전용 헤더 설정을 적용하지 않습니다. HTTPS 최상위 페이지와 WebXR의 기본 self 권한을 사용하며 실제 배포 헤더와 카메라 동작은 배포 후 확인합니다. 앱의 영상 업로드 금지는 클라이언트 구현에서도 유지합니다.
- 현재 GitHub 연결 도구에는 저장소 생성·Pages 설정 기능이 없어 해당 작업은 CLI/API 경로로 진행해야 합니다. 읽기 접근은 확인했으나 실제 생성·쓰기 권한은 승인 뒤 작업에서 확인해야 합니다.

‘깃허브는?’이라는 선택지 질문 자체를 승인으로 해석하지 않았습니다. 이후 공개 저장소 생성·코드 커밋·푸시·Pages 공개 배포 범위를 다시 명시했고 사용자가 승인했습니다.

공식 근거:

- https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https
- https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

## 확인했지만 현재 사용할 수 없는 임시 경로

Cloudflare Quick Tunnel은 무료·계정 없이 임시 HTTPS 주소를 제공하지만, Cloudflare edge에 TCP/UDP 7844 연결이 필요합니다. 공개나 터널 생성 없이 `region1.v2.argotunnel.com:7844`에 TLS 연결만 시도한 사전 검사에서 **`OSError [Errno 101] Network is unreachable`**이 나왔습니다. 현재 환경에서 사용할 수 있는 실행 경로로 제시하지 않습니다.

환경 자체의 `sites-preview`도 `preview relay unavailable`로 확인됐습니다. 따라서 localhost를 휴대폰용 HTTPS 링크로 오인하게 안내하지 않습니다.

- https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/

현재 상태: GitHub의 저장소 생성 API는 `403 Resource not accessible by integration`으로 거절됐고, 사용자가 GitHub 화면에서 해당 공개 저장소를 생성했습니다. 로컬 소스·게시 커밋은 준비했습니다. 이후 자동 승인 심사가 짧은 응답을 충분히 명확하지 않다고 판단해 푸시를 차단했습니다. 사용자에게 범위를 다시 표시했고 **‘소스코드 공개 커밋·푸시와 GitHub Pages 공개 배포를 승인합니다’**라는 명시적 답변을 받았습니다. 이 승인에 따라 업로드와 배포를 이어갑니다. 유료 결제는 수행하지 않습니다.
