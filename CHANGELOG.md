# 변경 기록

사용자·운영자·책 독자가 알아야 할 의미 있는 변경을 기록합니다. 기준과 작성 절차는 [project-changelog 스킬](.agents/skills/project-changelog/SKILL.md)에 있습니다. 버전 번호를 임의로 부여하지 않고, 통합·배포를 확인한 한국시간 날짜로 정리합니다.

아래 과거 항목은 확인 가능한 PR의 주요 이력을 요약한 것이며, 모든 커밋이나 릴리스를 나열한 목록은 아닙니다.

## 미출시 (Unreleased)

### 추가

- 데모 앱과 팩토리 대시보드에 Google Analytics 4를 추가했습니다. `roboco.io`에서 방문자가 동의 배너에서 동의한 뒤에만 GA를 불러오고, "통계 설정"에서 동의를 철회하면 수집을 끄고 데모 전용 GA 쿠키를 지웁니다. 로컬 실행과 PR 프리뷰에서는 배너와 GA를 불러오지 않습니다. [PR #68](https://github.com/roboco-io/the-software-factory-demo/pull/68)

### 변경

- 웹 홈 화면에 표시되는 사이트 이름을 `conduit`에서 `conveyor`로 변경했습니다. 이름 변경 후 프로덕션 스모크·배포 확인·PR 프리뷰 확인이 옛 이름을 찾아 실패하던 문제도 새 이름 기준으로 고쳤습니다. [PR #65](https://github.com/roboco-io/the-software-factory-demo/pull/65), [PR #64](https://github.com/roboco-io/the-software-factory-demo/pull/64)

## 2026-10-14

### 변경

- 저장소 이름과 공개 링크를 `the-software-factory-demo`로 변경했습니다. 데모 문서·런 기록·팩토리 기본 주소를 맞추고, 책 집필 프로젝트의 72개 공개 링크도 갱신했습니다. [데모 PR #61](https://github.com/roboco-io/the-software-factory-demo/pull/61), [책 PR #1](https://github.com/roboco-io/the-software-factory/pull/1)
- README에 로보코가 제안하는 소프트웨어 팩토리의 구현체라는 이름의 의미와 책 『The Software Factory』와의 관계를 설명하고, 개발자·운영자 상세 안내를 [별도 문서](docs/operations.md)로 분리했습니다.

### 추가

- 변경 기록 파일과 기록·제외 기준을 적용하는 프로젝트 스킬을 추가했습니다. 기능·운영 정책·공개 사용법의 실질적 변화는 기록하고, 포맷·반복 실행·상태 로그는 제외합니다.

## 2026-10-13

### 추가

- 요청별 처리 타임라인, 자가 개선의 관찰 근거, 에이전트 도구·실제 모델별 실행 결과를 대시보드에 제공합니다. 비용 누락, 표본 부족, 관찰 범위 밖의 데이터를 구분하고 체험·리포지토리 링크를 안내합니다. [PR #60](https://github.com/roboco-io/the-software-factory-demo/pull/60)
- 병렬 로컬 작업에 별도 브랜치와 워크트리를 사용하도록 개발 지침을 명시합니다. [PR #57](https://github.com/roboco-io/the-software-factory-demo/pull/57)

### 변경

- 비개발자가 개념을 이해하고 직접 체험하도록 README에 실행 절차, 권한과 자가 개선 PoC를 안내합니다. [PR #57](https://github.com/roboco-io/the-software-factory-demo/pull/57), [PR #58](https://github.com/roboco-io/the-software-factory-demo/pull/58)
- 프로젝트 자체 코드·문서·설정에 Apache-2.0을 적용하고, RealWorld의 MIT 고지를 보존합니다. [PR #56](https://github.com/roboco-io/the-software-factory-demo/pull/56)

## 2026-10-12

### 추가

- 반복되는 오류 응답 형식 지적을 자동 검사 규칙과 평가 케이스로 전환하는 자가 개선 실험을 검증했습니다. [PR #47](https://github.com/roboco-io/the-software-factory-demo/pull/47)

### 수정

- 이미 개선 규칙으로 처리한 과거 실패가 같은 개선 후보로 다시 선정되지 않게 합니다. [PR #51](https://github.com/roboco-io/the-software-factory-demo/pull/51)
- 후속 배포가 성공하면 대체된 배포 실행에 연결된 이슈의 완료 상태도 반영합니다. [PR #52](https://github.com/roboco-io/the-software-factory-demo/pull/52)
