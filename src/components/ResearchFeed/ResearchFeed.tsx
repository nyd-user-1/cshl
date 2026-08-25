import { useResearchFeed } from "@/hooks/useResearchFeed";
import { FeedHeader } from "./FeedHeader";
import { FeedItem } from "./FeedItem";
import { PapersList } from "./PapersList";

/** What the panel is showing. Same shell, same width, same open/close. */
export type FeedMode = "activity" | "papers";

interface ResearchFeedProps {
  isOpen: boolean;
  /** `activity` is the live feed; `papers` is the newest preprints, draggable. */
  mode?: FeedMode;
  onClose?: () => void;
}

export function ResearchFeed({ isOpen, mode = "activity", onClose: _onClose }: ResearchFeedProps) {
  const { events } = useResearchFeed();
  const papers = mode === "papers";

  return (
    <aside
      className={`${
        isOpen ? "w-[300px]" : "w-0"
      } flex-shrink-0 transition-all duration-200 ease-in-out fixed inset-y-0 right-0 z-50 md:relative md:inset-auto md:z-auto ${
        isOpen ? "overflow-visible" : "overflow-hidden"
      }`}
    >
      <div className="w-[300px] h-full flex flex-col bg-background">
        <FeedHeader label={papers ? "Papers" : "Live Feed"} />

        <div className="flex-1 overflow-y-auto">
          {papers ? (
            // Mounted only while open, so closing the panel drops the rows and
            // reopening re-reads the (edge-cached) endpoint.
            isOpen && <PapersList />
          ) : events.length === 0 ? (
            <p className="px-4 py-8 text-xs text-muted-foreground text-center">
              Activity will appear here as you explore
            </p>
          ) : (
            events.map((event) => <FeedItem key={event.id} event={event} />)
          )}
        </div>
      </div>
    </aside>
  );
}
