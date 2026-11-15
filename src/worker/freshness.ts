// Heartbeats record successful fetch/validation/publication, including unchanged
// data and HTTP 304. Legacy KV values lack them: use content updatedAt instead,
// conservatively warning until a successful writer run creates the heartbeat.
export async function readSuccessAt(kv: KVNamespace, key: string, field = 'lastSuccessAt', legacyField?: string): Promise<string | undefined> {
  try {
    const data = JSON.parse(await kv.get(key) ?? 'null');
    const at = data?.[field] ?? (legacyField ? data?.[legacyField] : undefined);
    if (data?.v !== 1 || typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at))) return;
    return new Date(`${at.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === at.slice(0, 10) ? at : undefined;
  } catch { return undefined; }
}
