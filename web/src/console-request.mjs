import { consoleFetch as fetch } from "./console-api.mjs";
import { readJsonResponse } from "./response-errors.js";

export async function apiFetch(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-console-token": token,
      ...(options.headers || {}),
    },
  });
  return readJsonResponse(response);
}
