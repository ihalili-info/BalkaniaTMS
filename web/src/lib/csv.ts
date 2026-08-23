/**
 * A small, correct CSV reader/writer.
 *
 * Deliberately not `text.split(",")`. Real order exports break that on the
 * first line: `"Station Road, Blarney, Co. Cork"` is one field, not three, and
 * Irish addresses are full of commas. Excel adds its own hazards — a UTF-8
 * BOM, CRLF endings, and a semicolon delimiter under several European locales.
 *
 * Follows RFC 4180: fields may be quoted, `""` is a literal quote inside a
 * quoted field, and a quoted field may contain the delimiter or a newline.
 */

/** Guard against a mis-picked file locking up the tab. */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_ROWS = 5_000;

export type Delimiter = "," | ";" | "\t" | "|";

const CANDIDATES: Delimiter[] = [",", ";", "\t", "|"];

/**
 * Picks the delimiter that yields the most consistent column count across the
 * first few lines — more reliable than counting occurrences, which a comma-rich
 * address column would win outright in a semicolon-separated file.
 */
export function detectDelimiter(text: string): Delimiter {
  const sample = stripBom(text).split(/\r?\n/).filter(Boolean).slice(0, 10);
  if (sample.length === 0) return ",";

  let best: Delimiter = ",";
  let bestScore = -1;

  for (const candidate of CANDIDATES) {
    const counts = sample.map(
      (line) => splitLineRespectingQuotes(line, candidate).length,
    );
    const columns = counts[0];
    if (columns < 2) continue;
    // Reward more columns, punish any line that disagrees with the header.
    const consistent = counts.every((n) => n === columns);
    const score = columns * (consistent ? 10 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Quote-aware split of a single line, used only for delimiter detection. */
function splitLineRespectingQuotes(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
  delimiter: Delimiter;
  /** Rows dropped because they exceeded MAX_CSV_ROWS. */
  truncated: number;
}

/**
 * Parses a whole document. Blank lines are skipped; short rows are padded and
 * long rows trimmed to the header width, so a ragged export still imports
 * rather than failing wholesale.
 */
export function parseCsv(input: string, delimiter?: Delimiter): CsvTable {
  const text = stripBom(input);
  const delim = delimiter ?? detectDelimiter(text);

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    // A trailing newline yields one empty field — not a row.
    if (record.length > 1 || record[0].trim() !== "") records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      endField();
    } else if (ch === "\r") {
      // Swallow CRLF as one break; a lone CR also ends the record.
      if (text[i + 1] === "\n") i++;
      endRecord();
    } else if (ch === "\n") {
      endRecord();
    } else {
      field += ch;
    }
  }
  // Whatever is left after the last newline.
  if (field !== "" || record.length > 0) endRecord();

  const [headerRow = [], ...dataRows] = records;
  const headers = headerRow.map((h) => h.trim());
  const width = headers.length;

  const kept = dataRows.slice(0, MAX_CSV_ROWS);
  const rows = kept
    .map((r) =>
      Array.from({ length: width }, (_, i) => (r[i] ?? "").trim()),
    )
    // Drop rows that are entirely empty — common at the end of Excel exports.
    .filter((r) => r.some((cell) => cell !== ""));

  return {
    headers,
    rows,
    delimiter: delim,
    truncated: Math.max(0, dataRows.length - kept.length),
  };
}

/** Quotes a field only when it needs it. */
function escapeField(value: string, delimiter: string): string {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r");
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][], delimiter: Delimiter = ","): string {
  return rows
    .map((row) => row.map((f) => escapeField(f, delimiter)).join(delimiter))
    .join("\r\n");
}

export const DELIMITER_LABEL: Record<Delimiter, string> = {
  ",": "Comma",
  ";": "Semicolon",
  "\t": "Tab",
  "|": "Pipe",
};
