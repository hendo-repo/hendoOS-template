/** Operational state only. Content/config remain plain text outside SQLite. */
import { Database } from 'bun:sqlite';
import type { RuntimeOutcome, Receipt } from '../protocols/service';
export interface SessionPin { generation: number; contentDigest: string; configRevision: string; configDigest: string; checkerRevision: string; sourceRevision: string }
export class StateConflict extends Error {}
export class ReplayInterrupted extends Error {}
export const RECEIPT_MAX_BYTES = 16 * 1024;
export const RECEIPT_RETENTION_PER_SESSION = 100;
export class StateStore {
  private db: Database;
  constructor(path: string) {
    if (!path || path === ':memory:') throw new Error('explicit persistent state path required');
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS sessions(owner TEXT NOT NULL, session TEXT NOT NULL, pin TEXT NOT NULL, PRIMARY KEY(owner,session));
      CREATE TABLE IF NOT EXISTS outcomes(owner TEXT NOT NULL, session TEXT NOT NULL, request TEXT NOT NULL,
        digest TEXT NOT NULL, outcome TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(owner,session,request));`);
  }
  /** The pin check precedes replay. Outcome and receipt commit in one transaction. */
  transact(owner: string, session: string, request: string, digest: string, pin: SessionPin, produce: () => RuntimeOutcome, canReplay: () => boolean = () => true): RuntimeOutcome {
    return this.db.transaction(() => {
      const encodedPin = JSON.stringify(pin);
      const existing = this.db.query('SELECT pin FROM sessions WHERE owner=? AND session=?').get(owner, session) as { pin: string } | null;
      if (existing && existing.pin !== encodedPin) throw new StateConflict('session generation/config skew');
      const prior = this.db.query('SELECT digest,outcome FROM outcomes WHERE owner=? AND session=? AND request=?').get(owner, session, request) as { digest: string; outcome: string } | null;
      if (prior) {
        if (prior.digest !== digest) throw new StateConflict('request ID reused with changed payload');
        if (!canReplay()) throw new ReplayInterrupted('replay cancelled or deadline exceeded');
        return JSON.parse(prior.outcome) as RuntimeOutcome;
      }
      const result = produce();
      if (!result.receipt) throw new Error('atomic outcome requires receipt');
      const encodedOutcome = JSON.stringify(result);
      const encodedReceipt = JSON.stringify(result.receipt);
      if (Buffer.byteLength(encodedReceipt) > RECEIPT_MAX_BYTES) throw new Error('receipt exceeds storage bound');
      if (!existing) this.db.query('INSERT INTO sessions VALUES(?,?,?)').run(owner, session, encodedPin);
      this.db.query('INSERT INTO outcomes VALUES(?,?,?,?,?,?)').run(owner, session, request, digest, encodedOutcome, encodedReceipt);
      const count = this.db.query('SELECT COUNT(*) AS count FROM outcomes WHERE owner=? AND session=?')
        .get(owner, session) as { count: number };
      if (count.count > RECEIPT_RETENTION_PER_SESSION) {
        // Prefer evicting the oldest resolved record. Incomplete/refused evidence
        // survives while resolved evidence exists, subject to the same hard cap.
        this.db.query(`DELETE FROM outcomes WHERE rowid=(SELECT rowid FROM outcomes WHERE owner=? AND session=?
          ORDER BY CASE WHEN json_extract(outcome,'$.status')='complete' THEN 0 ELSE 1 END, rowid ASC LIMIT 1)`)
          .run(owner, session);
      }
      return result;
    }).immediate();
  }
  receipts(owner: string, session: string, limit = 100): Receipt[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('receipt limit must be 1..100');
    const rows = this.db.query('SELECT receipt FROM outcomes WHERE owner=? AND session=? ORDER BY rowid DESC LIMIT ?').all(owner, session, limit) as { receipt: string }[];
    return rows.map(row => JSON.parse(row.receipt) as Receipt);
  }
  close(): void { this.db.close(); }
}
