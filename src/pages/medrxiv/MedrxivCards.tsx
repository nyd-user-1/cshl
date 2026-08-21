// /medrxiv/cards — the card catalog, the product's front door.
//
// One card per medRxiv category, generated from data (never hand-written):
// name + real paper count. The click IS the routing decision — selecting a
// card lands in a chat already confined to that room, never an unscoped one.
//
// Honest copy rule: a card is one encoder plus a scope. It is NEVER described
// as a separately trained model.
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMedrxivRooms } from "@/hooks/useMedrxivRooms";

const fmt = (n: number) => n.toLocaleString("en-US");

export default function MedrxivCards() {
  const navigate = useNavigate();
  const { data: rooms, isLoading, error } = useMedrxivRooms();

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-primary">medRxiv rooms</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {rooms ? `${rooms.length} rooms` : "Rooms"} — pick one and ask. Every
          question in a room searches only that room&apos;s preprints.
        </p>
      </div>

      {error != null && (
        <p className="text-sm text-muted-foreground">
          The room list failed to load — reload the page to retry.
        </p>
      )}

      {isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {rooms && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rooms.map((room) => (
            <button
              key={room.value}
              onClick={() => navigate(`/medrxiv/rooms/${encodeURIComponent(room.value)}`)}
              onMouseEnter={() => { import("@/pages/Chat"); }}
              className="text-left"
            >
              <Card className="h-full transition-colors hover:border-brand/40 hover:bg-muted/50">
                <CardContent className="p-4">
                  <h2 className="text-[11px] font-semibold uppercase tracking-wide text-brand">
                    {room.value}
                  </h2>
                  <p className="mt-1 text-sm text-foreground">
                    Searches {fmt(room.record_count)} {room.value} preprints
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Ask inside this room — retrieval never leaves it without telling you.
                  </p>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
