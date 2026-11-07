import {
  explain,
  fetchConsole,
  fetchRun,
  money,
  sendReview,
  stageOf,
} from "./console-model";

type Cost = {
  status: string;
  totalUsd: number | null;
  implementUsd: number | null;
  reviewUsd: number | null;
};
type Run = {
  id: string;
  repo: string;
  issueNumber: number;
  title: string | null;
  tier: string | null;
  state: string;
  reasonCode: string | null;
  prNumber: number | null;
  headSha: string | null;
  updatedAt: number;
  bucket: "attention" | "active" | "done";
  cost: Cost;
  events?: {
    ts: number;
    kind: string;
    fromState: string | null;
    toState: string | null;
    reasonCode: string | null;
  }[];
};
type Totals = {
  attention: number;
  active: number;
  done: number;
  usd: number | null;
};
type Session = { role: string; login: string | null; loginEnabled: boolean };
type Deps = { fetch: typeof fetch; setInterval: typeof setInterval };

const STAGES = ["대기", "구현", "리뷰", "체크", "승인", "종료"];
const ROLE_LABELS: Record<string, string> = {
  anonymous: "로그인하지 않음",
  observer: "옵저버로 로그인함",
  operator: "운영자로 로그인함",
};
const STATE_LABELS: Record<string, string> = {
  queued: "대기 중",
  cloning: "저장소 준비 중",
  implementing: "구현 중",
  publishing: "변경 올리는 중",
  pr_opened: "PR 열림",
  reviewing: "리뷰 중",
  awaiting_checks: "체크 대기",
  awaiting_approval: "승인 필요",
  merged: "병합됨",
  needs_human: "사람 확인 필요",
  failed: "실패",
};
const CLEANUP_LABEL = "정리 작업";
const stateLabel = (s: string) => STATE_LABELS[s] ?? s;
const REVIEW_NOTICES: Record<string, string> = {
  ok: "리뷰를 GitHub에 남겼습니다. 팩토리가 다시 판정합니다.",
  stale:
    "화면을 본 뒤 커밋이 바뀌어 리뷰를 남기지 않았습니다. 새 커밋을 확인한 뒤 다시 결정하세요.",
  denied: "이 계정에는 리뷰를 남길 권한이 없습니다.",
  failed: "GitHub에 리뷰를 남기지 못했습니다. 잠시 뒤 다시 시도하세요.",
};
const POLL_MS = 30000;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content !== undefined) node.textContent = content;
  return node;
}

function ago(ts: number, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - ts) / 60000));
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const titleOf = (r: Run) => r.title ?? `이슈 #${r.issueNumber}`;
const stoppedOf = (r: Run) => r.state === "needs_human" || r.state === "failed";

export async function mountConsole(
  root: HTMLElement,
  deps: Deps,
): Promise<void> {
  const ui = {
    runs: [] as Run[],
    totals: { attention: 0, active: 0, done: 0, usd: 0 } as Totals,
    session: { role: "anonymous", login: null, loginEnabled: false } as Session,
    loaded: false,
    filter: "all" as "all" | "attention",
    selectedId: null as string | null,
    detail: null as Run | null,
    stale: false,
    notice: null as string | null,
    busy: false,
  };

  const params = new URLSearchParams(location.search);
  const returned = params.get("review");
  if (returned && REVIEW_NOTICES[returned])
    ui.notice = REVIEW_NOTICES[returned]!;
  const returnedRun = params.get("run");
  if (returnedRun) ui.selectedId = returnedRun;

  function topBar(): HTMLElement {
    const header = el("header", "top");
    const left = el("div");
    left.append(
      el("h1", "", "Software Factory"),
      el("div", "muted", "실행 현황"),
    );
    const right = el("div", "top-actions");
    right.append(
      el(
        "span",
        "small muted",
        ROLE_LABELS[ui.session.role] ?? ROLE_LABELS.anonymous!,
      ),
    );
    if (ui.session.login) {
      const out = el("button", "pill pill-light", "로그아웃");
      out.type = "button";
      out.addEventListener("click", () => void logout());
      right.append(out);
    } else if (ui.session.loginEnabled) {
      const a = el("a", "pill pill-light", "GitHub로 로그인");
      a.href = "/api/auth/login";
      right.append(a);
    }
    header.append(left, right);
    return header;
  }

  function cards(): HTMLElement {
    const section = el("section", "cards");
    section.setAttribute("aria-label", "요약");
    const usd =
      ui.totals.usd === null
        ? money({ status: "unknown", totalUsd: null })
        : money({ status: "measured", totalUsd: ui.totals.usd });
    const items: [string, string, string][] = [
      ["확인 필요", String(ui.totals.attention), "warn"],
      ["진행 중", String(ui.totals.active), ""],
      ["종료", String(ui.totals.done), ""],
      ["모델 비용 (추정)", usd, ""],
    ];
    for (const [label, value, tone] of items) {
      const card = el("div", "card");
      card.dataset.card = label;
      card.append(
        el("div", "muted", label),
        el("div", `card-value ${tone}`.trim(), value),
      );
      section.append(card);
    }
    return section;
  }

  function track(r: Run): HTMLElement {
    const stage = stageOf(r.state);
    const t = el("span", `track tone-${r.bucket}`);
    t.setAttribute(
      "aria-label",
      `6단계 중 ${stage + 1}단계: ${STAGES[stage]}${stoppedOf(r) ? "에서 멈춤" : ""}`,
    );
    STAGES.forEach((_, i) =>
      t.append(
        el("span", i < stage ? "seg done" : i === stage ? "seg now" : "seg"),
      ),
    );
    return t;
  }

  function row(r: Run): HTMLElement {
    const b = el("button", "row");
    b.type = "button";
    b.dataset.run = r.id;
    b.setAttribute("aria-pressed", String(r.id === ui.selectedId));
    const head = el("span", "row-head");
    const main = el("span", "row-main");
    main.append(
      el("span", "row-title", titleOf(r)),
      el(
        "span",
        "row-sub small muted",
        `#${r.issueNumber} · ${r.tier ?? "미정"} · ${ago(r.updatedAt)} · ${money(r.cost)}`,
      ),
    );
    head.append(
      main,
      el("span", `badge tone-${r.bucket}`, stateLabel(r.state)),
    );
    b.append(head, track(r), el("span", "small muted", explain(r)));
    b.addEventListener("click", () => void select(r.id));
    return b;
  }

  function list(): HTMLElement {
    const wrap = el("div", "list");
    const visible =
      ui.filter === "attention"
        ? ui.runs.filter((r) => r.bucket === "attention")
        : ui.runs;
    if (!visible.length) {
      const empty = el("p", "empty");
      empty.textContent = !ui.loaded
        ? "실행 현황을 불러오지 못했습니다. 잠시 뒤 다시 시도합니다."
        : ui.runs.length
          ? "확인이 필요한 실행이 없습니다."
          : "표시할 실행이 없습니다. 공개된 저장소에서 이슈가 처리되면 여기에 나타납니다.";
      wrap.append(empty);
    }
    for (const r of visible) wrap.append(row(r));
    return wrap;
  }

  function filters(): HTMLElement {
    const bar = el("div", "bar");
    const left = el("div", "bar-left");
    left.append(el("h2", "", "작업 현황"));
    const counts = el("div", "small muted");
    counts.setAttribute("aria-label", "단계별 건수");
    counts.textContent = STAGES.map((name, i) => {
      const n = ui.runs.filter((r) => stageOf(r.state) === i).length;
      return `${name} ${n}`;
    }).join(" · ");
    left.append(counts);
    const btns = el("div", "filters");
    for (const [key, label] of [
      ["all", "전체"],
      ["attention", "확인 필요"],
    ] as const) {
      const b = el("button", "pill pill-filter", label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(ui.filter === key));
      b.addEventListener("click", () => {
        ui.filter = key;
        render();
      });
      btns.append(b);
    }
    bar.append(left, btns);
    return bar;
  }

  function approval(r: Run): HTMLElement | null {
    if (r.state !== "awaiting_approval") return null;
    const box = el("section", "approval");
    box.append(
      el(
        "h3",
        "",
        `승인 요청: 커밋 ${r.headSha ? r.headSha.slice(0, 7) : "확인 불가"}`,
      ),
    );
    if (ui.session.role === "operator" && r.headSha) {
      box.append(
        el(
          "p",
          "small muted",
          "변경 내용을 GitHub PR에서 검토한 뒤 결정하세요. 결정은 운영자 본인의 GitHub 리뷰로 기록됩니다.",
        ),
      );
      const btns = el("div", "decide");
      const ok = el("button", "pill pill-light", "승인");
      const no = el("button", "pill pill-outline", "수정 요청");
      for (const [b, action] of [
        [ok, "approve"],
        [no, "request_changes"],
      ] as const) {
        b.type = "button";
        b.disabled = ui.busy;
        b.addEventListener("click", () => void decide(r, action));
        btns.append(b);
      }
      box.append(btns);
    } else {
      box.append(
        el(
          "p",
          "small muted",
          "운영자만 승인할 수 있습니다. 변경 내용은 GitHub PR에서 볼 수 있습니다.",
        ),
      );
    }
    return box;
  }

  function detailPane(): HTMLElement {
    const aside = el("aside", "detail");
    aside.setAttribute("aria-label", "선택한 작업 상세");
    const r = ui.detail ?? ui.runs.find((x) => x.id === ui.selectedId) ?? null;
    if (!r) {
      aside.append(
        el(
          "p",
          "muted",
          "목록에서 작업을 선택하면 멈춘 이유와 상태 기록을 볼 수 있습니다.",
        ),
      );
      return aside;
    }
    const top = el("div", "detail-top small muted");
    top.append(
      el("span", "", "선택한 작업 상세"),
      el("span", "mono", `#${r.issueNumber}`),
    );
    aside.append(
      top,
      el("h2", "detail-title", titleOf(r)),
      el("p", "", explain(r)),
    );

    const dl = el("dl", "facts");
    const fact = (label: string, node: Node | string, mono = false) => {
      const d = el("div");
      const dd = el("dd", mono ? "mono" : "");
      dd.append(node);
      d.append(el("dt", "", label), dd);
      dl.append(d);
    };
    let pr: Node | string = "없음";
    if (r.prNumber !== null && /^[\w.-]+\/[\w.-]+$/.test(r.repo)) {
      const a = el("a", "", `#${r.prNumber}`);
      a.href = `https://github.com/${r.repo}/pull/${r.prNumber}`;
      a.rel = "noopener noreferrer";
      pr = a;
    }
    fact("PR", pr);
    fact("사유 코드", r.reasonCode ?? "없음", true);
    fact(
      "구현 비용 (추정)",
      money({ status: r.cost.status, totalUsd: r.cost.implementUsd }),
    );
    fact(
      "리뷰 비용 (추정)",
      money({ status: r.cost.status, totalUsd: r.cost.reviewUsd }),
    );
    aside.append(dl);

    const ap = approval(r);
    if (ap) aside.append(ap);

    const hist = el("section", "history");
    hist.append(el("h3", "", "상태 기록"));
    const ol = el("ol");
    for (const ev of r.events ?? []) {
      const li = el("li");
      li.append(
        el("span", "", ev.toState ? stateLabel(ev.toState) : CLEANUP_LABEL),
        el("span", "mono small muted", clock(ev.ts)),
      );
      ol.append(li);
    }
    hist.append(ol);
    aside.append(
      hist,
      el(
        "p",
        "small muted",
        "에이전트 원문 로그는 표시하지 않습니다. 비용은 청구액이 아닌 추정치입니다.",
      ),
    );
    return aside;
  }

  function render(): void {
    const children: Node[] = [topBar()];
    if (ui.notice) {
      const n = el("p", "notice", ui.notice);
      n.setAttribute("role", "status");
      children.push(n);
    }
    if (ui.stale) {
      const n = el(
        "p",
        "notice warn-box",
        "최신 상태를 불러오지 못했습니다. 마지막으로 불러온 내용을 보여 줍니다.",
      );
      n.setAttribute("role", "alert");
      children.push(n);
    }
    children.push(cards(), filters());
    const layout = el("div", "layout");
    layout.append(list(), detailPane());
    children.push(layout);
    const main = el("div", "console");
    main.append(...children);
    root.replaceChildren(main);
  }

  async function loadDetail(id: string): Promise<void> {
    try {
      const d = (await fetchRun(deps.fetch, id)) as Run | null;
      if (ui.selectedId === id && d) ui.detail = d;
    } catch {
      /* keep what is shown */
    }
  }

  async function select(id: string): Promise<void> {
    ui.selectedId = id;
    ui.detail = null;
    render();
    await loadDetail(id);
    render();
    revealDetail();
  }

  function revealDetail(): void {
    try {
      if (typeof window.matchMedia !== "function") return;
      if (!window.matchMedia("(max-width: 959px)").matches) return;
      const pane = root.querySelector("aside.detail");
      if (pane && typeof pane.scrollIntoView === "function")
        pane.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      /* scrolling is optional */
    }
  }

  async function refresh(): Promise<void> {
    try {
      const data = await fetchConsole(deps.fetch);
      ui.runs = data.runs as Run[];
      ui.totals = data.totals as Totals;
      ui.session = data.session as Session;
      ui.loaded = true;
      ui.stale = false;
      if (ui.selectedId) await loadDetail(ui.selectedId);
    } catch {
      ui.stale = true;
    }
    render();
  }

  async function decide(
    r: Run,
    action: "approve" | "request_changes",
  ): Promise<void> {
    if (!r.headSha || ui.busy) return;
    ui.busy = true;
    ui.notice = null;
    render();
    try {
      const result = (await sendReview(
        deps.fetch,
        r.id,
        action,
        r.headSha,
      )) as {
        redirect?: string;
        error?: string;
      };
      if (result.redirect) {
        location.assign(result.redirect);
        return;
      }
      result.error ??= "unknown";
      ui.notice =
        result.error === "head_changed"
          ? "화면을 본 뒤 커밋이 바뀌었습니다. 새로 불러온 뒤 변경 내용을 다시 확인하세요."
          : result.error === "login_required"
            ? "로그인이 필요합니다."
            : result.error === "forbidden"
              ? REVIEW_NOTICES.denied!
              : "요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.";
      if (result.error === "head_changed") await refresh();
    } catch {
      ui.notice = "요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.";
    } finally {
      ui.busy = false;
    }
    render();
  }

  async function logout(): Promise<void> {
    try {
      await deps.fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* the next refresh shows the real session */
    }
    await refresh();
  }

  await refresh();
  deps.setInterval(() => void refresh(), POLL_MS);
}
