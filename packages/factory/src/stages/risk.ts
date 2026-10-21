import { TooManyFilesError, type ChangedFile } from "../github/port";
import { classifyFiles, normalizePath, type FileTier, type Tier } from "../policy/risk";
import { parsePrMeta } from "../report/pr";
import type { StageDeps } from "./deps";
import { flattenFiles } from "./gate";

export interface RiskReport {
  pr: number;
  tier: Tier;
  files: FileTier[];
  botAuthor: boolean;
  role: "implement" | "improve" | "revert" | null;
  forbidden: string[];
  // sha를 받았는데 PR head가 그 SHA가 아니면 true다. 판정한 커밋과 배포할 커밋이 다를 수 있으므로 프리뷰를 막는다.
  stale: boolean;
  previewAllowed: boolean;
}

export const SKIP_FILES = ["tests/realworld/skip.txt", "tests/forum/skip.txt"] as const;

// F21: 봇 implement PR이 skip.txt에 줄을 더하면 계약 실패(RealWorld·포럼)를 숨길 수 있다. 줄 삭제는 허용한다.
// 이름 변경으로 skip.txt를 만드는 경우와, patch가 없거나 잘려 줄 단위로 확인할 수 없는
// 추가(바이너리·큰 diff)도 내용을 알 수 없으므로 금지한다. 줄을 더한 skip 파일 경로를 돌려준다.
export function skipEntryFiles(files: ChangedFile[]): string[] {
  const hit = new Set<string>();
  for (const f of files) {
    const name = normalizePath(f.filename);
    if (!(SKIP_FILES as readonly string[]).includes(name)) continue;
    const count = f.additionCount ?? 0;
    if (
      f.additions.some((l) => l.trim() !== "") ||
      (f.previousFilename !== undefined && normalizePath(f.previousFilename) !== name) ||
      (f.patchMissing === true && count > 0) ||
      count > f.additions.length
    ) {
      hit.add(name);
    }
  }
  return [...hit];
}

export async function runRisk(
  deps: StageDeps,
  args: { pr: number; check: boolean; sha?: string },
): Promise<RiskReport> {
  const pull = await deps.gh.getPull(args.pr);
  let changed: ChangedFile[] | null = null;
  try {
    changed = await deps.gh.listPullFiles(args.pr);
  } catch (e) {
    if (!(e instanceof TooManyFilesError)) throw e;
  }
  // 목록을 얻지 못하면(파일이 너무 많음) 등급을 알 수 없으므로 T3로 본다.
  const risk: { tier: Tier; files: FileTier[] } = changed
    ? classifyFiles(flattenFiles(changed), deps.policy)
    : { tier: "T3", files: [] };
  const botAuthor = pull.author === deps.settings.botLogin;
  // 봇 PR의 역할은 PR 본문 표식으로 읽는다. 표식이 없으면 가장 엄격한 implement로 본다.
  const role = botAuthor ? (parsePrMeta(pull.body)?.role ?? "implement") : null;
  const forbidden: string[] = [];
  if (role === "implement" || role === "revert") {
    if (!changed) forbidden.push("(변경 파일이 너무 많아 등급을 판정할 수 없다)");
    else {
      forbidden.push(...risk.files.filter((f) => f.tier === "T3").map((f) => f.file));
      forbidden.push(...skipEntryFiles(changed));
    }
  }
  const stale = args.sha !== undefined && pull.headSha !== args.sha;
  const previewAllowed = !stale && !(botAuthor && (risk.tier === "T2" || risk.tier === "T3"));
  if (args.check) {
    const wanted = `risk:${risk.tier}`;
    try {
      for (const l of pull.labels)
        if (/^risk:T[0-3]$/.test(l) && l !== wanted) await deps.gh.removeLabel(args.pr, l);
      if (!pull.labels.includes(wanted)) await deps.gh.addLabels(args.pr, [wanted]);
    } catch (e) {
      // fork PR의 GITHUB_TOKEN은 읽기 전용이라 라벨 쓰기가 403이다. 라벨은 표시용이고 check의 판정은 forbidden만 쓴다.
      if ((e as { status?: number }).status !== 403) throw e;
    }
  }
  return {
    pr: args.pr,
    tier: risk.tier,
    files: risk.files,
    botAuthor,
    role,
    forbidden,
    stale,
    previewAllowed,
  };
}
