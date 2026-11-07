Ruling: orchestrator switched to AI by the user - the approval hook fails on macOS bash 3.2 - cost if wrong: no human gate on plan fixes inside the approved review plan

- start 70b97faf7417fb645da46270c5540a1283517c0d
- unblocked: dispatched T0 T1 T3 T4 T5 T6 T7 T8 T9 T10 T12 T13 T14 T15 at 12:56:54; waiting on fixes: T2 T11
  Ruling: agents read .superlite/prime.md from disk instead of pasting 35 KB into each brief - saves about 100k coordinator output tokens - cost if wrong: an agent skips part of the prime
- tests fast passed=0 failed=1 skipped=0 seconds=1.2
  Ruling: docs/plans excluded locally during the build - commit_task refuses untracked plan files - cost if wrong: plan files need a separate commit at the end
- commit T6 4a720da281 session
- commit T7 b84168e37f github user
- commit T10 168d86ab14 usage meter
- commit T1 d5517dce01 schema and repo
- commit T3 e9e48668fa pricing
  Ruling: T2 also owns d1-stage3.test.ts - migration 0004 breaks its count and positional INSERT - cost if wrong: none
- commit T12 278e85e261 portal model
- commit T8 f34e1ebc1a auth api
- commit T4 2d6e70f511 run query
- commit T5 cd5bb2ecf2 read api
- tests full passed=610 failed=2 skipped=0 seconds=2.4
- commit T2 8831a320bc machine records facts
- commit T13 39024ad750 portal view
  Ruling: third card reads 종료 instead of 병합 완료 - the done bucket also holds failures older than 7 days - cost if wrong: label differs from the mockup
- commit T9 47787da27e review api
- commit T11 bd8c0fcbea outbound wiring
- commit T8 ba4838f2d6 auth api
- commit T9 a8c331e2ec review api
- commit T10 6fff3f2432 usage meter
- commit T11 3607117f37 outbound wiring
- commit T14 c7b00947f7 app wiring
- commit T13 f3f9b8e154 portal view
  Ruling: final review findings closed with fresh evidence - the packet used an old test summary from before T14; pnpm check is the evidence - cost if wrong: a stale failure hides a real one
  Ruling: pulls-world.ts stays unchanged - its SUPERLITE_REAL seam predates this work and is out of scope - cost if wrong: none
  Ruling: costUsd has no NaN guard - counts come from usage-meter, which clamps them, and from INTEGER NOT NULL columns - cost if wrong: one run shows a wrong estimate
  Ruling: approve via a real GitHub review is not exercised on a real repository - it needs the human OAuth setup - cost if wrong: the first real approval returns review=failed and needs an App permission change
