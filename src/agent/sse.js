/**
 * Iterate a `fetch` Response body as parsed Server-Sent Events.
 *
 * Shared by every OpenAI Responses API caller in this codebase — the chat
 * brain and the cascade's fast leg both stream this way — so the streaming
 * quirks (keep-alive lines, a frame split across chunks, the trailing
 * `[DONE]`) are handled once rather than twice.
 */
export async function* readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        yield JSON.parse(payload);
      } catch {
        /* keep-alive or partial frame */
      }
    }
  }
}
