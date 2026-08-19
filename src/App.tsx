import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
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
const Endf = lazy(() => import("@/pages/Endf"));
const Search = lazy(() => import("@/pages/Search"));
const Features = lazy(() => import("@/pages/Features"));
const Structure = lazy(() => import("@/pages/Structure"));
const DatasetIndex = lazy(() => import("@/pages/DatasetIndex"));
const StructureMass = lazy(() => import("@/pages/StructureMass"));
const GraphPage = lazy(() => import("@/pages/GraphPage"));
const Tools = lazy(() => import("@/pages/Tools"));
const CodePage = lazy(() => import("@/pages/CodePage"));
const EnsdfAbout = lazy(() => import("@/pages/ensdf/About"));
const EnsdfHelp = lazy(() => import("@/pages/ensdf/Help"));
const EnsdfEvaluation = lazy(() => import("@/pages/ensdf/Evaluation"));
const EnsdfDocs = lazy(() => import("@/pages/ensdf/Docs"));
/** /structure/:a → /ensdf/:a (old bookmarks and graph links). */
function RedirectMass({ base }: { base: string }) {
  const { a } = useParams();
  return <Navigate to={`${base}/${a}`} replace />;
}

const NsrArchive = lazy(() => import("@/pages/nsr/Archive"));
const XundlArchive = lazy(() => import("@/pages/xundl/Archive"));
const XundlAbout = lazy(() => import("@/pages/xundl/About"));
const NuclidePage = lazy(() => import("@/pages/structure/Nuclide"));
const DatasetRefsPage = lazy(() => import("@/pages/structure/DatasetRefs"));
const ElementPage = lazy(() => import("@/pages/structure/Element"));

/** /ensdf/148 → mass chain · /ensdf/148Gd → nuclide datasets · /ensdf/Gd → element datasets (one param, three pages). */
function ChainOrNuclide() {
  const { a } = useParams();
  if (/^\d+$/.test(a ?? "")) return <StructureMass />;
  if (/^[A-Za-z]{1,2}$/.test(a ?? "")) return <ElementPage />;
  return <NuclidePage />;
}
const EnsdfArchive = lazy(() => import("@/pages/ensdf/Archive"));
const Community = lazy(() => import("@/pages/Community"));

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
                {/* /nsr is the NSR index (the References page); /references redirects for old links */}
                <Route path="/nsr" element={<References />} />
                <Route path="/references" element={<Navigate to="/nsr" replace />} />
                <Route path="/resources" element={<Resources />} />
                <Route path="/endf" element={<Endf />} />
                <Route path="/search" element={<Search />} />
                <Route path="/features" element={<Features />} />
                {/* /ensdf and /xundl are dataset-card index pages (the /endf layout);
                    the chart-of-nuclides landings moved to /…/chart. /structure* redirects for old links */}
                <Route path="/ensdf" element={<DatasetIndex variant="ensdf" />} />
                <Route path="/xundl" element={<DatasetIndex variant="xundl" />} />
                <Route path="/ensdf/chart" element={<Structure variant="ensdf" />} />
                <Route path="/xundl/chart" element={<Structure variant="xundl" />} />
                <Route path="/structure" element={<Navigate to="/ensdf/chart" replace />} />
                <Route path="/structure/:a" element={<RedirectMass base="/ensdf" />} />
                <Route path="/graph" element={<GraphPage />} />
                <Route path="/graph/:a" element={<GraphPage />} />
                <Route path="/tools" element={<Tools />} />
                <Route path="/code" element={<CodePage />} />
                <Route path="/ensdf/about" element={<EnsdfAbout />} />
                <Route path="/ensdf/help" element={<EnsdfHelp />} />
                <Route path="/ensdf/evaluation" element={<EnsdfEvaluation />} />
                <Route path="/ensdf/docs" element={<EnsdfDocs />} />
                <Route path="/ensdf/archive" element={<EnsdfArchive />} />
                <Route path="/ensdf/datasets" element={<Navigate to="/ensdf/archive" replace />} />
                <Route path="/ensdf/:a" element={<ChainOrNuclide />} />
                <Route path="/ensdf/:a/refs" element={<DatasetRefsPage />} />
                <Route path="/xundl/about" element={<XundlAbout />} />
                <Route path="/xundl/archive" element={<XundlArchive />} />
                <Route path="/xundl/:a" element={<ChainOrNuclide />} />
                <Route path="/xundl/:a/refs" element={<DatasetRefsPage />} />
                <Route path="/nsr/archive" element={<NsrArchive />} />
                <Route path="/nsr/datasets" element={<Navigate to="/nsr/archive" replace />} />
                <Route path="/community" element={<Community />} />
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
