import type { Run } from "./data";
import { recentMonths } from "./data";
import {
  improvementStories,
  issueStories,
  incidents,
  roleStats,
  type Improvement,
  type IssueStory,
} from "./insights";
import { activeWeeks, categoryTrend, lastWeeks, recentRuns } from "./metrics";

const REPO = "https://github.com/roboco-io/the-software-factory-demo";
const APP = "https://roboco.io/the-software-factory-demo/";
const ROLES: Record<string, string> = {
  triage: "요청 정리",
  command: "실행 승인",
  implement: "구현",
  review: "검토",
  fix: "수정",
  gate: "병합 판단",
  deploy: "배포",
  intake: "의견 수집",
  smoke: "서비스 점검",
  improve: "자가 개선",
  postmortem: "포스트모템",
};
const CATEGORIES: Record<string, string> = {
  "error-format": "오류 응답 형식",
  "missing-test": "테스트 누락",
  security: "보안",
  other: "기타 지적",
};
const HOLDS: Record<string, string> = {
  risk_t2: "사람 승인 필요(T2)",
  risk_t3: "사람 승인 필요(T3)",
  permission_denied: "실행 권한 없음",
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(label: string, href: string, className?: string): HTMLAnchorElement {
  const a = el("a", label, className);
  a.href = href;
  return a;
}

const roleName = (role: string) => ROLES[role] ?? role;
const dateFormat = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
function time(ts: string): HTMLTimeElement {
  const d = new Date(ts);
  const valid = Number.isFinite(d.getTime());
  const node = el("time", valid ? dateFormat.format(d) : "시각 미상");
  if (valid) node.dateTime = ts;
  return node;
}
function categoryName(key: string): string {
  if (key.startsWith("review:")) return CATEGORIES[key.slice(7)] ?? `검토 지적: ${key.slice(7)}`;
  if (key === "smoke") return "서비스 점검 실패";
  if (key === "revert") return "변경 되돌림";
  return key.startsWith("run:") ? `실행 실패: ${key.slice(4)}` : key;
}
function result(r: Run): { text: string; className: string } {
  if (r.ok) return { text: "완료", className: "ok" };
  if (HOLDS[r.failureReason ?? ""])
    return { text: HOLDS[r.failureReason ?? ""]!, className: "hold" };
  return { text: "실행 실패", className: "fail" };
}
function panel(title: string, id: string, description?: string): HTMLElement {
  const s = el("section", undefined, "panel");
  s.setAttribute("aria-labelledby", id);
  const heading = el("h2", title);
  heading.id = id;
  s.append(heading);
  if (description) s.append(el("p", description, "section-intro"));
  return s;
}
function table(
  headers: string[],
  label: string,
): { wrapper: HTMLDivElement; table: HTMLTableElement; body: HTMLTableSectionElement } {
  const wrapper = el("div", undefined, "table-scroll");
  const t = el("table");
  t.setAttribute("aria-label", label);
  const thead = el("thead");
  const tr = el("tr");
  for (const name of headers) {
    const h = el("th", name);
    h.scope = "col";
    tr.append(h);
  }
  thead.append(tr);
  const body = el("tbody");
  t.append(thead, body);
  wrapper.append(t);
  return { wrapper, table: t, body };
}

export function header(onRefresh?: () => void): HTMLElement {
  const h = el("header", undefined, "page-header");
  const top = el("div", undefined, "masthead");
  top.append(link("ROBOCO · 소프트웨어 팩토리", `${REPO}#readme`, "brand"));
  const nav = el("nav");
  nav.setAttribute("aria-label", "체험과 안내");
  nav.append(
    link("서비스 체험", APP),
    link("프로젝트 리포지토리", REPO),
    link("처음 오셨나요?", `${REPO}#브라우저에서-체험하기`),
  );
  top.append(nav);
  h.append(
    top,
    el("h1", "소프트웨어 팩토리 대시보드"),
    el(
      "p",
      "요청이 서비스로 바뀌고, 반복된 실패가 다음 규칙으로 바뀌는 과정을 실제 기록으로 살펴보세요.",
      "lead",
    ),
  );
  if (onRefresh) {
    const b = el("button", "기록 새로고침", "button secondary");
    b.type = "button";
    b.addEventListener("click", onRefresh);
    h.append(b);
  }
  return h;
}

function processGuide(): HTMLElement {
  const section = el("section", undefined, "process-guide");
  section.setAttribute("aria-label", "요청 처리 흐름");
  const steps = el("ol", undefined, "process-flow");
  for (const [name, note] of [
    ["요청 정리", "원하는 변화와 완료 기준"],
    ["실행 승인", "사람이 시작을 결정"],
    ["AI 구현", "코드와 테스트 작성"],
    ["검토·검사", "다른 AI와 자동 검사"],
    ["병합 판단", "위험에 따라 사람 승인"],
    ["배포", "실제 서비스에 반영"],
  ]) {
    const li = el("li");
    li.append(el("strong", name), el("span", note));
    steps.append(li);
  }
  section.append(steps);
  return section;
}

function renderStory(body: HTMLElement, story: IssueStory): void {
  body.replaceChildren();
  const last = story.steps.at(-1)!;
  const status = story.deployed
    ? "배포 완료 기록"
    : !last.ok && ["risk_t2", "risk_t3"].includes(last.failureReason ?? "")
      ? "사람 승인 대기 기록"
      : !last.ok
        ? "실패 기록 · 확인 필요"
        : "처리 단계 기록";
  const top = el("div", undefined, "story-top");
  top.append(
    link(`#${story.issue} 요청 보기`, `${REPO}/issues/${story.issue}`, "story-link"),
    el(
      "span",
      status,
      `badge ${story.deployed ? "ok" : last.ok ? "neutral" : HOLDS[last.failureReason ?? ""] ? "hold" : "fail"}`,
    ),
  );
  body.append(top);
  const list = el("ol", undefined, "timeline");
  const shown = story.steps.length > 8 ? [story.steps[0]!, ...story.steps.slice(-7)] : story.steps;
  for (const [i, step] of shown.entries()) {
    if (i === 1 && story.steps.length > 8)
      list.append(
        el(
          "li",
          `중간 ${story.steps.length - 8}개 기록은 요청에서 확인할 수 있습니다.`,
          "timeline-gap",
        ),
      );
    const row = el("li");
    const r = result(step);
    const title = el("div", undefined, "timeline-title");
    title.append(el("strong", roleName(step.role)), el("span", r.text, `badge ${r.className}`));
    const meta = el("div", undefined, "timeline-meta");
    meta.append(time(step.ts));
    if (step.engine) meta.append(el("span", `AI: ${step.engine} · ${step.model ?? "모델 미기록"}`));
    row.append(title, meta);
    list.append(row);
  }
  body.append(list);
  const actions = el("div", undefined, "actions");
  if (story.pr)
    actions.append(link("변경·검증 보기", `${REPO}/pull/${story.pr}`, "button secondary"));
  actions.append(link("요청에서 다음 행동 확인", `${REPO}/issues/${story.issue}`, "text-link"));
  body.append(
    actions,
    el(
      "p",
      "기록이 있는 단계만 표시합니다. 현재 상태는 GitHub 요청에서 확인하세요. 사람 승인 대기와 실행 실패는 구분합니다.",
      "note",
    ),
  );
}

function storiesPanel(runs: Run[]): HTMLElement {
  const s = panel(
    "요청 하나의 처리 과정",
    "request-heading",
    "어떤 단계가 실행됐는지, 어디에서 사람의 판단이 필요했는지 확인합니다.",
  );
  const stories = issueStories(runs, 12);
  if (!stories.length) {
    s.append(
      el("p", "아직 처리 과정이 기록되지 않았습니다.", "empty"),
      link("처리된 요청 둘러보기", `${REPO}/issues`, "text-link"),
    );
    return s;
  }
  const control = el("div", undefined, "story-picker");
  const label = el("label", "살펴볼 요청");
  label.htmlFor = "story-issue";
  const select = el("select");
  select.id = label.htmlFor;
  for (const story of stories) {
    const option = el(
      "option",
      `#${story.issue} · ${story.deployed ? "배포 완료 기록" : "처리 기록"}`,
    );
    option.value = String(story.issue);
    select.append(option);
  }
  const chosen =
    stories.find(
      (story) =>
        story.deployed &&
        story.steps.length <= 8 &&
        ["triage", "command", "implement", "review", "gate", "deploy"].every((role) =>
          story.steps.some((step) => step.role === role && step.ok),
        ),
    ) ??
    stories.find((story) => story.deployed) ??
    stories[0]!;
  select.value = String(chosen.issue);
  control.append(label, select);
  const body = el("div", undefined, "story-body");
  renderStory(body, chosen);
  select.addEventListener("change", () => {
    const story = stories.find((item) => String(item.issue) === select.value);
    if (story) renderStory(body, story);
  });
  s.append(control, body);
  return s;
}

function takePart(): HTMLElement {
  const s = panel("직접 체험해 보세요", "participate-heading");
  s.classList.add("participate");
  s.append(el("p", "서비스를 사용하고 의견을 보내거나, 원하는 기능을 글로 요청해 보세요."));
  s.append(
    link("서비스 사용하기", APP, "button primary"),
    link("기능 요청 작성", `${REPO}/issues/new?template=feature.yml`, "button secondary"),
  );
  s.append(
    el(
      "p",
      "방문자는 서비스 아래의 피드백 버튼으로 의견을 보낼 수 있습니다. 팩토리 실행은 저장소 쓰기 권한자가 이슈 댓글에 @factory go를 입력해 승인합니다.",
      "note",
    ),
  );
  const terms = el("dl", undefined, "terms");
  for (const [word, definition] of [
    ["요청(이슈)", "원하는 변화와 완료 기준을 적는 작업서"],
    ["변경 제안(PR)", "코드 변경과 검증 결과를 검토하는 곳"],
    ["병합", "검증된 변경을 기준 버전에 합치는 일"],
  ])
    terms.append(el("dt", word), el("dd", definition));
  s.append(terms);
  return s;
}

function improvementsPanel(runs: Run[], improvements: Improvement[], now: Date): HTMLElement {
  const s = panel(
    "실패가 규칙으로 바뀌는 과정",
    "improvement-heading",
    "자가 개선은 AI 모델의 재학습이 아니라 작업 지침과 자동 검사 규칙의 개선입니다.",
  );
  const flow = el(
    "p",
    "반복 실패 기록 → 규칙 변경 제안 → 자동 검증 → 사람 검토·병합 → 이후 관찰",
    "learning-flow",
  );
  s.append(flow);
  const stories = improvementStories(runs, improvements, now);
  if (!stories.length)
    s.append(
      el("p", "아직 병합된 개선 규칙이 기록되지 않았습니다.", "empty"),
      link("자가 개선 실험 안내", `${REPO}#자가-개선-poc-실패를-다음-규칙으로`, "text-link"),
    );
  for (const story of stories) {
    const article = el("article", undefined, "improvement-card");
    const top = el("div", undefined, "improvement-top");
    top.append(
      el("h3", categoryName(story.key)),
      el(
        "span",
        !story.supported
          ? "별도 관찰 자료 필요"
          : story.before.coverage !== "complete" || story.after.coverage !== "complete"
            ? "기록 범위 부족 · 효과 판단 보류"
            : story.enoughSamples
              ? "관찰 중 · 인과 효과 미확인"
              : "표본 부족 · 효과 판단 보류",
        "badge hold",
      ),
    );
    article.append(top);
    const links = el("div", undefined, "evidence-links");
    links.append(
      link(`개선 PR #${story.pr}`, `${REPO}/pull/${story.pr}`),
      link("규칙 검증 결과 보기", `${REPO}/pull/${story.pr}/checks`),
    );
    const merged = el("p", "병합 기록: ", "note");
    merged.append(time(story.mergedAt));
    article.append(links, merged);
    if (!story.supported)
      article.append(
        el(
          "p",
          "이 범주는 실행 기록만으로 집계할 수 없습니다. 개선 PR에서 별도의 관찰 근거를 확인하세요.",
          "note",
        ),
      );
    const comparison = el("div", undefined, "evidence-comparison");
    for (const [label, p] of [
      ["병합 전 관찰", story.before],
      ["병합 후 관찰", story.after],
    ] as const) {
      const box = el("div");
      box.append(el("h4", label));
      if (p.coverage === "unavailable") {
        box.append(
          el("strong", "관찰 데이터 없음"),
          el(
            "p",
            story.supported
              ? "이 기간은 불러온 기록 범위 밖입니다."
              : "이 범주에 필요한 관찰 자료를 불러오지 않습니다.",
            "note",
          ),
        );
      } else {
        if (p.coverage === "partial") box.append(el("span", "일부 기간만 집계", "badge hold"));
        box.append(
          el("strong", `${p.events}건의 관련 지적·실패`),
          el(
            "p",
            `해당 문제 발생 ${p.affectedIssues}개 요청 / 관찰 대상 ${p.issues}개 요청`,
            "note",
          ),
        );
        box.append(el("p", `관찰 ${p.days!.toFixed(1)}일 · 최대 28일`, "note"));
        const bounds = el("p", undefined, "note evidence-period");
        bounds.append(time(p.startAt!), " – ", time(p.endAt!));
        box.append(bounds);
      }
      comparison.append(box);
    }
    article.append(
      comparison,
      el(
        "p",
        "불러온 기록 범위 안에서 집계합니다. 관찰 기간과 작업량이 다르므로, 0건이거나 규칙이 병합됐다는 사실만으로 개선 효과를 단정하지 않습니다.",
        "note",
      ),
    );
    s.append(article);
  }
  return s;
}

function incidentsPanel(runs: Run[]): HTMLElement {
  const s = panel(
    "장애 기록",
    "incidents-heading",
    "프로덕션 점검이나 배포 실패로 감지된 장애와 복구 결과입니다.",
  );
  const rows = incidents(runs);
  if (!rows.length) {
    s.append(el("p", "기록된 장애 없음", "empty"));
    return s;
  }
  const { wrapper, body } = table(
    ["요청", "분류", "감지", "복구", "복구 시간", "원인 PR", "되돌림"],
    "장애 기록",
  );
  for (const r of rows) {
    const row = el("tr");
    const issue = el("td");
    issue.append(link(`#${r.issue}`, `${REPO}/issues/${r.issue}`));
    const cause = el("td");
    if (r.causePr) cause.append(link(`#${r.causePr}`, `${REPO}/pull/${r.causePr}`));
    else cause.textContent = "미확인";
    const detected = el("td");
    detected.append(time(r.detectedAt));
    const recovered = el("td");
    if (r.recoveredAt) recovered.append(time(r.recoveredAt));
    else recovered.textContent = "복구 전";
    row.append(
      issue,
      el("td", r.classification ?? "분류 전"),
      detected,
      recovered,
      el("td", r.mttrMinutes === null ? "-" : `${r.mttrMinutes}분`),
      cause,
      el("td", r.reverted ? "되돌림" : "되돌리지 않음"),
    );
    body.append(row);
  }
  s.append(wrapper);
  return s;
}
function statCards(runs: Run[], improvements: Improvement[]): HTMLElement {
  const stats = roleStats(runs);
  const recorded = stats.reduce((n, row) => n + row.costRuns, 0);
  const total = stats.reduce((n, row) => n + row.n, 0);
  const cost = stats.reduce((n, row) => n + row.costUsd, 0);
  const deployed = issueStories(runs, Number.MAX_SAFE_INTEGER).filter((s) => s.deployed).length;
  const box = el("div", undefined, "cards");
  const items = [
    {
      label: "배포 완료 기록",
      value: String(deployed),
      note: "기간 내 요청별 마지막 배포 결과 기준",
    },
    {
      label: "기록된 AI 비용",
      value: recorded ? `$${cost.toFixed(2)}` : "미보고",
      note: `비용 기록 ${recorded}/${total}회${recorded < total ? " · 부분 합계" : " · 보고된 실행 기준"}`,
    },
    {
      label: "병합된 개선 규칙",
      value: String(improvements.length),
      note: "누적 병합 기록 · 효과 검증과 구분",
    },
  ];
  for (const item of items) {
    const card = el("div", undefined, "card");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", item.label);
    card.append(
      el("div", item.label, "card-label"),
      el("div", item.value, "card-value"),
      el("p", item.note, "card-note"),
    );
    box.append(card);
  }
  return box;
}

function roleTable(runs: Run[]): HTMLElement {
  const s = panel(
    "역할·도구·모델별 실행 결과",
    "roles-heading",
    "같은 도구라도 사용 모델과 맡은 작업이 다릅니다. 도구·모델·역할 조합별로 집계하며, 모델명이 없는 기록은 추정하지 않습니다.",
  );
  const rows = roleStats(runs);
  const { wrapper, body } = table(
    ["역할", "에이전트 도구", "사용 모델", "완료 / 실행", "보고된 비용"],
    "역할별 AI 실행 결과",
  );
  for (const r of rows) {
    const row = el("tr");
    row.append(
      el("td", roleName(r.role)),
      el("td", r.engine),
      el("td", r.model ?? "모델 미기록", "model-name"),
      el("td", `${r.ok}/${r.n}회`),
      el("td", r.costRuns ? `$${r.costUsd.toFixed(2)} · ${r.costRuns}/${r.n}회 보고` : "미보고"),
    );
    body.append(row);
  }
  s.append(rows.length ? wrapper : el("p", "AI 실행 결과가 아직 기록되지 않았습니다.", "empty"));
  return s;
}

function trendTable(runs: Run[], now: Date): HTMLElement {
  const weeks = activeWeeks(runs, lastWeeks(now, 8));
  const trend = categoryTrend(runs, weeks);
  const s = panel(
    "반복된 지적과 실패",
    "trend-heading",
    "최근 8주 중 기록이 있는 주의 상위 3개 범주입니다. 검토 지적의 반복 횟수를 포함하며, 요청 수와 다릅니다.",
  );
  if (!trend.length) {
    s.append(el("p", "해당 기간에 지적·실패 기록이 없습니다.", "empty"));
    return s;
  }
  const { wrapper, body } = table(
    ["범주", ...weeks.map((w) => w.replace("-W", "년 ") + "주")],
    "주별 지적과 실패 건수",
  );
  for (const t of trend) {
    const row = el("tr");
    row.append(el("th", categoryName(t.key)), ...t.counts.map((v) => el("td", `${v}건`)));
    body.append(row);
  }
  s.append(wrapper);
  return s;
}

function recentTable(runs: Run[]): HTMLElement {
  const s = panel(
    "최근 실행 기록",
    "recent-heading",
    "한국시간으로 표시합니다. 과거 단계의 성공·실패 기록이며, 요청의 현재 상태를 뜻하지 않습니다.",
  );
  const { wrapper, body } = table(
    ["시각", "요청", "단계", "에이전트 도구", "사용 모델", "결과"],
    "최근 실행 기록",
  );
  for (const r of recentRuns(runs, 12)) {
    const row = el("tr");
    const stamp = el("td");
    stamp.append(time(r.ts));
    const issue = el("td");
    if (r.issue > 0) issue.append(link(`#${r.issue}`, `${REPO}/issues/${r.issue}`));
    else issue.textContent = "—";
    const res = result(r);
    row.append(
      stamp,
      issue,
      el("td", roleName(r.role)),
      el("td", r.engine ?? "—"),
      el("td", r.engine ? (r.model ?? "모델 미기록") : "—", "model-name"),
      el("td", res.text, res.className),
    );
    body.append(row);
  }
  s.append(runs.length ? wrapper : el("p", "아직 실행 기록이 없습니다.", "empty"));
  return s;
}

export function renderDashboard(
  root: HTMLElement,
  rawRuns: Run[],
  improvements: Improvement[],
  now: Date,
  onRefresh: () => void,
): void {
  const runs = rawRuns
    .filter((r) => Number.isFinite(Date.parse(r.ts)) && Date.parse(r.ts) <= now.getTime())
    .map((r) => ({
      ...r,
      engine: typeof r.engine === "string" && r.engine.trim() ? r.engine : null,
      model: typeof r.model === "string" && r.model.trim() ? r.model : null,
      findings: Array.isArray(r.findings)
        ? r.findings.filter((f) => f && typeof f.category === "string")
        : [],
    }))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  improvements = improvements.filter(
    (i) =>
      Number.isInteger(i.pr) &&
      i.pr > 0 &&
      Number.isFinite(Date.parse(i.mergedAt)) &&
      Date.parse(i.mergedAt) <= now.getTime(),
  );
  root.replaceChildren(header(onRefresh));
  const meta = el("div", undefined, "data-status");
  const latest = runs.at(-1);
  const latestText = el("p", latest ? "최신 실행 기록: " : "최신 실행 기록: 없음");
  if (latest) latestText.append(time(latest.ts));
  const months = recentMonths(now, 3);
  meta.append(
    latestText,
    el(
      "p",
      `데이터 범위: ${months[0]} ~ ${months.at(-1)} (UTC 월 기준) · 표시 시각: 한국시간`,
      "note",
    ),
  );
  const fetched = el("p", "불러온 시각: ", "note");
  fetched.append(time(now.toISOString()));
  meta.append(
    fetched,
    el(
      "p",
      "실시간 상태 화면이 아닙니다. GitHub 캐시로 기록 반영이 최대 5분 늦을 수 있습니다.",
      "note",
    ),
  );
  root.append(meta, processGuide());
  const overview = el("div", undefined, "overview");
  overview.append(storiesPanel(runs), improvementsPanel(runs, improvements, now));
  root.append(overview, incidentsPanel(runs), takePart(), statCards(runs, improvements));
  const details = el("details", undefined, "operator-details");
  details.append(
    el("summary", "운영 기록 자세히 보기"),
    roleTable(runs),
    trendTable(runs, now),
    recentTable(runs),
  );
  root.append(details);
  const footer = el("footer", undefined, "page-footer");
  footer.append(
    link("원본 실행 기록", `${REPO}/tree/factory-data`),
    link("프로젝트와 연구 배경", `${REPO}#프로젝트의-출발점-로보코의-소프트웨어-팩토리-연구`),
  );
  root.append(footer);
}
