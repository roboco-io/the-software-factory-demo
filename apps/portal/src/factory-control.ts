import type { Api, FactoryState, Me } from "./api";
import { h } from "./dom";

/** Stage 7. The notice above every screen while the factory is stopped, or null. */
export function factoryNotice(state: FactoryState): string | null {
  if (state.enabled) return null;
  return "팩토리가 멈춰 있어 새 실행을 받지 않습니다. 운영자가 다시 시작하면 factory:go 라벨을 다시 붙여 실행할 수 있습니다. 멈추기 전에 열린 PR은 그대로 남아 있습니다.";
}

/**
 * Stage 7. The operator's factory-wide stop and resume. Null for anyone else and when the
 * state cannot be read. A stop needs a second, confirming click.
 */
export async function factoryControl(deps: {
  api: Api;
  me: Me;
  done(text: string): void;
}): Promise<HTMLElement | null> {
  if (deps.me.role !== "operator") return null;
  let state: FactoryState;
  try {
    state = await deps.api.factory();
  } catch {
    return null;
  }
  const box = h("div", { class: "factory-control" });
  const actions = h("div");
  const message = h("div");
  const fail = () =>
    message.replaceChildren(
      h(
        "div",
        { class: "message alert", role: "alert" },
        "팩토리 상태를 바꾸지 못했습니다. 운영자로 로그인했는지 확인하고 다시 시도해 주세요.",
      ),
    );
  const send = (enabled: boolean, buttons: HTMLButtonElement[]) => {
    for (const b of buttons) b.disabled = true;
    deps.api.setFactoryEnabled(enabled).then(
      (result) =>
        deps.done(
          enabled
            ? "팩토리를 다시 시작했습니다. 이제 새 실행을 받습니다."
            : `팩토리를 멈췄습니다. 진행 중이던 실행 ${result.stopRequested}건에 중지를 요청했습니다.${
                result.stopFailed > 0
                  ? ` ${result.stopFailed}건은 요청하지 못했으니 각 실행 화면에서 직접 중지해 주세요.`
                  : ""
              }`,
        ),
      () => {
        idle();
        fail();
      },
    );
  };
  const idle = () => {
    if (!state.enabled) {
      const resume = h("button", { type: "button" }, "다시 시작");
      resume.addEventListener("click", () => send(true, [resume]));
      actions.replaceChildren(resume);
      return;
    }
    const stop = h("button", { type: "button", class: "danger" }, "전체 중지");
    stop.addEventListener("click", () => {
      const yes = h("button", { type: "button", class: "danger" }, "중지 확정");
      const no = h("button", { type: "button" }, "취소");
      no.addEventListener("click", idle);
      yes.addEventListener("click", () => send(false, [yes, no]));
      actions.replaceChildren(
        h(
          "p",
          null,
          "모든 프로젝트의 새 실행을 막고, 진행 중인 실행 전부에 중지를 요청합니다. 계속할까요?",
        ),
        yes,
        no,
      );
    });
    actions.replaceChildren(stop);
  };
  idle();
  box.append(
    h(
      "p",
      null,
      state.enabled
        ? "팩토리가 실행을 받고 있습니다."
        : "팩토리가 멈춰 있습니다. 새 실행을 받지 않습니다.",
    ),
    h(
      "p",
      { class: "note" },
      "전체 중지는 배포 없이 바로 적용됩니다. 새 실행은 즉시 막히고, 진행 중인 실행은 각자 다음 확인 때 멈춥니다. 이미 GitHub에 보낸 병합과 이미 열린 PR은 되돌리지 않습니다. 누가 언제 바꿨는지 기록됩니다.",
    ),
    actions,
    message,
  );
  return box;
}
