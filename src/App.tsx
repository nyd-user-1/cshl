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
