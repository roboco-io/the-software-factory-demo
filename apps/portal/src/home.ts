export function renderHome(root: HTMLElement): void {
  const title = document.createElement("h1");
  title.textContent = "Software Factory";
  const body = document.createElement("p");
  body.textContent =
    "이슈를 AI 에이전트가 계획, 구현, 리뷰, 배포까지 처리하는 과정을 관찰하는 포털입니다. 지금은 준비 중입니다.";
  root.replaceChildren(title, body);
}
