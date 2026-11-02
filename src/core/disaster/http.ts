// Stream the response so large error pages cannot bypass the body cap.
export async function fetchText(url: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  const reader = response.body?.getReader(), decoder = new TextDecoder(); let size = 0, text = '';
  if (reader) try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) throw Error('來源回應超過大小上限'); text += decoder.decode(value, { stream: true }); }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  return { status: response.status, text };
}
