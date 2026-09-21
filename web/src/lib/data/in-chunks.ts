/**
 * Batching for PostgREST `.in(...)` filters.
 *
 * A PostgREST `.in()` becomes a query *string* — `id=in.(uuid,uuid,…)` — so an
 * id list is request-line length, not a request body. Cloudflare sits in front
 * of Supabase and caps a request URL at roughly 16 KB; past that it answers
 * `520` (sometimes `400`) without ever reaching PostgREST, and some requests
 * never come back at all. At ~37 bytes per UUID that ceiling arrives at about
 * 430 ids — which a dispatch board crosses quietly, months in, once enough
 * history has accumulated.
 *
 * That is not hypothetical: `getLoads()` flattened every stop of every load
 * ever run into one filter, reached a 60 KB query string, and took the whole
 * dashboard down with 300-second function timeouts.
 *
 * So: never pass an unbounded list to `.in()`. Pass it through here.
 */

/**
 * Ids per request. 100 UUIDs is ~3.7 KB of query string — comfortably inside
 * the limit with room for the rest of the URL, and few enough round trips that
 * batching costs nothing noticeable.
 */
export const IN_CHUNK_SIZE = 100;

export function chunk<T>(items: readonly T[], size: number = IN_CHUNK_SIZE): T[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type QueryError = { message: string };
type ReadResult<Row> = { data: Row[] | null; error: QueryError | null };
type WriteResult = { error: QueryError | null };

/**
 * Runs `read` once per chunk and concatenates the rows.
 *
 * Bails on the first error rather than returning a half-read set, because a
 * partial read here reads as "no notification was ever sent for this stop" —
 * which is exactly the kind of wrong answer that deletes delivery evidence.
 *
 * Sequential on purpose: PostgREST's connection pool is 10, and a wide list
 * fanned out in parallel is how a read turns into a self-inflicted outage.
 */
export async function selectInChunks<Row>(
  values: readonly string[],
  read: (batch: string[]) => PromiseLike<ReadResult<Row>>,
  size: number = IN_CHUNK_SIZE,
): Promise<ReadResult<Row>> {
  if (values.length === 0) return { data: [], error: null };
  const rows: Row[] = [];
  for (const batch of chunk(values, size)) {
    const { data, error } = await read(batch);
    if (error) return { data: null, error };
    if (data) rows.push(...data);
  }
  return { data: rows, error: null };
}

/**
 * Runs `write` once per chunk, stopping at the first error.
 *
 * Note this is **not** atomic — an error on the third chunk leaves the first
 * two applied. Every caller here is idempotent (a status set to the same
 * value, a delete of rows already gone), so a retry settles it; anything that
 * is not idempotent needs an RPC and a real transaction instead.
 */
export async function mutateInChunks(
  values: readonly string[],
  write: (batch: string[]) => PromiseLike<WriteResult>,
  size: number = IN_CHUNK_SIZE,
): Promise<WriteResult> {
  for (const batch of chunk(values, size)) {
    const { error } = await write(batch);
    if (error) return { error };
  }
  return { error: null };
}
