// 이 저장소의 예전 이름은 conveyor 포럼 앱이 쓰던 Pages 주소였다.
// 저장소 이름이 바뀐 뒤 그 앱은 /conveyor/로 옮겼고, GitHub는 Pages 주소를 넘겨 주지 않는다.
// 이 함수는 예전 링크를 conveyor의 같은 위치로 보낼 주소를 계산한다.

export const BASE = "/the-software-factory-demo/";
export const PORTAL_URL =
  "https://software-factory-control.roboco.workers.dev/projects/roboco-io/conveyor";

/**
 * @param {{ pathname: string, search: string, hash: string }} location
 * @returns {string | null} 보낼 주소. 이 사이트의 페이지를 그대로 보여 줄 때는 null.
 */
export function conveyorTarget({ pathname, search, hash }) {
  if (!pathname.startsWith(BASE)) return null;
  const rest = pathname.slice(BASE.length);
  if (rest === "" || rest === "index.html") {
    // conveyor는 HashRouter를 쓰므로 예전 화면 링크는 루트 + "#/..." 형태다.
    return hash.startsWith("#/") ? `/conveyor/${search}${hash}` : null;
  }
  if (rest === "404.html") return null;
  // conveyor의 옛 팩토리 대시보드는 제어 평면 포털로 대체됐다.
  if (rest === "factory" || rest.startsWith("factory/")) return PORTAL_URL;
  return `/conveyor/${rest}${search}${hash}`;
}
