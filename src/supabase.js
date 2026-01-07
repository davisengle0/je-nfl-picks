import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export function normalizeName(first, last) {
  const f = (first || "").trim().toLowerCase();
  const l = (last || "").trim().toLowerCase();
  return `${f} ${l}`.trim();
}

export function fmtLocal(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString();
}
