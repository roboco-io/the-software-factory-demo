import {
  ApiError,
  type Api,
  type EventItem,
  type Me,
  type Project,
  type RunCost,
  type TokenUsage,
  type RunDetail,
  type RunSummary,
} from "./api";
import {
  formatTime,
  githubLink,
  h,
  link,
  projectPath,
  runPath,
  type Child,
} from "./dom";
import {
  EVENT_KIND_LABELS,
  REASON_LABELS,
  describeNextStep,
  describeOutcome,
  stateLabel,
  type Tone,
} from "./labels";
import {
  costUsdText,
  isGithubAuthorize,
  costLine,
  moneyText,
  tokenCount,
  shortSha,
} from "./console-labels";
import {
  filterText,
  matchesFilter,
  type RunFilter,
  sameFilter,
} from "./run-filter";
import {
  durationText,
  stageCells,
  stageCounts,
  STAGES,
  type StageCell,
  type StageStatus,
} from "./flow";
import { createReplay } from "./replay";

/** A rendered screen. `cleanup` stops anything that keeps running after the user leaves. */
export interface View {
  title: string;
  el: HTMLElement;
  cleanup?: () => void;
}

export interface ViewContext {
  api: Api;
  me: Me;
  /** Loads the screen again, for example after a stop. */
  reload(): void;
  /** Shows a notice above the screen. It stays while the screen reloads. */
  notify(kind: "alert" | "status", text: string): void;
  /** Sends the browser to another address, for example GitHub's authorize page. */
  navigate(url: string): void;
}

const TERMINAL = ["merged", "needs_human", "failed"];
const REPLAY_INTERVAL_MS = 1200;

export function messageBox(kind: "alert" | "status", ...children: Child[]) {
  return h("div", { class: `message ${kind}`, role: kind }, ...children);
}

export function notFoundView(): View {
  return {
    title: "찾을 수 없음",
    el: h(
      "section",
      null,
      h("h1", null, "찾을 수 없습니다"),
      h("p", null, "주소가 잘못되었거나 공개된 기록이 아닙니다."),
      h("p", null, link("/", "홈으로")),
    ),
  };
}

function section(title: string, ...children: Child[]) {
  return h("section", { class: "card" }, h("h2", null, title), ...children);
}

export async function homeView(ctx: ViewContext): Promise<View> {
  const projects = await projectList(ctx);
  const steps: [string, string][] = [
    [
      "이슈 접수",
      "운영자가 허용된 저장소의 이슈에 factory:go 라벨을 붙이면 실행이 시작됩니다. 한 이슈에는 한 번에 하나의 실행만 있습니다.",
    ],
    [
      "구현",
      "격리된 샌드박스에서 AI 에이전트가 이슈를 읽고 코드를 고친 뒤 풀 리퀘스트(PR)를 엽니다. 샌드박스에는 GitHub 토큰과 LLM 키가 없습니다.",
    ],
    [
      "교차 리뷰",
      "구현과 다른 엔진이 새 샌드박스에서 변경을 읽기 전용으로 리뷰합니다. 자기가 쓴 코드를 자기가 승인하지 않게 하기 위해서입니다.",
    ],
    [
      "프로그램이 병합 판정",
      "병합할지는 AI가 아니라 프로그램이 정합니다. 위험 등급, 필수 체크, 리뷰 결과를 확인하고, 사람은 정책이 요구하는 변경에서만 승인합니다.",
    ],
  ];
  return {
    title: "프로젝트",
    el: h(
      "section",
      null,
      h("h1", null, "Software Factory"),
      h(
        "p",
        { class: "lead" },
        "이슈 하나가 AI 에이전트의 구현과 리뷰를 거쳐 병합되기까지의 과정을 그대로 관찰하는 포털입니다. 각 단계는 고정된 사유 코드와 함께 기록되고, 이 화면은 그 기록을 한국어로 풀어 보여 줍니다.",
      ),
      section("프로젝트", projects),
      section(
        "이슈 하나는 이렇게 흐릅니다",
        h(
          "ol",
          { class: "flow" },
          ...steps.map(([title, text]) =>
            h("li", null, h("strong", null, title), h("span", null, text)),
          ),
        ),
      ),
      section(
        "누가 무엇을 할 수 있나",
        h(
          "ul",
          { class: "plain" },
          h(
            "li",
            null,
            "누구나(익명): 이 소개와 공개된 실행 기록의 재생을 볼 수 있습니다.",
          ),
          h(
            "li",
            null,
            "GitHub로 로그인한 사람(옵저버): 공개 프로젝트를 열람합니다. 로그인은 신원 확인에만 쓰며 GitHub 토큰을 저장하지 않습니다.",
          ),
          h(
            "li",
            null,
            "운영자: 위에 더해 진행 중인 실행을 중지할 수 있습니다.",
          ),
        ),
        h(
          "p",
          { class: "note" },
          "이 화면에는 에이전트의 원문 로그나 비밀 값이 나타나지 않습니다. 기록에는 고정된 코드만 남기 때문입니다.",
        ),
      ),
    ),
  };
}

const COUNT_LABELS: [keyof RunSummaryCounts, string][] = [
  ["active", "진행 중"],
  ["merged", "병합됨"],
  ["needs_human", "사람 확인 필요"],
  ["failed", "실패"],
];
type RunSummaryCounts = {
  active: number;
  merged: number;
  needs_human: number;
  failed: number;
};

/** Project cards with run counts by outcome. Shown on the home screen. */
async function projectList(ctx: ViewContext) {
  const { projects } = await ctx.api.projects();
  return projects.length === 0
    ? messageBox("status", "등록된 프로젝트가 없습니다.")
    : h(
        "ul",
        { class: "cards" },
        ...projects.map((p) =>
          h(
            "li",
            { class: "card" },
            h("h2", null, link(projectPath(p.repo), p.repo)),
            p.description ? h("p", { class: "desc" }, p.description) : null,
            h(
              "dl",
              { class: "counts" },
              ...COUNT_LABELS.flatMap(([key, label]) => [
                h("dt", null, label),
                h("dd", null, String(p.counts[key])),
              ]),
            ),
          ),
        ),
      );
}

const STATUS_TEXT: Record<StageStatus, string> = {
  done: "완료",
  current: "진행 중",
  stopped: "멈춤",
  skipped: "거치지 않음",
  todo: "도달 전",
};
const STATUS_MARK: Record<StageStatus, string> = {
  done: "✓",
  current: "●",
  stopped: "!",
  skipped: "–",
  todo: "",
};

/** The seven stages in order, with where the run stands. Status is in text and a mark, not only in color. */
function rail(cells: StageCell[], tone: Tone) {
  return h(
    "ol",
    { class: `rail tone-${tone}`, "aria-label": "진행 단계" },
    ...cells.map((cell) => {
      const time = cell.ms === null ? null : durationText(cell.ms);
      const name = `${cell.label}: ${STATUS_TEXT[cell.status]}${time === null ? "" : `, ${time}`}`;
      return h(
        "li",
        { class: cell.status, "aria-label": name, title: name },
        h(
          "span",
          { class: "rail-mark", "aria-hidden": "true" },
          STATUS_MARK[cell.status],
        ),
        h("span", { class: "rail-label", "aria-hidden": "true" }, cell.label),
        h("small", { "aria-hidden": "true" }, time ?? ""),
      );
    }),
  );
}

type PickFilter = (filter: RunFilter) => void;

/** A count that narrows the list when clicked, and widens it again on a second click. */
function filterButton(
  text: string,
  filter: RunFilter,
  current: RunFilter,
  pick: PickFilter,
  attrs: Record<string, string> = {},
) {
  const el = h(
    "button",
    {
      type: "button",
      "aria-pressed": String(sameFilter(filter, current)),
      ...attrs,
    },
    text,
  );
  el.addEventListener("click", () => pick(filter));
  return el;
}

function boardHead(
  runs: readonly RunSummary[],
  now: number,
  current: RunFilter,
  pick: PickFilter,
) {
  const counts = stageCounts(runs, now);
  return h(
    "div",
    { class: "board-head" },
    h("div", { class: "board-work" }, "실행 (최근 시작 순)"),
    h(
      "div",
      { class: "board-stages" },
      ...STAGES.map((stage, i) => {
        const { active, stopped } = counts[i]!;
        return h(
          "div",
          { class: "stage" },
          h("strong", null, stage.label),
          active > 0
            ? filterButton(
                `진행 ${active}`,
                { kind: "stage", stage: i, status: "current" },
                current,
                pick,
                {
                  class: "stage-count active",
                  title: `${stage.label} 단계에서 진행 중인 실행만 보기`,
                },
              )
            : null,
          stopped > 0
            ? filterButton(
                `멈춤 ${stopped}`,
                { kind: "stage", stage: i, status: "stopped" },
                current,
                pick,
                {
                  class: "stage-count stopped",
                  title: `${stage.label} 단계에서 멈춘 실행만 보기`,
                },
              )
            : null,
        );
      }),
    ),
  );
}

function runRow(run: RunSummary, now: number) {
  const outcome = describeOutcome(run.state, run.reasonCode);
  const stateTitle = stateLabel(run.state).title;
  const issue = githubLink(
    run.repo,
    "issues",
    run.issueNumber,
    `이슈 #${run.issueNumber}`,
  );
  const started = formatTime(run.createdAt);
  const end = TERMINAL.includes(run.state) ? run.updatedAt : now;
  return h(
    "li",
    { class: `card run-row tone-${outcome.tone}` },
    h(
      "div",
      { class: "run-info" },
      h(
        "div",
        { class: "run-name" },
        link(runPath(run.id), run.title ?? `실행 ${run.id}`),
      ),
      h(
        "div",
        { class: "run-meta" },
        issue ?? `이슈 #${run.issueNumber}`,
        run.tier === null ? null : h("span", { class: "tier" }, run.tier),
      ),
      h(
        "div",
        { class: "status" },
        h("strong", null, outcome.title),
        ...(stateTitle === outcome.title
          ? []
          : [" ", h("span", { class: "muted" }, stateTitle)]),
      ),
      h(
        "div",
        { class: "run-time" },
        "시작 ",
        h("time", { datetime: started.iso }, started.text),
        ` · 총 ${durationText(Math.max(0, end - run.createdAt))}`,
      ),
      h("div", { class: "run-cost" }, costLine(run.cost)),
    ),
    rail(stageCells(run, now), outcome.tone),
  );
}

/**
 * The four cards above a project's runs. The numbers come from the whole project, not from the
 * loaded page. Three of them filter the list; cost has no matching set of runs, so it is not a button.
 */
function summaryCards(project: Project, current: RunFilter, pick: PickFilter) {
  const body = (label: string, value: string) => [
    h("span", { class: "stat-label" }, label),
    h("strong", { class: "stat-value" }, value),
  ];
  const card = (label: string, value: string, filter: RunFilter, cls = "") => {
    const el = h(
      "button",
      {
        type: "button",
        class: `card stat ${cls}`.trim(),
        "aria-pressed": String(sameFilter(filter, current)),
        title: `${filterText(filter)}만 보기`,
      },
      ...body(label, value),
    );
    el.addEventListener("click", () => pick(filter));
    return el;
  };
  return h(
    "div",
    { class: "summary" },
    card(
      "주의 필요",
      String(project.attention),
      { kind: "attention" },
      "stat-attention",
    ),
    card("진행 중", String(project.counts.active), { kind: "active" }),
    card("병합됨", String(project.counts.merged), { kind: "merged" }),
    h(
      "div",
      { class: "card stat" },
      ...body("비용", costUsdText(project.costUsd)),
    ),
  );
}

export async function projectView(
  ctx: ViewContext,
  repo: string,
): Promise<View> {
  // The summary is extra: if it cannot be read the run list is still shown.
  const [firstPage, project] = await Promise.all([
    ctx.api.runs(repo),
    ctx.api.projects().then(
      ({ projects }) => projects.find((p) => p.repo === repo) ?? null,
      () => null,
    ),
  ]);
  let page = firstPage;
  // The board counts and the filter work on the runs loaded so far; "더 보기" adds to them.
  const loaded: RunSummary[] = [...page.runs];
  const ALL: RunFilter = { kind: "all" };
  let current: RunFilter = ALL;
  const summary = h("div");
  const head = h("div");
  const list = h("ul", { class: "board-rows" });
  const empty = h("div");
  const filterBar = h("div", { class: "filter-bar" });
  const clearButton = () => {
    const el = h("button", { type: "button", class: "link" }, "전체 보기");
    el.addEventListener("click", () => pick(current));
    return el;
  };
  // Clicking the control of the filter already on clears it.
  const pick: PickFilter = (next) => {
    current = sameFilter(next, current) ? ALL : next;
    paintList();
  };
  const paintList = () => {
    const now = Date.now();
    const shown = loaded.filter((r) => matchesFilter(r, current, now));
    if (project !== null)
      summary.replaceChildren(summaryCards(project, current, pick));
    head.replaceChildren(boardHead(loaded, now, current, pick));
    list.replaceChildren(...shown.map((r) => runRow(r, now)));
    filterBar.replaceChildren(
      filterButton(
        "주의가 필요한 실행만",
        { kind: "attention" },
        current,
        pick,
      ),
      ...(current.kind === "all"
        ? []
        : [
            h(
              "span",
              { role: "status" },
              `${filterText(current)}: 불러온 실행 중 ${shown.length}건`,
            ),
            clearButton(),
          ]),
    );
    empty.replaceChildren(
      ...(shown.length === 0 && loaded.length > 0
        ? [
            messageBox(
              "status",
              `${filterText(current)}이 불러온 목록에 없습니다.`,
            ),
          ]
        : []),
    );
  };
  paintList();
  const more = h("div", { class: "more" });
  const failure = h("div");
  const paintMore = () => {
    more.replaceChildren();
    if (page.nextCursor === null) return;
    const cursor = page.nextCursor;
    const button = h("button", { type: "button" }, "더 보기");
    button.addEventListener("click", () => {
      button.disabled = true;
      ctx.api.runs(repo, cursor).then(
        (next) => {
          page = next;
          loaded.push(...next.runs);
          paintList();
          failure.replaceChildren();
          paintMore();
        },
        () => {
          button.disabled = false;
          failure.replaceChildren(
            messageBox(
              "alert",
              "다음 목록을 불러오지 못했습니다. 다시 시도해 주세요.",
            ),
          );
        },
      );
    });
    more.append(button);
  };
  paintMore();
  return {
    title: repo,
    el: h(
      "section",
      null,
      h("p", { class: "crumb" }, link("/", "프로젝트")),
      h("h1", null, repo),
      project === null ? null : summary,
      loaded.length === 0
        ? messageBox("status", "아직 실행이 없습니다.")
        : h(
            "div",
            { class: "toolbar" },
            filterBar,
            h(
              "p",
              { class: "legend muted" },
              "✓ 완료 · ● 진행 중 · ! 멈춤 · – 거치지 않음. 승인은 정책이 요구할 때만 거칩니다. 단계별 숫자는 불러온 실행 기준입니다.",
            ),
          ),
      loaded.length === 0 ? null : h("div", { class: "board" }, head, list),
      empty,
      failure,
      more,
    ),
  };
}

const STOP_ERRORS: Record<string, string> = {
  merge_attempted:
    "병합이 이미 시작되어 중지할 수 없습니다. 잠시 뒤 새로고침해서 결과를 확인해 주세요.",
  not_active: "이미 끝난 실행이라 중지할 수 없습니다.",
  not_found: "이 실행을 찾을 수 없습니다.",
  unauthenticated: "로그인이 끝났습니다. 다시 로그인해 주세요.",
  forbidden: "운영자만 실행을 중지할 수 있습니다.",
};

const REVIEW_ERRORS: Record<string, string> = {
  unauthenticated: "로그인이 끝났습니다. 다시 로그인해 주세요.",
  forbidden: "운영자만 승인하거나 수정을 요청할 수 있습니다.",
  not_found: "이 실행을 찾을 수 없습니다.",
};

/**
 * The approval box for an operator on a run that waits for approval. It names the commit the
 * operator is looking at; the server refuses when the PR has moved on. The decision itself is
 * made on GitHub with the operator's own sign-in, so a click only starts that sign-in.
 */
function approveControl(
  ctx: ViewContext,
  id: string,
  headSha: string,
): HTMLElement {
  const box = h("div", { class: "approve card" });
  const notice = h("div");
  const approve = h("button", { type: "button" }, "승인");
  const changes = h("button", { type: "button", class: "danger" }, "수정 요청");
  const send = (action: "approve" | "request_changes") => {
    approve.disabled = true;
    changes.disabled = true;
    notice.replaceChildren();
    ctx.api.review(id, action, headSha).then(
      (redirect) => {
        if (isGithubAuthorize(redirect)) ctx.navigate(redirect);
        else {
          approve.disabled = false;
          changes.disabled = false;
          notice.replaceChildren(
            messageBox(
              "alert",
              "승인을 시작하지 못했습니다. 다시 시도해 주세요.",
            ),
          );
        }
      },
      (error: unknown) => {
        const code = error instanceof ApiError ? error.code : "";
        if (code === "head_changed") {
          ctx.notify(
            "alert",
            "그 사이 PR의 커밋이 바뀌었습니다. 새 커밋을 확인한 뒤 다시 결정해 주세요.",
          );
          ctx.reload();
          return;
        }
        if (code === "not_awaiting_approval") {
          ctx.notify(
            "alert",
            "이 실행은 지금 승인을 기다리는 상태가 아닙니다. 현재 상태를 다시 불러왔습니다.",
          );
          ctx.reload();
          return;
        }
        approve.disabled = false;
        changes.disabled = false;
        notice.replaceChildren(
          messageBox(
            "alert",
            REVIEW_ERRORS[code] ??
              "승인을 시작하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
          ),
        );
      },
    );
  };
  approve.addEventListener("click", () => send("approve"));
  changes.addEventListener("click", () => send("request_changes"));
  box.append(
    h("h2", null, "승인 대기"),
    h(
      "p",
      null,
      "검토한 커밋: ",
      h("code", null, shortSha(headSha)),
      ". GitHub로 한 번 더 로그인해 리뷰를 남깁니다.",
    ),
    h(
      "p",
      { class: "muted" },
      "결정은 운영자 본인의 GitHub 리뷰로 기록됩니다.",
    ),
    h("div", { class: "actions" }, approve, changes),
    notice,
  );
  return box;
}

function costSection(cost: RunCost) {
  const part = (value: number | null) =>
    value !== null
      ? moneyText({ status: "measured", totalUsd: value })
      : cost.status === "measured"
        ? "기록 없음"
        : moneyText({ status: cost.status, totalUsd: null });
  const heading = h("h2", null, "모델 사용량과 비용");
  if (cost.tokens === null)
    return h(
      "section",
      { class: "card cost" },
      heading,
      h(
        "dl",
        { class: "counts" },
        h("dt", null, "합계"),
        h("dd", null, moneyText(cost)),
        h("dt", null, "구현"),
        h("dd", null, part(cost.implementUsd)),
        h("dt", null, "리뷰"),
        h("dd", null, part(cost.reviewUsd)),
      ),
    );
  const { implement, review } = cost.tokens;
  const row = (label: string, t: TokenUsage, money: string) =>
    h(
      "tr",
      null,
      h("td", null, label),
      h("td", null, money),
      h("td", null, tokenCount(t.inputTokens)),
      h("td", null, tokenCount(t.outputTokens)),
      h("td", null, tokenCount(t.cacheReadTokens)),
      h("td", null, tokenCount(t.cacheWriteTokens)),
    );
  const total: TokenUsage = {
    inputTokens: implement.inputTokens + review.inputTokens,
    outputTokens: implement.outputTokens + review.outputTokens,
    cacheReadTokens: implement.cacheReadTokens + review.cacheReadTokens,
    cacheWriteTokens: implement.cacheWriteTokens + review.cacheWriteTokens,
  };
  return h(
    "section",
    { class: "card cost" },
    heading,
    h(
      "div",
      { class: "cost-scroll" },
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ...["단계", "비용", "입력", "출력", "캐시 읽기", "캐시 쓰기"].map(
              (name) => h("th", { scope: "col" }, name),
            ),
          ),
        ),
        h(
          "tbody",
          null,
          row("구현", implement, part(cost.implementUsd)),
          row("리뷰", review, part(cost.reviewUsd)),
        ),
        h("tfoot", null, row("합계", total, moneyText(cost))),
      ),
    ),
    h("p", { class: "muted" }, "비용은 토큰 수에 단가를 곱한 추정값입니다."),
  );
}

const STOP_POLL_MS = 3000;
const STOP_POLL_MAX = 20;

/**
 * The stop button. A stop is a request: the server applies it at the run's next alarm tick.
 * After the request the page says so and keeps re-reading the run; it shows the run as stopped
 * only when the run's own state says it ended.
 */
function stopControl(
  ctx: ViewContext,
  id: string,
): { el: HTMLElement; cleanup: () => void } {
  const box = h("div", { class: "stop" });
  let timer: ReturnType<typeof setInterval> | undefined;
  const halt = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const idle = () => {
    const start = h("button", { type: "button", class: "danger" }, "실행 중지");
    start.addEventListener("click", confirming);
    box.replaceChildren(start);
  };
  const refresh = async () => {
    try {
      const { run } = await ctx.api.run(id);
      if (TERMINAL.includes(run.state)) {
        halt();
        ctx.reload();
      }
    } catch {
      /* The next poll tries again. */
    }
  };
  const requested = () => {
    const again = h("button", { type: "button" }, "상태 새로고침");
    again.addEventListener("click", () => void refresh());
    box.replaceChildren(
      messageBox(
        "status",
        "중지 요청됨. 서버가 다음 확인 때 적용하며, 진행 중이던 PR 게시나 이미 보낸 병합은 되돌려지지 않습니다. 아래 상태가 바뀔 때까지 실행은 계속 진행 중으로 표시됩니다.",
      ),
      again,
    );
    void refresh();
    let tries = 0;
    timer = setInterval(() => {
      if (++tries > STOP_POLL_MAX) {
        halt();
        box.replaceChildren(
          messageBox(
            "alert",
            "중지 요청이 아직 적용되지 않았습니다. 실행은 계속 진행 중으로 보입니다. 잠시 뒤 상태 새로고침을 눌러 확인해 주세요.",
          ),
          again,
        );
      } else void refresh();
    }, STOP_POLL_MS);
  };
  const confirming = () => {
    const yes = h("button", { type: "button", class: "danger" }, "중지 확인");
    const no = h("button", { type: "button" }, "취소");
    no.addEventListener("click", idle);
    yes.addEventListener("click", () => {
      yes.disabled = true;
      no.disabled = true;
      ctx.api.stop(id).then(requested, (error: unknown) => {
        const code = error instanceof ApiError ? error.code : "";
        box.replaceChildren(
          messageBox(
            "alert",
            STOP_ERRORS[code] ??
              "중지를 요청하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
          ),
        );
        const back = h("button", { type: "button" }, "닫기");
        back.addEventListener("click", idle);
        box.append(back);
      });
    });
    box.replaceChildren(
      h(
        "p",
        null,
        "이 실행의 중지를 요청할까요? 서버가 다음 확인 때 샌드박스를 정리하고 실행을 끝냅니다. 이미 열린 PR은 그대로 남습니다.",
      ),
      h("div", { class: "actions" }, yes, no),
    );
  };
  idle();
  return { el: box, cleanup: halt };
}

function eventItem(event: EventItem, previous: EventItem | undefined) {
  const reason =
    event.reasonCode === null ? undefined : REASON_LABELS[event.reasonCode];
  let title: string;
  let text: string;
  let tone: Tone;
  if (event.kind === "transition" && event.toState !== null) {
    const outcome = describeOutcome(event.toState, event.reasonCode);
    title = stateLabel(event.toState).title;
    text = outcome.text;
    tone = outcome.tone;
  } else {
    const kind = EVENT_KIND_LABELS[event.kind] ?? {
      title: "알 수 없는 기록",
      text: "이 포털이 알지 못하는 종류의 기록입니다.",
    };
    title = kind.title;
    text = reason?.text ?? kind.text;
    tone = reason?.tone ?? "info";
  }
  const time = formatTime(event.ts);
  return h(
    "li",
    { class: `tone-${tone}` },
    h("time", { datetime: time.iso }, time.text),
    previous === undefined
      ? null
      : h(
          "span",
          { class: "delta muted" },
          ` 이전 단계부터 ${durationText(Math.max(0, event.ts - previous.ts))}`,
        ),
    h("h3", null, title),
    h("p", null, text),
    reason === undefined
      ? null
      : h(
          "p",
          { class: "reason" },
          `사유: ${reason.title} `,
          h("code", null, event.reasonCode ?? ""),
        ),
  );
}

export async function runView(ctx: ViewContext, id: string): Promise<View> {
  const detail: RunDetail = await ctx.api.run(id);
  const { run, events } = detail;
  const outcome = describeOutcome(run.state, run.reasonCode);
  const nextStep = describeNextStep(run.state, run.reasonCode);
  const issue = githubLink(
    run.repo,
    "issues",
    run.issueNumber,
    `이슈 #${run.issueNumber}`,
  );
  const pull = githubLink(
    run.repo,
    "pull",
    run.prNumber,
    `PR #${run.prNumber}`,
  );

  const flow = h("div");
  const timeline = h("ol", { class: "timeline" });
  const controls = h("div", { class: "replay" });
  const position = h("span", {
    class: "replay-position",
    "aria-live": "polite",
  });

  const replay = createReplay({
    total: events.length,
    intervalMs: REPLAY_INTERVAL_MS,
    onChange: () => paint(),
  });

  const button = (label: string, action: () => void, disabled = false) => {
    const b = h("button", { type: "button" }, label);
    b.disabled = disabled;
    b.addEventListener("click", action);
    return b;
  };

  function paint() {
    const { shown, total, playing } = replay.state();
    const visible = events.slice(0, shown);
    const path = visible.flatMap((e) =>
      e.toState === null ? [] : [{ state: e.toState, at: e.ts }],
    );
    // While replaying, an unfinished stage is timed up to the next event, not up to today.
    const clock = events[shown]?.ts ?? Date.now();
    flow.replaceChildren(
      rail(
        stageCells({ state: path.at(-1)?.state ?? "", path }, clock),
        describeOutcome(path.at(-1)?.state ?? "", run.reasonCode).tone,
      ),
    );
    timeline.replaceChildren(
      ...visible.map((e, i) => eventItem(e, visible[i - 1])),
    );
    position.textContent = `${shown} / ${total}`;
    controls.replaceChildren(
      button("처음부터", () => replay.reset(), total === 0),
      button("이전", () => replay.prev(), shown === 0),
      button(playing ? "일시정지" : "재생", () => replay.toggle(), total === 0),
      button("다음", () => replay.next(), shown >= total),
      position,
    );
  }
  paint();

  const active = !TERMINAL.includes(run.state);
  const stop =
    ctx.me.role === "operator" && active ? stopControl(ctx, run.id) : null;
  const approve =
    ctx.me.role === "operator" &&
    run.state === "awaiting_approval" &&
    run.headSha !== null
      ? approveControl(ctx, run.id, run.headSha)
      : null;
  return {
    title: `실행 ${run.id}`,
    cleanup: () => {
      replay.destroy();
      stop?.cleanup();
    },
    el: h(
      "section",
      null,
      h(
        "p",
        { class: "crumb" },
        link("/", "프로젝트"),
        " / ",
        link(projectPath(run.repo), run.repo),
      ),
      h("h1", null, `실행 ${run.id}`),
      run.title === null ? null : h("p", { class: "run-title" }, run.title),
      h(
        "p",
        { class: "links" },
        issue ?? `이슈 #${run.issueNumber}`,
        " ",
        pull,
      ),
      h(
        "div",
        { class: `outcome tone-${outcome.tone}` },
        h("h2", null, outcome.title),
        h("p", null, outcome.text),
        nextStep === null
          ? null
          : h(
              "p",
              { class: "next-step" },
              h("strong", null, "운영자가 할 일: "),
              nextStep.action,
            ),
        nextStep?.note === undefined
          ? null
          : h("p", { class: "next-note" }, nextStep.note),
        run.reasonCode === null
          ? null
          : h(
              "p",
              { class: "reason" },
              "사유 코드 ",
              h("code", null, run.reasonCode),
            ),
      ),
      approve,
      stop?.el,
      costSection(run.cost),
      section(
        "흐름",
        h(
          "p",
          { class: "muted" },
          "접수부터 병합까지의 순서와 이 실행이 지나온 단계, 단계마다 걸린 시간입니다. 승인은 정책이 요구할 때만 거칩니다. 재생 버튼으로 처음부터 한 단계씩 다시 볼 수 있습니다.",
        ),
        flow,
      ),
      section("재생", controls, timeline),
    ),
  };
}
