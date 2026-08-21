import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleDot, MessageSquare, Share2, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

/**
 * Community — the shared workspace surface. No accounts by design: every
 * saved view, thread, and issue is community-owned; authorship is a display
 * name. (Collaboration content is seeded with sample data.)
 */

interface ViewRow { id: number; name: string; description: string | null; saved_by: string; created_at: string; state?: { nodes?: { type: string }[] } }
interface ThreadRow { id: number; title: string; author: string; entity_ref: string | null; created_at: string }
interface PostRow { id: number; thread_id: number; author: string; body: string; created_at: string }
interface IssueRow {
  id: number; title: string; body: string | null; status: string; severity: number;
  assignee: string | null; entity_ref: string | null; updated_at: string;
}

const fetchTab = async <T,>(tab: string): Promise<T> => {
  const r = await fetch(`/api/community?tab=${tab}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

const post = async (body: Record<string, unknown>) => {
  const r = await fetch("/api/community", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
  return r.json();
};

const when = (s: string) => s.slice(0, 10);

const STATUS_STYLE: Record<string, string> = {
  new: "bg-muted text-foreground",
  ack: "bg-muted text-foreground",
  assigned: "bg-brand/15 text-brand",
  resolved: "bg-muted text-muted-foreground line-through",
};

function EntityChip({ entityRef }: { entityRef: string | null }) {
  const navigate = useNavigate();
  if (!entityRef) return null;
  const [type, id] = entityRef.split(":");
  const target =
    type === "chain" ? `/structure/${id}` : `/graph?center=${encodeURIComponent(entityRef)}`;
  return (
    <button onClick={() => navigate(target)}>
      <Badge variant="outline" className="font-mono text-[10px] hover:bg-muted">{entityRef}</Badge>
    </button>
  );
}

export default function Community() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState(() => localStorage.getItem("display-name") ?? "");
  const remember = (v: string) => { setName(v); localStorage.setItem("display-name", v); };

  const views = useQuery({ queryKey: ["community-views"], queryFn: () => fetchTab<{ views: ViewRow[] }>("views") });
  const threads = useQuery({ queryKey: ["community-threads"], queryFn: () => fetchTab<{ threads: ThreadRow[]; posts: PostRow[] }>("threads") });
  const issues = useQuery({ queryKey: ["community-issues"], queryFn: () => fetchTab<{ issues: IssueRow[] }>("issues") });

  const [openThread, setOpenThread] = useState<number | null>(null);
  const [reply, setReply] = useState("");
  const [newThreadTitle, setNewThreadTitle] = useState("");
  const [newThreadBody, setNewThreadBody] = useState("");
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueBody, setNewIssueBody] = useState("");
  const [newIssueSev, setNewIssueSev] = useState(3);

  const submit = (body: Record<string, unknown>, invalidate: string, done?: () => void) =>
    post({ ...body, author: name || "anonymous" })
      .then(() => { qc.invalidateQueries({ queryKey: [invalidate] }); done?.(); })
      .catch((e) => toast.error(e.message));

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary">Community</h1>
          <p className="mt-1 text-sm text-muted-foreground">Shared views, discussions, and open issues. No accounts — sign your work.</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <User className="h-3.5 w-3.5" />
          <Input value={name} onChange={(e) => remember(e.target.value)} placeholder="Display name" className="h-8 w-44 text-xs" />
        </label>
      </div>

      <Tabs defaultValue="views">
        <TabsList>
          <TabsTrigger value="views">Views</TabsTrigger>
          <TabsTrigger value="discussions">Discussions</TabsTrigger>
          <TabsTrigger value="issues">Issues</TabsTrigger>
        </TabsList>

        {/* ── saved views ─────────────────────────────────────────────────── */}
        <TabsContent value="views" className="mt-4">
          {views.isLoading ? <Skeleton className="h-32 w-full" /> : (
            <div className="grid gap-3 sm:grid-cols-2">
              {(views.data?.views ?? []).map((v) => (
                <Card key={v.id} className="cursor-pointer transition-colors hover:bg-muted/40" >
                  <CardContent className="p-4" onClick={() => navigate(`/graph?view=${v.id}`)}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">{v.name}</p>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {v.state?.nodes?.some((n) => n.type === "prompt") && (
                          <Badge variant="brand" className="text-[9px]">recipe</Badge>
                        )}
                        <Share2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </span>
                    </div>
                    {v.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{v.description}</p>}
                    <p className="mt-2 text-[11px] text-muted-foreground">{v.saved_by} · {when(v.created_at)}</p>
                  </CardContent>
                </Card>
              ))}
              {(views.data?.views ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">No saved views yet — build one on the <button className="text-brand hover:underline" onClick={() => navigate("/graph")}>graph</button> and hit Save.</p>
              )}
            </div>
          )}
        </TabsContent>

        {/* ── discussions ─────────────────────────────────────────────────── */}
        <TabsContent value="discussions" className="mt-4 space-y-3">
          <Card>
            <CardContent className="space-y-2 p-4">
              <Input value={newThreadTitle} onChange={(e) => setNewThreadTitle(e.target.value)} placeholder="Start a discussion — title" className="h-8 text-xs" />
              <Input value={newThreadBody} onChange={(e) => setNewThreadBody(e.target.value)} placeholder="First post (optional)" className="h-8 text-xs" />
              <Button size="sm" className="h-7 text-xs" disabled={!newThreadTitle.trim()}
                onClick={() => submit({ kind: "thread", title: newThreadTitle, body: newThreadBody }, "community-threads", () => { setNewThreadTitle(""); setNewThreadBody(""); })}>
                Post
              </Button>
            </CardContent>
          </Card>
          {threads.isLoading ? <Skeleton className="h-40 w-full" /> : (threads.data?.threads ?? []).map((t) => {
            const posts = (threads.data?.posts ?? []).filter((p) => p.thread_id === t.id);
            const open = openThread === t.id;
            return (
              <Card key={t.id}>
                <CardContent className="p-4">
                  <button className="flex w-full items-start justify-between gap-2 text-left" onClick={() => setOpenThread(open ? null : t.id)}>
                    <div>
                      <p className="text-sm font-medium text-foreground">{t.title}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{t.author} · {when(t.created_at)} · {posts.length} repl{posts.length === 1 ? "y" : "ies"}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <EntityChip entityRef={t.entity_ref} />
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </button>
                  {open && (
                    <div className="mt-3 space-y-2 border-t pt-3">
                      {posts.map((p) => (
                        <div key={p.id} className="rounded-md bg-muted/30 px-3 py-2">
                          <p className="text-xs text-foreground">{p.body}</p>
                          <p className="mt-1 text-[10px] text-muted-foreground">{p.author} · {when(p.created_at)}</p>
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <Input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" className="h-8 text-xs" />
                        <Button size="sm" className="h-8 text-xs" disabled={!reply.trim()}
                          onClick={() => submit({ kind: "post", thread_id: t.id, body: reply }, "community-threads", () => setReply(""))}>
                          Reply
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </TabsContent>

        {/* ── issues ──────────────────────────────────────────────────────── */}
        <TabsContent value="issues" className="mt-4 space-y-3">
          <Card>
            <CardContent className="space-y-2 p-4">
              <Input value={newIssueTitle} onChange={(e) => setNewIssueTitle(e.target.value)} placeholder="Report an issue — title" className="h-8 text-xs" />
              <Input value={newIssueBody} onChange={(e) => setNewIssueBody(e.target.value)} placeholder="Details (optional)" className="h-8 text-xs" />
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-muted-foreground">Severity</label>
                <select value={newIssueSev} onChange={(e) => setNewIssueSev(Number(e.target.value))}
                  className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground">
                  {[1, 2, 3, 4, 5].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <Button size="sm" className="h-7 text-xs" disabled={!newIssueTitle.trim()}
                  onClick={() => submit({ kind: "issue", title: newIssueTitle, body: newIssueBody, severity: newIssueSev }, "community-issues", () => { setNewIssueTitle(""); setNewIssueBody(""); })}>
                  File issue
                </Button>
              </div>
            </CardContent>
          </Card>
          {issues.isLoading ? <Skeleton className="h-40 w-full" /> : (
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Issue</th>
                    <th className="hidden px-3 py-2 font-medium sm:table-cell">Entity</th>
                    <th className="px-3 py-2 font-medium">Severity</th>
                    <th className="px-3 py-2 font-medium">Assignee</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(issues.data?.issues ?? []).map((i) => (
                    <tr key={i.id} className="border-b last:border-0">
                      <td className="px-3 py-2">
                        <div className="flex items-start gap-1.5">
                          <CircleDot className={`mt-0.5 h-3 w-3 shrink-0 ${i.status === "resolved" ? "text-muted-foreground" : "text-brand"}`} />
                          <div>
                            <p className="text-xs font-medium text-foreground">{i.title}</p>
                            {i.body && <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{i.body}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-3 py-2 sm:table-cell"><EntityChip entityRef={i.entity_ref} /></td>
                      <td className="px-3 py-2"><Badge variant={i.severity <= 2 ? "brand" : "secondary"} className="text-[10px]">S{i.severity}</Badge></td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{i.assignee ?? "—"}</td>
                      <td className="px-3 py-2">
                        <select
                          value={i.status}
                          onChange={(e) => submit({ kind: "issue_status", id: i.id, status: e.target.value, assignee: e.target.value === "assigned" ? name : "" }, "community-issues")}
                          className={`h-6 rounded-md border border-input px-1.5 text-[11px] ${STATUS_STYLE[i.status] ?? "bg-background text-foreground"}`}
                        >
                          {["new", "ack", "assigned", "resolved"].map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
