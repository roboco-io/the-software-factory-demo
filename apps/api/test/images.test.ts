import { describe, expect, it } from "vitest";
import { api, register } from "./helpers";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

const upload = (body: BodyInit, type: string, token?: string) =>
  api("/user/image", {
    method: "POST",
    token,
    headers: { "content-type": type },
    rawBody: body as string,
  });

describe("image upload", () => {
  it("stores the image, returns its URL, and exposes it on GET /user", async () => {
    const { token } = await register("img");
    const res = await upload(PNG as unknown as string, "image/png", token);
    expect(res.status).toBe(200);
    const { image } = (await res.json()) as { image: string };
    const me = (await (await api("/user", { token })).json()) as { user: { image: string } };
    expect(me.user.image).toBe(image);
    const served = await api(new URL(image).pathname.replace("/api", ""));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it("rejects anonymous uploads with 401", async () => {
    const res = await upload(PNG as unknown as string, "image/png");
    expect(res.status).toBe(401);
  });

  it("rejects unsupported types and oversized files", async () => {
    const { token } = await register("img");
    const bad = await upload("<svg/>", "image/svg+xml", token);
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ errors: { image: ["is invalid"] } });
    const big = await upload(
      new Uint8Array(1024 * 1024 + 1) as unknown as string,
      "image/png",
      token,
    );
    expect(big.status).toBe(422);
    expect(await big.json()).toEqual({ errors: { image: ["must be 1048576 or less"] } });
  });

  it("rejects oversized streaming bodies without Content-Length", async () => {
    const { token } = await register("img");
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(256 * 1024));
        if (pulls >= 40) controller.close();
      },
    });
    const res = await upload(stream as unknown as string, "image/png", token);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ errors: { image: ["must be 1048576 or less"] } });
    expect(pulls).toBeLessThan(40);
  });

  it("rejects files whose content does not match the declared type", async () => {
    const { token } = await register("img");
    const res = await upload("<svg xmlns='http://www.w3.org/2000/svg'/>", "image/png", token);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ errors: { image: ["is invalid"] } });
    const me = (await (await api("/user", { token })).json()) as { user: { image: string | null } };
    expect(me.user.image).toBeNull();
  });

  it("returns 404 for unknown images", async () => {
    expect((await api("/images/999999")).status).toBe(404);
  });
});
