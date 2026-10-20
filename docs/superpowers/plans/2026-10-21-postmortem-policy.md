# 정책 기반 자동 포스트모템 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프로덕션 장애와 팩토리 정체를 감지 즉시 분석하고, 원인 PR을 확신하면 되돌려 복구하며, 복구 후 포스트모템 기록과 개선 PR을 남기는 기능을 `factory/postmortem-policy.yml` 정책으로 운영한다.

**Architecture:** 기존 단계가 장애를 만들거나 복구할 때 `factory-postmortem.yml`을 dispatch한다. 새 phased stage `postmortem`이 prepare에서 결정적 타임라인을 모으고, agent에서 구조화된 분석을 받고, publish에서 기록·되돌리기·재오픈·개선 위임을 코드로 판정한다. 되돌리기 PR은 새 PR 역할 `revert`로 기존 gate를 지난다.

**Tech Stack:** TypeScript, Zod, Vitest, GitHub Actions, 기존 `packages/factory` 포트(GitHubPort, GitPort, RunStore).

**Spec:** `docs/superpowers/specs/2026-10-21-postmortem-policy-design.md`

## Global Constraints

- 이 계획의 모든 변경은 T3다. 병합은 CODEOWNERS 승인 후 사람이 한다.
- 예산 기본값: 장애당 분석 2회(1차 1, 사후 1), 회당 2 USD·15분, 일일 합계 10 USD.
- 포스트모템 기록 최대 6000자. 각 원인 문장에 `[사실]` 또는 `[추정]`을 붙인다. 비난 없는 서술.
- 되돌리기 판정은 코드가 한다. 확신 조건 5개(spec 4.4)를 모두 충족할 때만 되돌린다. 실패 원문이 없으면 되돌리지 않는다.
- 되돌리기 PR도 `factory/risk-policy.yml` 등급을 따른다. T0·T1만 자동 병합, T2·T3는 PR만 연다. 마이그레이션 파일은 되돌리지 않는다.
- 모델 ID를 코드에 쓰지 않는다. 역할 `postmortem`의 엔진은 `factory/agents.yml`, 모델은 엔진의 env 변수(`CLAUDE_MODEL` 등)로 정한다.
- 테스트를 먼저 쓴다. 각 Task는 실패하는 테스트 커밋을 구현 커밋보다 먼저 둔다.
- 마크다운: 범위는 `-`, 닫는 `**` 앞이 문장부호면 뒤에 공백. `pnpm lint`가 검사한다.
- 완료 조건: 각 Task 끝에 `pnpm format && pnpm typecheck && pnpm lint && pnpm test`가 통과한다.

### spec과 다르게 정한 것 (계획 작성 중 확인한 코드 사실에 따른 판단)

1. **정체 사유 목록**: 2026-10-21 main의 실제 사유로 확정한다. 정체: `max_turns, timeout, budget, engine_error, invalid_output, merge_refused, smoke_contract, preview_deploy, human_action, unlisted_check, risk_tier, too_many_files, skip_txt, review_needs_human`. 제외: `risk_t2, risk_t3, permission_denied, deploy_failed`. `review_needs_human`은 Task 2가 새로 기록한다(spec의 `review_failed` 대체).
2. **되돌리기 후 복구 확인**: `deploy.yml`의 smoke job은 curl 3개뿐이고 복구 표식을 남기지 않는다. 그래서 되돌리기 커밋이 배포되면 `runDeployed`가 `factory-smoke.yml`을 즉시 dispatch하고, 그 전체 스모크의 기존 복구 경로가 "복구됨"을 남긴다. 정기 주기를 기다리지 않는다는 spec의 의도는 같다.
3. **되돌리기 PR 메타**: `implementEngine`/`implementModel`은 1차 분석을 한 엔진·모델을 쓴다. 병합 커밋은 `Factory-Issue` 대신 `Factory-Revert: #<장애 이슈>` trailer를 써서 deploy 상태 전이 대상에서 빠진다.
4. **개선 PR 위임**: 별도 워크플로를 만들지 않고 `factory-weekly.yml`에 `workflow_dispatch` 입력 `issue`를 더한다. 입력이 있으면 report job을 건너뛰고 그 이슈로 improve를 돌린다.

## Review Focus

- 같은 장애 이벤트가 두 번 dispatch됨(재실행, 동시 트리거) → 두 번째 실행은 같은 (이슈, 회차, 단계) 레코드를 보고 아무것도 하지 않는다. Task 6에 테스트.
- 포스트모템이 만든 되돌리기 PR 자체가 체크에 실패함 → 장애 이슈에 코멘트만 남기고, 정체 포스트모템을 다시 부르지 않는다(무한 연쇄 방지). Task 8에 테스트.
- 원인 PR이 이미 사람에 의해 되돌려졌거나 되돌리기가 충돌함 → 되돌리지 않고 진단만 남긴다. Task 7에 테스트.
- 스모크가 짧게 흔들림(실패→복구→실패) → 회차마다 별도 장애로 세지만 일일 상한 10 USD가 전체를 막는다. Task 6에 테스트.
- `@factory stop`처럼 사람이 옮긴 `needs-human` → 정체 포스트모템을 시작하지 않는다. Task 2에 테스트.

---

### Task 1: 정책 파일과 로더

**Files:**
- Create: `factory/postmortem-policy.yml`, `packages/factory/src/policy/postmortem.ts`
- Modify: `packages/factory/src/stages/deps.ts` (StageDeps), `packages/factory/src/main.ts` (`buildDeps`), `packages/factory/test/helpers.ts` (`makeTestDeps`), `.github/CODEOWNERS`는 `/factory/`로 이미 덮이므로 변경 없음
- Test: `packages/factory/test/postmortem-policy.test.ts`

**Interfaces:**
- Produces:
  - `PostmortemPolicySchema` (zod), `type PostmortemPolicy = { triggers: { production: string[]; stall: { reasons: string[]; exclude: string[] } }; revert: { enabled: boolean; reopenRequest: boolean }; budget: { perIncidentAnalyses: number; perAnalysisUsd: number; perAnalysisMinutes: number; dailyUsd: number }; report: { maxChars: number } }`
  - `parsePostmortemPolicy(text: string): PostmortemPolicy`, `loadPostmortemPolicy(file = path.join(FACTORY_DIR, "postmortem-policy.yml")): PostmortemPolicy`
  - `StageDeps.postmortem: PostmortemPolicy`

YAML 키는 snake_case(`per_incident_analyses`), 스키마가 camelCase로 변환한다. `revert.require`는 코드가 고정하므로 파일에 두지 않는다. `agent.role`도 두지 않는다(역할은 agents.yml).

- [ ] **Step 1: 실패하는 테스트**

```ts
it("loads the repository policy with the spec defaults", () => {
  const p = loadPostmortemPolicy();
  expect(p.budget).toEqual({ perIncidentAnalyses: 2, perAnalysisUsd: 2, perAnalysisMinutes: 15, dailyUsd: 10 });
  expect(p.report.maxChars).toBe(6000);
  expect(p.triggers.production).toEqual(["source:smoke", "source:deploy", "source:error"]);
  expect(p.triggers.stall.exclude).toEqual(["risk_t2", "risk_t3", "permission_denied", "deploy_failed"]);
  expect(p.triggers.stall.reasons).toContain("review_needs_human");
});
it("rejects a reason listed as both stall and excluded", () => {
  expect(() => parsePostmortemPolicy(/* reasons와 exclude에 risk_t2 */)).toThrow();
});
it("rejects non-positive budgets", () => { /* daily_usd: 0 → throw */ });
```

- [ ] **Step 2: 실행해 실패 확인** — `pnpm --filter factory exec vitest run test/postmortem-policy.test.ts` → FAIL (모듈 없음)
- [ ] **Step 3: 구현** — `risk.ts`의 `parseRiskPolicy` 패턴(yaml 파싱 + zod)을 따른다. `buildDeps`와 `makeTestDeps`에 `postmortem: loadPostmortemPolicy()`를 넣는다.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, `pnpm --filter factory typecheck` 통과
- [ ] **Step 5: 커밋** (테스트 커밋 → 구현 커밋)

### Task 2: 정체 신호 정리와 트리거 헬퍼

**Files:**
- Create: `packages/factory/src/stages/postmortem-trigger.ts`
- Modify: `packages/factory/src/stages/common.ts` (`stepRecord` 역할에 `"review"` 추가, `moveTo`에서 트리거), `packages/factory/src/stages/review.ts` (needsHuman 경로에 레코드), `packages/factory/src/stages/smoke.ts`, `packages/factory/src/stages/deploy.ts` (`runDeployFailed`), `packages/factory/src/stages/intake.ts` (오류 이슈 생성)
- Test: `packages/factory/test/postmortem-trigger.test.ts`, 기존 `smoke.test.ts`·`review.test.ts`·`deploy.test.ts`·`intake.test.ts`에 추가

**Interfaces:**
- Produces:
  - `type PostmortemEvent = "detected" | "recovered"`
  - `type IncidentKind = "smoke" | "deploy" | "error" | "stall"`
  - `requestPostmortem(deps: StageDeps, input: { issue: number; kind: IncidentKind; event: PostmortemEvent }): Promise<void>` — `factory-postmortem.yml`을 `{ issue, kind, event }`(문자열)로 dispatch한다. 예외는 로그만 남기고 삼킨다(장애 보고 자체를 막지 않는다).
  - `SmokeAction`에 `"refailed"` 추가: 열린 스모크 이슈의 현재 상태가 `recovered`인데 다시 실패하면 반환한다.
- Consumes: Task 1의 `deps.postmortem`은 쓰지 않는다(필터링은 Task 6 prepare가 한다).

트리거 위치:
- `runSmokeReport`: `created`·`refailed` → `detected/smoke`, `recovered` → `recovered/smoke`
- `runDeployFailed`: 각 이슈마다 `detected/deploy`
- `runIntake`: 새 `source:error` 이슈 생성 시 `detected/error`
- `moveTo`: `to === "needs-human"`이고 `actor !== "command"`이면 `detected/stall`
- review의 needsHuman 경로(PR #77): `moveTo` 전에 `record(deps, stepRecord("review", issue, pr, false, "review_needs_human", round))`

- [ ] **Step 1: 실패하는 테스트**

```ts
it("dispatches a postmortem when the factory moves an issue to needs-human, but not for @factory stop", async () => {
  // moveTo(deps, n, "needs-human", "gate", "x") → dispatches에 { file: "factory-postmortem.yml", inputs: { issue: String(n), kind: "stall", event: "detected" } }
  // moveTo(deps, n, "needs-human", "command", "x") → postmortem dispatch 없음
});
it("reports refailed and requests a postmortem when a recovered smoke issue fails again", async () => {
  // failure → recovered 이후 failure: action "refailed", dispatch detected/smoke 2회째
});
it("requests a recovered postmortem when the smoke recovers", async () => { /* event: "recovered" */ });
it("records review_needs_human when the review hands an issue to a human", async () => {
  // review.test.ts의 PR #65 needsHuman 테스트에 레코드 검증 추가: failureReason "review_needs_human", role "review"
});
it("requests a deploy postmortem from runDeployFailed and an error postmortem from a new error issue", ...);
it("never throws when the postmortem dispatch fails", async () => { /* dispatchWorkflow가 throw해도 moveTo는 true */ });
```

- [ ] **Step 2: 실행해 실패 확인** — 위 파일들 vitest → FAIL
- [ ] **Step 3: 구현** — 위 위치에 호출을 넣는다. `smoke.ts`는 코멘트 전에 `smokeStatus`로 이전 상태를 읽어 `refailed`를 구분한다.
- [ ] **Step 4: 통과 확인** — `pnpm --filter factory test` PASS
- [ ] **Step 5: 커밋**

### Task 3: 포트 확장 (GitHub·Git)

**Files:**
- Modify: `packages/factory/src/github/port.ts`, `octokit.ts`, `memory.ts`, `forbidden.ts`; `packages/factory/src/git/port.ts`와 실제 구현 파일; `packages/factory/test/helpers.ts` (FakeGit)
- Test: `packages/factory/test/github-memory.test.ts`(없으면 생성), `packages/factory/test/git.test.ts`(기존 git 테스트 파일에 추가)

**Interfaces:**
- Produces (GitHubPort):
  - `reopenIssue(n: number): Promise<void>`
  - `editComment(id: number, body: string): Promise<void>`
  - `MergedPull`에 `mergeSha: string | null`, `headSha: string | null` 추가
  - `ChangedFile`에 `deletions: string[]` 추가(패치의 `-` 줄, `additions`와 같은 방식으로 파싱)
  - memory 헬퍼: `InMemoryGitHub.reopenIssue`, `editComment`, `pulls` 저장 시 `mergeSha`·`headSha` 유지
- Produces (GitPort):
  - `revert(sha: string, message: string): Promise<string | null>` — `git revert --no-edit` 후 메시지로 커밋하고 새 sha를 반환한다. 충돌하면 `git revert --abort` 후 `null`.
  - 브랜치 허용 정규식에 `factory/revert-issue-[1-9]\d*`를 추가한다(`BRANCH`, `START_POINT`).
  - `revertPaths?: string[]`는 두지 않는다. 마이그레이션 제외는 Task 7이 되돌리기 후 해당 파일만 원복하는 `restorePaths(paths: string[], fromSha: string): Promise<void>`로 한다. `restorePaths`도 GitPort에 추가한다(`git checkout <fromSha> -- <paths>` 후 amend 없이 다음 commitAll이 반영).
- forbidden(agent 단계) 구현은 모두 throw한다.

- [ ] **Step 1: 실패하는 테스트** — memory: reopen 후 `getIssue(n).state === "open"`, editComment 후 `listComments`의 body 갱신, `listMergedPulls`가 `mergeSha`를 돌려줌. git(실제 임시 저장소): 커밋 A 되돌리기 → 새 sha·파일 원복, 충돌 시 `null`이고 작업 트리가 깨끗함, `factory/revert-issue-66` 브랜치 checkout 허용·`factory/revert-x` 거부. octokit 패치 파서: `-` 줄이 `deletions`에 들어감.
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — `pnpm --filter factory test`
- [ ] **Step 5: 커밋**

### Task 4: 장애 모델과 타임라인 수집

**Files:**
- Create: `packages/factory/src/postmortem/incident.ts`, `packages/factory/src/postmortem/timeline.ts`
- Modify: `packages/factory/src/stages/intake.ts` (오류 이슈 본문에 `writeMarker("factory:error-first-seen", { at: e.firstSeen })`)
- Test: `packages/factory/test/postmortem-timeline.test.ts`

**Interfaces:**
- Consumes: Task 3의 `MergedPull.mergeSha/headSha`, `ChangedFile.deletions`
- Produces:
  ```ts
  interface Incident { issue: number; kind: IncidentKind; episode: number; detectedAt: string; lastGoodAt: string | null; recoveredAt: string | null }
  interface CandidatePr { number: number; title: string; author: "bot" | "human"; mergedAt: string; mergeSha: string | null;
    tier: Tier; files: { path: string; tier: Tier; deletions: string[]; additions: string[] }[];
    checks: { name: string; state: CheckState }[]; requestIssue: number | null }
  interface Timeline { incident: Incident; excerpt: string | null; candidates: CandidatePr[]; runs: RunRecord[]; windowStart: string }
  resolveIncident(deps: StageDeps, issue: number, kind: IncidentKind): Promise<Incident>
  collectTimeline(deps: StageDeps, incident: Incident, opts?: { excerptOverride?: string }): Promise<Timeline>
  incidentKey(i: Incident): string   // `${issue}#${episode}`
  ```
- 규칙:
  - smoke: `episode` = 해당 이슈의 `role:"smoke", ok:true` 레코드 수 + 1 (복구 횟수 + 1). `detectedAt` = 그 회차의 첫 `smoke_failed` 레코드 ts. `lastGoodAt` = 직전 복구 레코드 ts, 없으면 null.
  - error: `lastGoodAt` = null, `windowStart` = `error-first-seen` 표식 시각 − 24시간.
  - deploy·stall: 후보 PR은 이슈의 요청 PR 하나(`Factory-Issue` 대상). `windowStart` = `detectedAt` − 24시간.
  - 나머지: `windowStart` = `lastGoodAt` ?? (`detectedAt` − 24시간). 후보 = `listMergedPulls(windowStart)` 중 `mergedAt` ∈ [windowStart, detectedAt].
  - `excerpt` = `excerptOverride` ?? 이 회차 첫 실패 레코드의 `detail` ?? null.
  - `checks`는 `listCheckRuns(headSha)`를 `checkState`로 요약하고, 필수·비필수를 모두 넣는다.
  - `runs` = `windowStart` 이후 레코드 중 이슈가 장애 이슈 또는 후보 PR의 요청 이슈인 것.

- [ ] **Step 1: 실패하는 테스트** — #66 재현 픽스처: 복구 이력 없는 스모크 이슈, `smoke_failed` 레코드(detail에 `name: 'conduit'`), 장애 구간 안에 병합된 봇 PR 1개(파일 `apps/web/src/pages/Home.tsx`, deletions에 `"conduit"`, `e2e-preview: failure`)와 구간 밖 PR 1개. 기대: `episode 1`, 후보 1개, `checks`에 `{ name: "e2e-preview", state: "fail" }`, `excerpt`에 `conduit`. 복구 1회 후 재실패 픽스처: `episode 2`, `lastGoodAt` = 복구 레코드 ts. error 픽스처: `windowStart` = firstSeen − 24h.
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋**

### Task 5: 분석 스키마, 프롬프트, 되돌리기 판정, 기록 렌더링

**Files:**
- Create: `packages/factory/src/postmortem/analysis.ts`, `packages/factory/src/postmortem/report.ts`, `factory/prompts/postmortem.md`
- Modify: `packages/factory/src/agents/types.ts` (`Role`에 `"postmortem"`), `packages/factory/src/agents/prompt.ts` (`PromptName`, `DELIMITER_TAGS`에 `"timeline"`), `packages/factory/src/config/agents.ts` (`ConfigSchema.roles.postmortem`), `factory/agents.yml` (`postmortem: { engine: claude, budget: { maxTurns: 20, timeoutMin: 15, maxUsd: 2 } }`)
- Test: `packages/factory/test/postmortem-analysis.test.ts`, `prompt.test.ts`·`agents-config.test.ts`에 추가

**Interfaces:**
- Consumes: Task 4의 `Timeline`, `CandidatePr`; Task 1의 `PostmortemPolicy`
- Produces:
  ```ts
  const PostmortemAnalysisSchema = z.object({
    classification: z.enum(["bot_regression", "human_regression", "external", "stall"]),
    causePr: z.number().int().positive().nullable(),
    excerptQuote: z.string().nullable(),          // 실패 원문에서 그대로 인용한 부분
    rootCause: z.array(z.object({ text: z.string(), kind: z.enum(["fact", "guess"]) })),
    defenses: z.array(z.object({ text: z.string(), kind: z.enum(["fact", "guess"]) })),  // 막지 못한 방어선
    actions: z.array(z.string()),
    summary: z.string(),
  });
  type PostmortemAnalysis = z.infer<typeof PostmortemAnalysisSchema>;
  type RevertDecision = { revert: true; pr: CandidatePr } | { revert: false; reason: RevertRefusal };
  type RevertRefusal = "disabled" | "not_production_breakage" | "not_regression" | "no_cause" | "unknown_cause" | "no_excerpt" | "quote_not_in_excerpt" | "no_overlap" | "already_reverted";
  decideRevert(t: Timeline, a: PostmortemAnalysis, policy: PostmortemPolicy): RevertDecision
  renderPostmortem(t: Timeline, a: PostmortemAnalysis | null, outcome: { action: string }, maxChars: number): string
  POSTMORTEM_MARKER = "factory:postmortem"   // { key: incidentKey, phase: "initial" | "followup" }
  ```
- `decideRevert` 판정 순서(spec 4.4 조건 1-4, 조건 5 충돌은 Task 7이 git 결과로 판정):
  1. `policy.revert.enabled` false → `disabled`
  1a. `t.incident.kind`가 `deploy` 또는 `stall` → `not_production_breakage` (spec 4.2: 배포 실패는 진단만, 정체에는 되돌릴 PR이 없다)
  2. classification이 `*_regression`이 아님 → `not_regression`
  3. `causePr` null → `no_cause`; 후보에 없음 → `unknown_cause`
  4. `t.excerpt` null → `no_excerpt`
  5. `excerptQuote`가 null이거나 `t.excerpt`의 부분 문자열이 아님 → `quote_not_in_excerpt`
  6. 겹침: 인용에서 길이 4 이상 단어 토큰(`/[\p{L}\p{N}_-]{4,}/gu`, 소문자)을 뽑아, 원인 PR의 어떤 파일의 `deletions` 또는 `additions` 줄(소문자)이 그 토큰을 포함하거나, 파일 경로(소문자)가 토큰을 포함하면 겹침. 없으면 `no_overlap`
  7. 후보 중 원인 PR보다 뒤에 병합된 PR 제목이 `Revert` 와 원인 PR 번호를 함께 담으면 `already_reverted`
- `renderPostmortem`은 spec 4.5의 5개 절(요약, 타임라인, 원인, 막지 못한 방어선, 조치와 개선 PR)을 쓰고, 원인·방어선 줄 앞에 `[사실]`/`[추정]`을 붙인다. `a`가 null(예산 초과, 분석 실패)이면 타임라인만 쓰고 "분석 생략: <사유>"를 넣는다. `maxChars`를 넘으면 타임라인 표를 뒤에서부터 줄인다. 모든 외부 문자열은 `inline`/`codeBlock`/`neutralizeRefs`를 거친다.
- 프롬프트 `postmortem.md`: `{{untrustedNotice}}`, `<timeline>{{timeline}}</timeline>`(Timeline JSON), 판단 기준(근거는 타임라인 사실을 가리킬 것, 가리키지 못하면 `guess`, `excerptQuote`는 원문 그대로), 출력 형식. 변수는 `timeline` 하나.

- [ ] **Step 1: 실패하는 테스트**

```ts
it("reverts #65 in the #66 replay", () => {
  expect(decideRevert(TIMELINE_66, { ...A, classification: "bot_regression", causePr: 65,
    excerptQuote: "getByRole('heading', { name: 'conduit' })" }, POLICY)).toEqual({ revert: true, pr: expect.objectContaining({ number: 65 }) });
});
it.each([
  ["external", { classification: "external" }, "not_regression"],
  ["deploy failure", { /* TIMELINE_66을 kind: "deploy"로 */ }, "not_production_breakage"],
  ["no cause", { causePr: null }, "no_cause"],
  ["cause outside window", { causePr: 999 }, "unknown_cause"],
  ["invented quote", { excerptQuote: "TypeError: x" }, "quote_not_in_excerpt"],
  ["unrelated PR", { causePr: 70 /* docs만 바꾼 후보 */ }, "no_overlap"],
])("refuses to revert: %s", (_n, over, reason) => { /* reason 일치 */ });
it("refuses without a failure excerpt (#72)", () => { /* excerpt null → no_excerpt */ });
it("refuses when the cause was already reverted", ...);
it("refuses when the policy disables revert", ...);
it("renders the five sections, tags facts and guesses, and stays under maxChars", () => {
  const body = renderPostmortem(TIMELINE_66, A, { action: "되돌리기 PR #80" }, 6000);
  expect(body).toMatch(/## 요약[\s\S]*## 타임라인[\s\S]*## 원인[\s\S]*## 막지 못한 방어선[\s\S]*## 조치/);
  expect(body).toContain("[사실]"); expect(body).toContain("[추정]");
  expect(renderPostmortem(BIG_TIMELINE, A, { action: "x" }, 6000).length).toBeLessThanOrEqual(6000);
});
it("neutralizes the timeline closing tag in the prompt", () => { /* </timeline> 무력화 */ });
it("assigns the postmortem role from agents.yml", () => { /* roles.postmortem.engine === "claude", budget maxUsd 2 */ });
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋**

### Task 6: postmortem phased stage, CLI, 워크플로

**Files:**
- Create: `packages/factory/src/stages/postmortem.ts`, `.github/workflows/factory-postmortem.yml`
- Modify: `packages/factory/src/cli.ts` (`postmortem` 명령, 옵션 `kind`, `event`, `dry-run`), `packages/factory/src/runs/store.ts` (RunRecord에 선택 필드 `incident?: { key: string; kind: IncidentKind; phase: "initial" | "followup"; detectedAt: string; recoveredAt: string | null; causePr: number | null; reverted: boolean; classification: string | null }`), `packages/factory/test/workflows.test.ts` (FACTORY 목록, `AGENT_WORKFLOWS`, `PHASED` 정규식)
- Test: `packages/factory/test/postmortem-stage.test.ts`

**Interfaces:**
- Consumes: Task 1-5 전부
- Produces:
  ```ts
  interface PostmortemArgs { issue: number; kind: IncidentKind; event: PostmortemEvent; dryRun?: boolean; excerptOverride?: string }
  interface PostmortemPlan { args: PostmortemArgs; incident: Incident; timeline: Timeline; phase: "initial" | "followup";
    engine: EngineName; model: string; budget: Budget; prompt: string; skipAnalysis: null | "budget_incident" | "budget_daily" }
  type PostmortemOutcome = { result: TimedResult; analysis: PostmortemAnalysis | null };
  postmortemStage: PhasedStage<PostmortemArgs, PostmortemPlan, PostmortemOutcome>
  ```
- prepare 규칙:
  - `kind` 필터: `stall`이면 이슈의 가장 최근 `ok:false` 레코드 사유가 `triggers.stall.reasons`에 있어야 하고 `exclude`에 없어야 한다. 아니면 null. production kind면 이슈 라벨이 `triggers.production`에 있어야 한다.
  - 중복: 같은 `incidentKey`와 `phase`의 `role:"postmortem"` 레코드가 있으면 null(Review Focus 1).
  - 예산: 같은 key의 postmortem 레코드 수 ≥ `perIncidentAnalyses` → `skipAnalysis: "budget_incident"`. 오늘(UTC) postmortem 레코드 `costUsd` 합 ≥ `dailyUsd` → `"budget_daily"`. 예산 `Budget`은 agents.yml 값과 정책 값(`perAnalysisUsd`, `perAnalysisMinutes`) 중 작은 쪽.
  - `event: "recovered"` → `phase: "followup"`, 아니면 `"initial"`.
- agent: `skipAnalysis`가 있으면 에이전트를 부르지 않고 `analysis: null`. 아니면 `runStructured(..., { role: "postmortem", readOnly: true }, PostmortemAnalysisSchema)`.
- publish(이 Task 범위): `renderPostmortem`으로 기록을 쓴다. 장애 이슈의 봇 코멘트 중 같은 key의 `POSTMORTEM_MARKER`가 있으면 `editComment`, 없으면 `comment`. `dryRun`이면 `createIssue("[포스트모템 재생] #<issue>", body, [])`에 쓰고 다른 조치를 하지 않는다. 레코드: `role:"postmortem"`, `incident` 필드, `ok = analysis !== null`. 되돌리기·재오픈·개선은 Task 7·9가 이 publish에 더한다.
- crashed: 레코드만 남기고 상태를 바꾸지 않는다.
- 워크플로: `factory-review.yml`과 같은 prepare/agent/publish 구조, `workflow_dispatch` 입력 `issue`, `kind`, `event`, `dry_run`(boolean, 기본 false), `excerpt`(선택, 재생용). 추가로 `on: issues: types: [closed]` — 닫힌 이슈에 `source:error` 라벨 또는 `factory:` 상태 라벨이 있으면 `event=recovered`, `kind`는 라벨로 정한다(`source:error` → error, 그 밖 → stall). concurrency group `factory-postmortem-${issue}`, cancel-in-progress false. agent job `timeout-minutes: 20`.

- [ ] **Step 1: 실패하는 테스트**

```ts
it("analyzes a new smoke incident and posts one postmortem comment", ...);       // 코멘트 1개, 표식 key "N#1", 레코드 role postmortem
it("does nothing for a duplicate dispatch of the same incident and phase", ...); // 두 번째 runPhase: 에이전트 호출 0, 코멘트 1개 유지
it("updates the same comment on the followup analysis", ...);                    // recovered 후 editComment, 코멘트 수 그대로
it("skips the agent after two analyses of one incident", ...);                   // 세 번째: skipAnalysis budget_incident, 본문에 "분석 생략"
it("skips the agent when today's postmortem cost reached the daily cap", ...);   // costUsd 합 10 → budget_daily; 스모크 흔들림 3회차도 막힘
it("ignores a stall whose latest reason is excluded or human-made", ...);         // risk_t2, permission_denied → prepare null
it("writes a dry-run replay to a new issue only", ...);                           // createIssue 1회, 장애 이슈 코멘트 0, dispatch 0
it("records the incident fields for the dashboard", ...);
```
워크플로 테스트: `factory-postmortem.yml`이 phased 규칙(agent job에 토큰 없음, checkout `persist-credentials: false`, publish만 app token)을 지킨다.

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — `pnpm --filter factory test`
- [ ] **Step 5: 커밋**

### Task 7: 되돌리기 PR 생성

**Files:**
- Modify: `packages/factory/src/stages/postmortem.ts` (publish), `packages/factory/src/report/pr.ts` (`PrMetaSchema.role`에 `"revert"`)
- Test: `packages/factory/test/postmortem-stage.test.ts`에 추가

**Interfaces:**
- Consumes: Task 3 `revert`, `restorePaths`, `checkoutNewBranch`, `push`; Task 5 `decideRevert`
- Produces:
  - 브랜치 `factory/revert-issue-<장애 이슈>`
  - PR 제목 `revert: #<원인 PR> <원인 제목> (장애 #<장애 이슈>)`, 본문은 포스트모템 요약 링크 + 근거 + `writeMarker("factory:meta", { issue: <장애 이슈>, role: "revert", implementEngine: plan.engine, implementModel: plan.model, round: 0 })`
  - `REVERT_TRAILER = "Factory-Revert"`; 커밋 메시지 끝 `Factory-Revert: #<장애 이슈>`
- 규칙: `phase === "initial"`이고 `decideRevert`가 `revert: true`일 때만. 이미 열린 `factory/revert-issue-N` PR이 있으면 만들지 않는다. `git.revert(mergeSha)`가 null이면 되돌리지 않고 기록의 조치에 "되돌리기 충돌"을 쓴다(spec 조건 5). 원인 PR 파일 중 `apps/api/migrations/` 경로는 `restorePaths`로 원복한 뒤 커밋한다. 되돌리지 않으면 기록에 거절 사유를 쓰고, 장애 이슈에 `factory:needs-human` 라벨이 없으면 붙이지 않는다(장애 이슈는 상태 머신 밖이다). 레코드 `incident.reverted`를 채운다.

- [ ] **Step 1: 실패하는 테스트** — #66 재생 픽스처(가짜 분석이 #65 지목): 브랜치 push 1회, PR 1개, meta role `revert`, 커밋 메시지에 `Factory-Revert: #66`. 충돌(`FakeGit.revert`가 null): PR 0개, 기록에 "충돌". 마이그레이션 포함 PR: `restorePaths`가 `apps/api/migrations/0004_x.sql`로 호출됨. 열린 되돌리기 PR이 있으면 새로 만들지 않음. `dryRun`이면 PR 0개.
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋**

### Task 8: gate·on-closed·deploy의 revert 역할 처리

**Files:**
- Modify: `packages/factory/src/stages/gate.ts` (`runGate`, `runOnClosed`), `packages/factory/src/stages/deploy.ts` (`runDeployed`), `packages/factory/src/report/commit.ts` (`parseRevertIssues(message): number[]`), `packages/factory/src/stages/risk.ts`·`eval.ts`의 role 분기(revert는 implement와 같은 경로 금지 검사를 받는다)
- Test: `gate.test.ts`, `deploy.test.ts`에 추가

**Interfaces:**
- Consumes: Task 7의 meta·trailer
- Produces: `runGate`의 revert 분기 — 상태 검사(in-review) 생략, 교차 리뷰 판정 불필요, `humanActions`·필수·프리뷰·목록 밖 체크와 위험 등급은 그대로 검사. 실패·대기 결과는 `moveTo` 대신 장애 이슈에 코멘트만 남기고 `stepRecord("gate", <장애 이슈>, pr, false, reason)`을 남긴다. 이 레코드는 정체 트리거가 아니다(`moveTo`를 부르지 않으므로). T0·T1이고 모두 통과하면 병합 메시지 `Refs #<장애>\n\nFactory-Revert: #<장애>`로 병합한다. T2·T3이면 장애 이슈에 CODEOWNERS 승인 요청 코멘트.
- `runOnClosed`: revert PR이 병합 없이 닫히면 장애 이슈에 코멘트만.
- `runDeployed`: `parseRevertIssues`로 찾은 장애 이슈마다 "되돌리기 배포됨" 코멘트를 남기고 `dispatchWorkflow("factory-smoke.yml", {})`를 한 번 호출한다. 상태 전이·이슈 닫기는 하지 않는다.

- [ ] **Step 1: 실패하는 테스트**

```ts
it("merges a green T1 revert PR without a review verdict or an in-review issue", ...);   // merges[0].message에 "Factory-Revert: #66", Factory-Issue 없음
it("asks CODEOWNERS on the incident issue for a T2 revert PR", ...);
it("comments on the incident instead of moving state when a revert PR fails checks", ...); // dispatches에 factory-fix·factory-postmortem 없음 (Review Focus 2)
it("dispatches a full smoke after a revert deploys and leaves the incident open", ...);    // runDeployed: factory-smoke.yml 1회, closeIssue 없음
it("still refuses a revert PR that touches T3 paths through risk-tier", ...);
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋**

### Task 9: 복구 후 요청 재오픈과 개선 PR 위임

**Files:**
- Modify: `packages/factory/src/stages/postmortem.ts` (publish followup), `packages/factory/src/stages/improve.ts` (prepare가 포스트모템 이슈를 받음, `renderImproveBody`의 출처 문구), `.github/workflows/factory-weekly.yml` (`workflow_dispatch.inputs.issue`), `packages/factory/test/workflows.test.ts`
- Test: `postmortem-stage.test.ts`, `improve.test.ts`에 추가

**Interfaces:**
- Consumes: Task 6 followup plan, Task 3 `reopenIssue`
- Produces:
  - `POSTMORTEM_CANDIDATE_MARKER = "factory:postmortem-candidate"`, 값은 기존 `CandidateSchema`(`{ key, count, distinct, issues, prs, samples }`). `key` = `kind`(smoke·deploy·error) 또는 stall이면 정체 사유(예 `smoke_contract`). `samples` = `[사실]` 원인·방어선 문장(최대 5개). `count`/`distinct` = 1.
  - improve prepare: 이슈에 `factory:report` 라벨이 있으면 기존 동작. 라벨 `factory:postmortem`이 있으면 `readMarker(최근 봇 코멘트, POSTMORTEM_CANDIDATE_MARKER)`를 후보로 쓴다. 본문 출처 문구는 `source: { kind: "weekly" | "postmortem"; issue: number }`로 바꾼다.
- followup publish 규칙:
  - `revert.reopenRequest`이고 이 장애에서 되돌리기 PR이 병합됐으면, 원인 PR의 요청 이슈를 `reopenIssue`하고 "되돌린 이유와 다시 처리할 때 함께 바꿀 것(분석의 actions)" 코멘트를 남긴다. 자동 구현은 하지 않는다.
  - 분석의 원인·방어선에 `fact`가 하나 이상 있으면 장애 이슈에 `factory:postmortem` 라벨과 후보 표식 코멘트를 남기고 `dispatchWorkflow("factory-weekly.yml", { issue: String(장애 이슈) })`. `fact`가 없으면 기록에 "근거 부족으로 개선 제안 보류"를 쓰고 dispatch하지 않는다.
  - 같은 key로 열린 개선 PR이 있으면 dispatch하지 않는다(collect의 중복 억제와 같은 기준).

- [ ] **Step 1: 실패하는 테스트** — 되돌리기가 병합된 장애의 followup: #63 재오픈, 코멘트 1개. 사실 원인이 있는 followup: `factory-weekly.yml` dispatch `{ issue }`, 후보 key `smoke`. 추정만 있는 followup: dispatch 0, 본문에 "근거 부족". improve prepare가 `factory:postmortem` 이슈의 후보를 읽고 본문에 "포스트모템 #N의 개선 후보다". workflows 테스트: weekly의 report job이 `inputs.issue`가 있으면 건너뛴다.
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋**

### Task 10: 대시보드 장애 패널

**Files:**
- Modify: `apps/web/src/factory/data.ts` (`Run`에 `incident?` 타입), `apps/web/src/factory/insights.ts` (`incidents(runs: Run[]): IncidentRow[]`), `apps/web/src/factory/view.ts` (`incidentsPanel`을 overview 바로 뒤에 배치)
- Test: `apps/web/src/factory/insights.test.ts`, `view.test.ts`

**Interfaces:**
- Produces: `interface IncidentRow { key: string; issue: number; kind: string; detectedAt: string; recoveredAt: string | null; mttrMinutes: number | null; causePr: number | null; reverted: boolean; classification: string | null }`. 같은 key의 레코드를 합치고 followup의 `recoveredAt`을 우선한다. 최근 감지 순 정렬.
- 패널: 장애마다 이슈 링크, 분류, 감지·복구 시각, 복구 시간(분), 원인 PR 링크, 되돌림 여부. 레코드가 없으면 "기록된 장애 없음". `roleStats`·`recentTable`에서 `postmortem` 역할 이름을 "포스트모템"으로 표시한다.

- [ ] **Step 1: 실패하는 테스트** — 레코드 2개(initial, followup)가 한 행으로 합쳐지고 `mttrMinutes` 계산, 복구 전 장애는 `mttrMinutes: null`, 빈 입력 문구.
- [ ] **Step 2-4: 실패 확인 → 구현 → `pnpm --filter web test` 통과**
- [ ] **Step 5: 커밋**

### Task 11: 문서, 변경 기록, #66 재생

**Files:**
- Modify: `docs/superpowers/specs/2026-10-21-postmortem-policy-design.md`(위 "spec과 다르게 정한 것" 4건 반영), `docs/operations.md`(포스트모템 운영 절: 트리거, 예산 조정, 재생 명령, T1 스모크 깨기 데모 절차), `CHANGELOG.md`(미출시 → 추가)
- Test: `pnpm lint`(마크다운 검사)

- [ ] **Step 1: 문서 수정**
- [ ] **Step 2: `pnpm format && pnpm typecheck && pnpm lint && pnpm test` 통과 확인**
- [ ] **Step 3: 커밋 후 PR**
- [ ] **Step 4 (병합 후, 사람 승인 필요): #66 재생** — `gh workflow run factory-postmortem.yml -f issue=66 -f kind=smoke -f event=detected -f dry_run=true -f excerpt="<스모크 run 38480497423의 Playwright 실패 끝부분>"`. 기대: 재생 이슈에 #65가 원인 PR로, 되돌리기 판정 `revert: true`(dry-run이라 PR 없음), 방어선에 `e2e-preview` 비필수와 실패 원문 부재가 나온다. 결과를 spec 1.2와 비교해 PR 코멘트로 남긴다.
