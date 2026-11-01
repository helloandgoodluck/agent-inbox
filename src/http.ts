// Small HTTP helpers shared by the item API and passkey sign-in.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readJson(
  request: Request,
  allowEmpty = false,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new HttpError(400, "request body must be JSON");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
