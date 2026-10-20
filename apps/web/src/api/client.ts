import type { Errors } from "./types";

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "http://localhost:8787/api";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly errors: Errors,
  ) {
    super(errorMessages(errors).join(", "));
  }
}

export const errorMessages = (errors: Errors): string[] =>
  Object.entries(errors).flatMap(([field, msgs]) => msgs.map((m) => `${field} ${m}`));

export type Client = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  upload<T>(path: string, file: Blob): Promise<T>;
  del(path: string): Promise<void>;
};

export function createClient(
  base: string,
  getToken: () => string | null,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Client {
  async function request<T>(method: string, path: string, body?: unknown, file?: Blob): Promise<T> {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.authorization = `Token ${token}`;
    if (file) headers["content-type"] = file.type;
    else if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: file ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
    } catch {
      throw new ApiFailure(0, { network: ["is unreachable"] });
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const errors = (data as { errors?: Errors } | undefined)?.errors;
      throw new ApiFailure(res.status, errors ?? { server: [`responded with ${res.status}`] });
    }
    return data as T;
  }
  return {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b),
    put: (p, b) => request("PUT", p, b),
    upload: (p, f) => request("POST", p, undefined, f),
    del: (p) => request("DELETE", p),
  };
}
