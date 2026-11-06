import {
  ApiError,
  type Api,
  type EventItem,
  type Me,
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
  describeOutcome,
  stateLabel,
  type Tone,
} from "./labels";
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

export function homeView(me: Me): View {
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
    title: "Software Factory",
    el: h(
      "section",
      null,
      h("h1", null, "Software Factory"),
      h(
        "p",
        { class: "lead" },
        "이슈 하나가 AI 에이전트의 구현과 리뷰를 거쳐 병합되기까지의 과정을 그대로 관찰하는 포털입니다. 각 단계는 고정된 사유 코드와 함께 기록되고, 이 화면은 그 기록을 한국어로 풀어 보여 줍니다.",
      ),
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
      h(
        "p",
        null,
        link("/projects", "프로젝트 보기"),
        me.role === "anonymous" ? " 로그인 없이도 볼 수 있습니다." : "",
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

export async function projectsView(ctx: ViewContext): Promise<View> {
  const { projects } = await ctx.api.projects();
  const body =
    projects.length === 0
      ? messageBox("status", "등록된 프로젝트가 없습니다.")
      : h(
          "ul",
          { class: "cards" },
          ...projects.map((p) =>
            h(
              "li",
              { class: "card" },
              h("h2", null, link(projectPath(p.repo), p.repo)),
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
  return {
    title: "프로젝트",
    el: h("section", null, h("h1", null, "프로젝트"), body),
  };
}

function runRow(run: RunSummary) {
  const outcome = describeOutcome(run.state, run.reasonCode);
  const issue = githubLink(
    run.repo,
    "issues",
    run.issueNumber,
    `이슈 #${run.issueNumber}`,
  );
  return h(
    "li",
    { class: `card run-row tone-${outcome.tone}` },
    h(
      "div",
      null,
      link(runPath(run.id), `실행 ${run.id}`),
      " ",
      issue ?? `이슈 #${run.issueNumber}`,
    ),
    h(
      "div",
      { class: "status" },
      h("strong", null, outcome.title),
      " ",
      h("span", { class: "muted" }, stateLabel(run.state).title),
    ),
    h(
      "time",
      { datetime: formatTime(run.updatedAt).iso },
      formatTime(run.updatedAt).text,
    ),
  );
}

export async function projectView(
  ctx: ViewContext,
  repo: string,
): Promise<View> {
  let page = await ctx.api.runs(repo);
  const list = h("ul", { class: "cards" }, ...page.runs.map(runRow));
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
          list.append(...next.runs.map(runRow));
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
      h("p", { class: "crumb" }, link("/projects", "프로젝트")),
      h("h1", null, repo),
      page.runs.length === 0
        ? messageBox("status", "아직 실행이 없습니다.")
        : list,
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

const FLOW = [
  "queued",
  "cloning",
  "implementing",
  "publishing",
  "pr_opened",
  "reviewing",
  "awaiting_checks",
  "awaiting_approval",
  "merged",
];

function eventItem(event: EventItem) {
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

  const steps = h("ol", { class: "steps", "aria-label": "진행 단계" });
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
    const reached = new Set(visible.map((e) => e.toState));
    const current = visible.at(-1)?.toState ?? null;
    const extra = ["needs_human", "failed"].filter((s) => reached.has(s));
    steps.replaceChildren(
      ...[...FLOW, ...extra].map((state) =>
        h(
          "li",
          {
            class: [
              reached.has(state) ? "reached" : "",
              state === current ? "current" : "",
              state === "awaiting_approval" ? "optional" : "",
            ]
              .filter(Boolean)
              .join(" "),
          },
          stateLabel(state).title,
          state === "awaiting_approval"
            ? h("small", null, "정책이 요구할 때만")
            : null,
        ),
      ),
    );
    timeline.replaceChildren(...visible.map(eventItem));
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
        link("/projects", "프로젝트"),
        " / ",
        link(projectPath(run.repo), run.repo),
      ),
      h("h1", null, `실행 ${run.id}`),
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
        run.reasonCode === null
          ? null
          : h(
              "p",
              { class: "reason" },
              "사유 코드 ",
              h("code", null, run.reasonCode),
            ),
      ),
      stop?.el,
      section(
        "흐름",
        h(
          "p",
          { class: "muted" },
          "기록된 이벤트를 따라 이 실행이 지나온 단계입니다. 재생 버튼으로 처음부터 한 단계씩 다시 볼 수 있습니다.",
        ),
        steps,
      ),
      section("재생", controls, timeline),
    ),
  };
}
