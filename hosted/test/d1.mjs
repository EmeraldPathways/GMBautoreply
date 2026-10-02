import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function environment(extra = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const binding = {prepare(sql) {
    let params = [];
    return {
      bind(...values) {params = values; return this;},
      first() {return db.prepare(sql).get(...params) || null;},
      all() {return {results: db.prepare(sql).all(...params)};},
      run() {const r = db.prepare(sql).run(...params); return {meta: {changes: Number(r.changes)}};}
    };
  }};
  return {DB: binding, PUBLIC_BASE_URL: 'https://desk.example', SESSION_SECRET: 's'.repeat(48), ADMIN_PASSWORD: 'p'.repeat(40), TOKEN_KEY: Buffer.alloc(32, 8).toString('base64'), ...extra};
}
