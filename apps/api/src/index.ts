import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv, Env } from "./env";
import { recordError } from "./lib/error-events";
import { ApiError, ROUTE_NOT_FOUND } from "./lib/errors";
import { intakeRouter } from "./routes/intake";
import { deferredRouter } from "./routes/deferred";
import { feedbackRouter } from "./routes/feedback";
import { articlesRouter } from "./routes/articles";
import { commentsRouter } from "./routes/comments";
import { profilesRouter } from "./routes/profiles";
import { tagsRouter } from "./routes/tags";
import { usersRouter } from "./routes/users";
import { imagesRouter } from "./routes/images";
import { bookRouter } from "./routes/book";
import { topicsRouter } from "./routes/topics";
import { repliesRouter } from "./routes/replies";
import { reportsRouter } from "./routes/reports";
import { agentsRouter } from "./routes/agents";
import { agentGuard } from "./middleware/agent";
import { syncBook } from "./lib/book-sync";
import { openapi } from "./openapi";

const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })(c, next);
});

const router = new Hono<AppEnv>();
router.get("/health", (c) => c.json({ status: "ok" }));
router.get("/openapi.json", (c) => c.json(openapi));
router.route("/", deferredRouter);
router.route("/", usersRouter);
router.route("/", imagesRouter);
router.route("/", profilesRouter);
router.route("/", articlesRouter);
router.route("/", commentsRouter);
router.route("/", tagsRouter);
router.route("/", feedbackRouter);
router.route("/", bookRouter);
router.route("/", topicsRouter);
router.route("/", repliesRouter);
router.route("/", reportsRouter);
router.route("/", agentsRouter);
router.route("/", intakeRouter);

app.use("/api/*", agentGuard);
app.route("/api", router);

app.notFound((c) => c.json(ROUTE_NOT_FOUND, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ errors: err.errors }, err.status);
  const msg = String((err as { cause?: unknown }).cause ?? err.message);
  const unique = /UNIQUE constraint failed: users\.(email|username)/.exec(msg);
  if (unique) return c.json({ errors: { [unique[1]!]: ["has already been taken"] } }, 409);
  console.error(err);
  // spec 7.1.3: 기록은 응답을 늦추지 않도록 waitUntil로 넘기고, 기록 실패는 무시한다.
  // routePath를 읽다 실패해도 기록은 남겨야 하므로 별도 try로 감싼다.
  let route = "{unmatched}";
  try {
    route = c.req.routePath ?? route;
  } catch {
    // 패턴을 알 수 없으면 {unmatched}로 기록한다.
  }
  try {
    c.executionCtx.waitUntil(recordError(c.env, err, route).catch(() => undefined));
  } catch {
    // ExecutionContext가 없는 실행에서는 기록하지 않는다.
  }
  return c.json({ errors: { server: ["internal error"] } }, 500);
});

// 동기화를 끝낸 뒤 반환한다. 실패해도 기존 데이터를 그대로 둔다.
export default Object.assign(app, {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      await syncBook(env);
    } catch (err) {
      console.error("book sync failed", err);
    }
  },
});
