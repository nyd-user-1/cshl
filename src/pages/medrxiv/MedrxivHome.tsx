// /medrxiv — the bucket landing (LANE-MEDRXIV-ROOMS Task 2).
//
// The product thesis (SMALL-WORLDS): retrieval is good over the whole corpus
// and absurdly good over small coherent subsets, so every query is scoped
// BEFORE it is typed. This page routes to the two front doors — the card
// catalog and the agents list — and has no input of its own. There are no
// bare inputs anywhere in the product.
//
// /biorxiv is deliberately not built tonight; the routing shape leaves room.
import { useNavigate } from "react-router-dom";
import { LayoutGrid, Bot, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatGrid } from "@/pages/templates/CardPage";
import { useMedrxivRooms, useMedrxivCount } from "@/hooks/useMedrxivRooms";

const fmt = (n: number | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));

export default function MedrxivHome() {
  const navigate = useNavigate();
  const { data: rooms } = useMedrxivRooms();
  const { data: total } = useMedrxivCount();
  const largest = rooms?.[0];

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-primary">medRxiv</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Clinical and health preprints, organized into rooms. Pick a room; every
          question you ask there is already scoped to it.
        </p>
      </div>

      <StatGrid
        stats={[
          ["Preprints", fmt(total)],
          ["Rooms", rooms ? String(rooms.length) : "—"],
          ["Largest room", largest ? `${largest.value} · ${fmt(largest.record_count)}` : "—"],
        ]}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          onClick={() => navigate("/medrxiv/cards")}
          onMouseEnter={() => { import("@/pages/medrxiv/MedrxivCards"); }}
          className="text-left"
        >
          <Card className="h-full transition-colors hover:bg-muted/50">
            <CardContent className="p-4">
              <div className="mb-1 flex items-center gap-2">
                <LayoutGrid className="h-4 w-4 text-brand" />
                <h2 className="text-sm font-semibold text-foreground">Cards</h2>
                <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground">
                The catalog — one card per room, with its real paper count.
                Selecting a card lands you in that room&apos;s chat.
              </p>
            </CardContent>
          </Card>
        </button>
        <button
          onClick={() => navigate("/medrxiv/agents")}
          onMouseEnter={() => { import("@/pages/medrxiv/MedrxivAgents"); }}
          className="text-left"
        >
          <Card className="h-full transition-colors hover:bg-muted/50">
            <CardContent className="p-4">
              <div className="mb-1 flex items-center gap-2">
                <Bot className="h-4 w-4 text-brand" />
                <h2 className="text-sm font-semibold text-foreground">Agents</h2>
                <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground">
                The same rooms as a compact list — one scoped assistant per room.
                Same retrieval stack, confined to one room each.
              </p>
            </CardContent>
          </Card>
        </button>
      </div>
    </div>
  );
}
