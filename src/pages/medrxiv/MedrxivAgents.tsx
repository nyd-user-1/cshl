// /medrxiv/agents — the rooms as a compact list of scoped assistants.
//
// Same 51 rooms as /medrxiv/cards, framed as one agent per room for people who
// think in assistants rather than catalogs. Honesty is structural: every agent
// is the SAME retrieval stack confined to one room — never presented as a
// separately trained model.
import { useNavigate } from "react-router-dom";
import { Bot, ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useMedrxivRooms } from "@/hooks/useMedrxivRooms";

const fmt = (n: number) => n.toLocaleString("en-US");

export default function MedrxivAgents() {
  const navigate = useNavigate();
  const { data: rooms, isLoading, error } = useMedrxivRooms();

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-primary">medRxiv agents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One assistant per room. Each is the same retrieval stack scoped to one
          category of medRxiv — not a separately trained model.
        </p>
      </div>

      {error != null && (
        <p className="text-sm text-muted-foreground">
          The agent list failed to load — reload the page to retry.
        </p>
      )}

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {rooms && (
        <div className="divide-y rounded-lg border">
          {rooms.map((room) => (
            <button
              key={room.value}
              onClick={() => navigate(`/medrxiv/rooms/${encodeURIComponent(room.value)}`)}
              onMouseEnter={() => { import("@/pages/Chat"); }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
            >
              <Bot className="h-4 w-4 shrink-0 text-brand" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {room.value}
                </span>
                <span className="block text-xs text-muted-foreground">
                  answers from {fmt(room.record_count)} preprints in this room
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
