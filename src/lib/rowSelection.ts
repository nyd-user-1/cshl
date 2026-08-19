import { useState } from "react";

/** Shared checkbox-column helpers for the /ensdf table standard (TableCard). */
export const useRowSelection = (keys: string[]) => {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const allChecked = keys.length > 0 && keys.every((k) => sel.has(k));
  const toggleRow = (k: string) => setSel((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next; });
  const toggleAll = () => setSel((prev) => { const next = new Set(prev); if (allChecked) keys.forEach((k) => next.delete(k)); else keys.forEach((k) => next.add(k)); return next; });
  return { sel, allChecked, toggleRow, toggleAll };
};
