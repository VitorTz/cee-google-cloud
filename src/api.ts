import { sb } from "./supabase-client";

export interface Street {
  id: number;
  name: string;
  neighborhood: string[];
}

export interface NumberingRule {
  id: number;
  start_number: number | null;
  end_number: number | null;
  side: "odd" | "even" | "both";
  description: string | null;
}

export interface ZipBreakdown {
  id: number;
  zip_code: string;
  numbering_rules: NumberingRule[];
}

async function authorizedGet<T>(path: string): Promise<T> {
  const { data: { session }, error } = await sb.auth.getSession();
  if (error || !session?.access_token) {
    throw new Error("Sua sessão expirou. Entre novamente.");
  }
  const response = await fetch(path, {
    method: "GET",
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sua sessão expirou. Entre novamente.");
    throw new Error(`Falha na consulta (HTTP ${response.status}).`);
  }
  return (await response.json()) as T;
}

export function searchStreets(term: string, limit = 8): Promise<Street[]> {
  if (!term.trim()) return Promise.resolve([]);
  return authorizedGet<Street[]>(`/api/streets/search?${new URLSearchParams({ term, limit: String(limit) })}`);
}

export function loadStreetZips(streetId: number): Promise<ZipBreakdown[]> {
  return authorizedGet<ZipBreakdown[]>(`/api/streets/${encodeURIComponent(streetId)}/zips`);
}
