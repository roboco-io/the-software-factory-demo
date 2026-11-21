# migrations

## Overview

제어 평면 Worker가 쓰는 D1 데이터베이스(`software-factory`, 바인딩 `DB`)의 스키마 마이그레이션이다. `wrangler.jsonc`의 `d1_databases[].migrations_dir`가 이 디렉터리를 가리킨다. 파일은 번호 순서대로 적용되며, 0003-0005는 SQLite가 `CHECK` 제약을 바꾸지 못하기 때문에 테이블을 새로 만들고 행을 복사하는 방식으로 제약을 넓힌다.

## Interface

| 파일                              | 만들거나 바꾸는 객체                                                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_runs_events.sql`            | `runs`(id, repo, issue_number, state, reason_code, pr_number, created_at, updated_at), `events`, 인덱스 `runs_one_active_per_issue`, `events_by_run`, 트리거 `events_no_update`, `events_no_delete` |
| `0002_deliveries.sql`             | `deliveries`(delivery_id PK, received_at). GitHub `X-GitHub-Delivery` 값으로 중복 웹훅을 거른다                                                                                                     |
| `0003_review_and_merge.sql`       | `runs`와 `events`를 재생성해 리뷰·병합 상태와 사유 코드를 추가한다                                                                                                                                  |
| `0004_merged_outside_factory.sql` | `events`를 재생성해 `reason_code`에 `merged_outside_factory`를 추가한다                                                                                                                             |
| `0005_stopped_by_operator.sql`    | `events`를 재생성해 `reason_code`에 `stopped_by_operator`를 추가한다                                                                                                                                |
| `0006_console.sql`                | `runs`에 `title`, `tier`, `head_sha` 열(nullable)을 추가하고, `run_usage`(id AUTOINCREMENT PK, run_id, phase, model, 토큰 4종, ts; 모든 열 NOT NULL)와 인덱스 `run_usage_by_run`을 만든다           |

## Invariants

- `runs.state`는 0003 이후 `queued`, `cloning`, `implementing`, `publishing`, `pr_opened`, `reviewing`, `awaiting_checks`, `awaiting_approval`, `merged`, `needs_human`, `failed` 중 하나다(`CHECK`).
- `runs_one_active_per_issue`는 부분 UNIQUE 인덱스다. 0003 이후 한 `(repo, issue_number)`에 `merged`, `needs_human`, `failed`가 아닌 실행은 하나만 존재할 수 있다.
- `events`는 추가 전용이다. `events_no_update`와 `events_no_delete` 트리거가 UPDATE와 DELETE를 `RAISE(ABORT, 'events are append-only')`로 막는다.
- `events.kind`는 `created`, `transition`, `cleanup` 중 하나이고, `events.reason_code`는 고정 목록으로 `CHECK`된다. `runs.reason_code`, `runs.title`, `runs.tier`, `runs.head_sha`, `run_usage.phase`, `run_usage.model`에는 `CHECK`가 없다.
- `events.run_id`와 `run_usage.run_id`는 `runs(id)`를 참조하는 FK다.
- 순서 의존성: 0004와 0005는 `IF EXISTS` 없이 `DROP TRIGGER`를 실행하므로 0003이 만든 트리거가 있어야 하고, 이전 `events`의 7개 열을 이름으로 복사하므로 새 `CHECK` 목록은 이전 목록을 모두 포함해야 한다. 0006은 `ADD COLUMN`과 `CREATE TABLE`만 하므로 `runs` 테이블이 있으면 적용된다. 0002는 독립적이다.
- 새 사유 코드를 추가하려면 `src/run-types.ts`의 `REASON_CODES`와 함께 0004·0005와 같은 재생성 마이그레이션을 새 번호로 추가해야 한다. 둘 중 하나만 바꾸면 `d1-repo.test.ts`가 모든 `REASON_CODES`, `EVENT_KINDS`, `STATES` 값을 마이그레이션된 스키마에 넣어 보는 시험에서 실패한다. 조회 쪽(`src/read-repo.ts`)은 `REASON_CODES`에 없는 저장값을 `null`로 바꾼다.
- 앞으로 `runs`를 재생성하는 마이그레이션은 외래 키 때문에 `events`와 `run_usage`를 먼저 옮기거나 지워야 한다. 0003은 같은 이유로 `events`를 `runs`보다 먼저 지운다.

## Side Effects

- 0003은 `state = 'pr_opened'`인 기존 행을 `needs_human`과 `reason_code = 'legacy_run'`으로 바꾼다. 다른 행은 상태를 유지한다. 이 재작성은 `events` 행을 추가하지 않으므로, 재작성된 실행의 이벤트 기록은 `to_state = 'pr_opened'`에서 끝난다. 재작성은 활성 실행 인덱스의 조건이 `NOT IN ('pr_opened','failed')`에서 `NOT IN ('merged','needs_human','failed')`로 바뀌기 전에 실행된다.
- 0004는 과거의 `pr_closed` 실행을 일부러 재작성하지 않는다.
- 0003-0005는 트리거를 지우고, `events`를 임시 테이블(`events_old`)로 복사한 뒤 재생성하고, 원래 id 그대로 행을 되돌려 넣고, 인덱스와 트리거를 다시 만든다.
- 0006은 기존 `runs` 행의 새 열을 NULL로 둔다. 데이터 복사는 없다.

## Verification

- Run: `pnpm --filter @factory/control test`. `src/d1-*.test.ts`는 실제 D1이 아니라 D1 형태의 어댑터를 씌운 메모리 `node:sqlite`에 이 디렉터리의 마이그레이션을 적용하고 실행한다(`src/testing/d1.ts`, `PRAGMA foreign_keys = ON`). 어댑터는 `process.cwd()/migrations`를 읽으므로 `apps/control`에서 실행해야 한다. `d1-stage3.test.ts`는 0003과 0004의 업그레이드를 단계별로 시험한다.
- 프로덕션 적용: `.github/workflows/deploy.yml`이 `wrangler deploy` 전에 `wrangler d1 migrations apply DB --remote`를 실행한다.
- 로컬 적용: `pnpm --filter @factory/control exec wrangler d1 migrations apply software-factory --local`
