import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/hooks/useTheme";
import { AppLayout } from "@/layouts/AppLayout";
import { Skeleton } from "@/components/ui/skeleton";

// Route-level code splitting: each page (and its heavy deps — KaTeX, Recharts,
// React Flow) loads on demand. The Sidebar prefetches chunks on hover, so by
// the time a click lands the code is usually already here.
const Chat = lazy(() => import("@/pages/Chat"));
const References = lazy(() => import("@/pages/References"));
const Resources = lazy(() => import("@/pages/Resources"));
const Search = lazy(() => import("@/pages/Search"));
const Features = lazy(() => import("@/pages/Features"));
const CodePage = lazy(() => import("@/pages/CodePage"));
/** /structure/:a → /ensdf/:a (old bookmarks and graph links). */


/** /ensdf/148 → mass chain · /ensdf/148Gd → nuclide datasets · /ensdf/Gd → element datasets (one param, three pages). */
const Community = lazy(() => import("@/pages/Community"));
const Announcing = lazy(() => import("@/pages/Announcing"));
const Models = lazy(() => import("@/pages/Models"));

// The archive sections: each archive (medRxiv, bioRxiv) has three sub-pages —
// Agents (one scoped assistant per subject), Papers (the References browser
// confined to that archive), Subjects (the MeSH-backed subject catalog).
// /:archive/agents/:category is the scoped chat.
const SubjectsPage = lazy(() => import("@/pages/archive/SubjectsPage"));
const AgentsPage = lazy(() => import("@/pages/archive/AgentsPage"));

const queryClient = new QueryClient();

function PageFallback() {
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 md:px-8">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/" element={<Chat />} />
                <Route path="/new-chat" element={<Chat />} />
                <Route path="/c/:sessionId" element={<Chat />} />
                {/* /references is the corpus browser; /nsr redirects for NSR-era links */}
                <Route path="/references" element={<References />} />
                <Route path="/nsr" element={<Navigate to="/references" replace />} />
                {/* the archive sections — Agents · Papers · Subjects, per archive */}
                <Route path="/medrxiv" element={<Navigate to="/medrxiv/subjects" replace />} />
                <Route path="/medrxiv/subjects" element={<SubjectsPage key="medrxiv-subjects" server="medrxiv" />} />
                <Route path="/medrxiv/agents" element={<AgentsPage key="medrxiv-agents" server="medrxiv" />} />
                <Route path="/medrxiv/agents/:category" element={<Chat />} />
                <Route path="/medrxiv/papers" element={<References key="medrxiv-papers" server="medrxiv" />} />
                <Route path="/biorxiv" element={<Navigate to="/biorxiv/subjects" replace />} />
                <Route path="/biorxiv/subjects" element={<SubjectsPage key="biorxiv-subjects" server="biorxiv" />} />
                <Route path="/biorxiv/agents" element={<AgentsPage key="biorxiv-agents" server="biorxiv" />} />
                <Route path="/biorxiv/agents/:category" element={<Chat />} />
                <Route path="/biorxiv/papers" element={<References key="biorxiv-papers" server="biorxiv" />} />
                {/* pre-subjects URLs — old routes redirect or stay scoped, never 404 */}
                <Route path="/medrxiv/cards" element={<Navigate to="/medrxiv/subjects" replace />} />
                <Route path="/medrxiv/subjects/:category" element={<Chat />} />
                <Route path="/preprints" element={<Navigate to="/references" replace />} />
                <Route path="/preprints/cards" element={<Navigate to="/medrxiv/subjects" replace />} />
                <Route path="/preprints/agents" element={<Navigate to="/medrxiv/agents" replace />} />
                <Route path="/resources" element={<Resources />} />
                <Route path="/search" element={<Search />} />
                <Route path="/features" element={<Features />} />
                <Route path="/code" element={<CodePage />} />
                <Route path="/community" element={<Community />} />
                <Route path="/announcing" element={<Announcing />} />
                <Route path="/models" element={<Models />} />
              </Route>
            </Routes>
          </Suspense>
          <Toaster />
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
