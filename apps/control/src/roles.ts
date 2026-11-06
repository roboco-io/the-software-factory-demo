import type { Session } from "./session";

export type Role = "anonymous" | "observer" | "operator";

const RANK: Readonly<Record<Role, number>> = {
  anonymous: 0,
  observer: 1,
  operator: 2,
};

export const hasRole = (role: Role, minimum: Role): boolean =>
  RANK[role] >= RANK[minimum];

/**
 * The caller's role, computed from the numeric GitHub id on every request.
 * It is never stored in the cookie, so removing an id from OPERATOR_IDS takes effect at once.
 */
export function roleOf(
  session: Session | null,
  operatorIds: readonly string[],
): Role {
  if (session === null) return "anonymous";
  return operatorIds.includes(session.id) ? "operator" : "observer";
}
