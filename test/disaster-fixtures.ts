import { readFileSync, readdirSync } from 'node:fs';
import { parseDgpa } from '../src/core/disaster/parse.js';
import type { Index, State } from '../src/core/disaster/model.js';
export const fixture = (name: string) => readFileSync(new URL(`./fixtures/disaster/${name}`, import.meta.url), 'utf8');
export const htmlFiles = readdirSync(new URL('./fixtures/disaster/', import.meta.url)).filter(f => f.endsWith('.html'));
export const none = fixture('dgpa-nds-2026-11-02-no-event.html');
export const json = fixture('ncdr-JSONAtomFeeds-active-2026-11-02.json');
export const atom = fixture('ncdr-RssAtomFeeds-active-2026-11-02.xml');
export const wind = fixture('ncdr-cap-cwa-strong-wind.cap');
export const reservoir = fixture('ncdr-cap-wra-reservoir.cap');
export const at = '2026-11-02T09:15:00+08:00';
export const state = (patch: Partial<State> = {}): State => ({ ok: true, sha: 'a'.repeat(12), count: 0, fetchedAt: at, lastSuccessAt: at, sourceUpdatedAt: parseDgpa(none).updatedAt, writtenAt: at, ...patch });
export const index = (sources: Index['sources'], writer: Index['writer'] = 'worker'): Index => ({ v: 1, writer, heartbeatAt: at, sources });

// Synthetic structural empty probes; no authoritative empty sample exists upstream.
export const emptyJson = (updated = at) => JSON.stringify({ id: 'https://alerts.ncdr.nat.gov.tw/Json.aspx', title: 'NCDR', author: { name: 'NCDR' }, updated, entry: [] });
export const emptyAtom = (updated = at) => `<feed xmlns="http://www.w3.org/2005/Atom"><id>https://alerts.ncdr.nat.gov.tw/RssAtomFeeds.ashx</id><title>NCDR</title><author><name>NCDR</name></author><updated>${updated}</updated></feed>`;
