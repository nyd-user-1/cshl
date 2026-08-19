// /api/community — saved views, discussions, issues. Community-owned: no auth
// by design; authorship is a display name the client sends. Everything public.
//
//   GET  ?tab=views | threads | issues          → lists (threads include posts)
//   GET  ?tab=view&id=N                          → one saved view (with state)
//   POST {kind:"view", name, description, saved_by, state}
//   POST {kind:"thread", title, author, entity_ref, body}
//   POST {kind:"post", thread_id, author, body}
//   POST {kind:"issue", title, body, severity, assignee, entity_ref, author}
//   POST {kind:"issue_status", id, status, assignee?}

import { neon } from "@neondatabase/serverless";

export const config = { maxDuration: 15 };

const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n).trim();

export default async function handler(req: any, res: any) {
  const sql = neon(process.env.DATABASE_URL!);
  const q = (text: string, params: unknown[] = []) =>
    (sql as unknown as { query: (t: string, p: unknown[]) => Promise<Record<string, unknown>[]> }).query(text, params);

  try {
    if (req.method === "GET") {
      const tab = req.query?.tab;
      if (tab === "views") {
        const rows = await q(`SELECT id, name, description, saved_by, created_at, state FROM workspace_views ORDER BY created_at DESC LIMIT 100`);
        return res.status(200).json({ views: rows });
      }
      if (tab === "view") {
        const rows = await q(`SELECT id, name, description, saved_by, state, created_at FROM workspace_views WHERE id = $1`, [req.query?.id]);
        if (!rows[0]) return res.status(404).json({ error: "not found" });
        return res.status(200).json({ view: rows[0] });
      }
      if (tab === "threads") {
        const [threads, posts] = await Promise.all([
          q(`SELECT id, title, author, entity_ref, created_at FROM community_threads ORDER BY created_at DESC LIMIT 100`),
          q(`SELECT id, thread_id, author, body, created_at FROM community_posts ORDER BY created_at ASC LIMIT 1000`),
        ]);
        return res.status(200).json({ threads, posts });
      }
      if (tab === "issues") {
        const rows = await q(`SELECT id, title, body, status, severity, assignee, entity_ref, created_at, updated_at FROM community_issues ORDER BY (status = 'resolved'), severity, updated_at DESC LIMIT 200`);
        return res.status(200).json({ issues: rows });
      }
      return res.status(400).json({ error: "unknown tab" });
    }

    if (req.method === "POST") {
      const b = req.body ?? {};
      const author = clip(b.author ?? b.saved_by, 60) || "anonymous";
      if (b.kind === "view") {
        if (!b.state || !clip(b.name, 120)) return res.status(400).json({ error: "name and state required" });
        const rows = await q(
          `INSERT INTO workspace_views (name, description, saved_by, state) VALUES ($1, $2, $3, $4) RETURNING id`,
          [clip(b.name, 120), clip(b.description, 500) || null, author, JSON.stringify(b.state)]);
        return res.status(200).json({ id: rows[0].id });
      }
      if (b.kind === "thread") {
        if (!clip(b.title, 200)) return res.status(400).json({ error: "title required" });
        const t = await q(`INSERT INTO community_threads (title, author, entity_ref) VALUES ($1, $2, $3) RETURNING id`,
          [clip(b.title, 200), author, clip(b.entity_ref, 80) || null]);
        if (clip(b.body, 4000)) {
          await q(`INSERT INTO community_posts (thread_id, author, body) VALUES ($1, $2, $3)`, [t[0].id, author, clip(b.body, 4000)]);
        }
        return res.status(200).json({ id: t[0].id });
      }
      if (b.kind === "post") {
        if (!b.thread_id || !clip(b.body, 4000)) return res.status(400).json({ error: "thread_id and body required" });
        const rows = await q(`INSERT INTO community_posts (thread_id, author, body) VALUES ($1, $2, $3) RETURNING id`,
          [b.thread_id, author, clip(b.body, 4000)]);
        return res.status(200).json({ id: rows[0].id });
      }
      if (b.kind === "issue") {
        if (!clip(b.title, 200)) return res.status(400).json({ error: "title required" });
        const sev = Math.min(5, Math.max(1, Number(b.severity ?? 3)));
        const rows = await q(
          `INSERT INTO community_issues (title, body, severity, assignee, entity_ref) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [clip(b.title, 200), clip(b.body, 4000) || null, sev, clip(b.assignee, 60) || null, clip(b.entity_ref, 80) || null]);
        return res.status(200).json({ id: rows[0].id });
      }
      if (b.kind === "issue_status") {
        const status = ["new", "ack", "assigned", "resolved"].includes(b.status) ? b.status : null;
        if (!b.id || !status) return res.status(400).json({ error: "id and valid status required" });
        await q(`UPDATE community_issues SET status = $2, assignee = COALESCE(NULLIF($3, ''), assignee), updated_at = now() WHERE id = $1`,
          [b.id, status, clip(b.assignee, 60)]);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: "unknown kind" });
    }

    return res.status(405).json({ error: "GET/POST only" });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
