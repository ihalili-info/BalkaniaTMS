"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Icon, Table, Td, Th, Tr, cx } from "@/components/ui";
import {
  DELIMITER_LABEL,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  parseCsv,
  toCsv,
  type CsvTable,
  type Delimiter,
} from "@/lib/csv";
import {
  IMPORT_FIELDS,
  autoMap,
  summarise,
  templateRows,
  validateRows,
  type FieldId,
  type ParsedRow,
} from "@/lib/orders-import";
import type { Order } from "@/lib/types";

type Stage = "pick" | "map";

export function ImportDialog({
  existingRefs,
  now,
  onImport,
  onClose,
}: {
  existingRefs: Set<string>;
  now: Date;
  onImport: (orders: Order[]) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>("pick");
  const [fileName, setFileName] = useState("");
  const [table, setTable] = useState<CsvTable | null>(null);
  const [mapping, setMapping] = useState<Record<FieldId, number | null> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const accept = async (file: File) => {
    setError(null);
    if (file.size > MAX_CSV_BYTES) {
      setError(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_CSV_BYTES / 1024 / 1024} MB — split it, or wait for the CRM sync.`,
      );
      return;
    }

    const text = await file.text();
    const parsed = parseCsv(text);

    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      setError("No rows found. The first line must be a header row.");
      return;
    }

    setFileName(file.name);
    setTable(parsed);
    setMapping(autoMap(parsed.headers));
    setStage("map");
  };

  const reparse = (delimiter: Delimiter) => {
    if (!table) return;
    // Re-reading the file would be cleaner, but the picked File is gone once
    // the dialog re-renders; re-joining is exact because `toCsv` round-trips.
    const raw = toCsv([table.headers, ...table.rows], table.delimiter);
    const next = parseCsv(raw, delimiter);
    setTable(next);
    setMapping(autoMap(next.headers));
  };

  const parsedRows: ParsedRow[] = useMemo(() => {
    if (!table || !mapping) return [];
    return validateRows(table.rows, mapping, { existingRefs, now });
  }, [table, mapping, existingRefs, now]);

  const summary = useMemo(() => summarise(parsedRows), [parsedRows]);

  const downloadTemplate = () => {
    const blob = new Blob(["﻿" + toCsv(templateRows())], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "balkania-orders-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const commit = () => {
    const orders = parsedRows
      .map((r) => r.order)
      .filter((o): o is Order => o !== null);
    onImport(orders);
  };

  const unmappedRequired = IMPORT_FIELDS.filter(
    (f) => f.required && mapping?.[f.id] === null,
  );

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import orders from CSV"
        className="fixed inset-x-4 top-[4vh] z-50 mx-auto flex max-h-[92vh] max-w-4xl flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
          <div>
            <p className="font-mono text-label uppercase text-ink-subtle">
              Orders Queue
            </p>
            <h2 className="text-title text-ink">Import orders from CSV</h2>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              A stand-in until the CRM webhook is built. Same fields, same
              rules — orders land as <strong>pending</strong>, ready to assign.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <Icon name="close" className="text-[20px]" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {stage === "pick" ? (
            <>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const file = e.dataTransfer.files[0];
                  if (file) void accept(file);
                }}
                className={cx(
                  "flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors",
                  dragging
                    ? "border-brand bg-brand-soft"
                    : "border-hairline-strong bg-surface-muted",
                )}
              >
                <Icon
                  name="upload_file"
                  className="mb-3 text-[32px] text-ink-subtle"
                />
                <p className="text-heading text-ink">
                  Drop a CSV here, or choose a file
                </p>
                <p className="mt-1 max-w-md text-body-sm text-ink-muted">
                  Comma, semicolon or tab separated. Quoted fields with commas
                  inside are handled — up to {MAX_CSV_ROWS.toLocaleString("en-GB")} rows.
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    variant="primary"
                    icon="folder_open"
                    onClick={() => inputRef.current?.click()}
                  >
                    Choose file
                  </Button>
                  <Button icon="download" onClick={downloadTemplate}>
                    Download template
                  </Button>
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void accept(file);
                    e.target.value = "";
                  }}
                />
              </div>

              {error ? (
                <p className="mt-4 flex items-start gap-2 rounded-sm border border-danger-border bg-danger-soft px-3 py-2 text-body-sm text-danger">
                  <Icon name="error" className="mt-px text-[17px]" />
                  {error}
                </p>
              ) : null}

              <div className="mt-6">
                <p className="mb-2 font-mono text-label uppercase text-ink-subtle">
                  Columns
                </p>
                <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                  {IMPORT_FIELDS.map((field) => (
                    <li key={field.id} className="flex items-start gap-2">
                      <Icon
                        name={field.required ? "check_circle" : "circle"}
                        className={cx(
                          "mt-0.5 text-[15px]",
                          field.required ? "text-brand" : "text-ink-subtle",
                        )}
                      />
                      <span className="min-w-0">
                        <span className="text-body-sm text-ink">
                          {field.label}
                          {field.required ? null : (
                            <span className="ml-1 text-ink-subtle">optional</span>
                          )}
                        </span>
                        <span className="block text-caption text-ink-subtle">
                          {field.hint}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <>
              <div className="mb-5 flex flex-wrap items-center gap-3 rounded-sm border border-hairline bg-surface-muted px-3 py-2">
                <Icon name="description" className="text-[18px] text-ink-subtle" />
                <span className="text-body-sm text-ink">{fileName}</span>
                <span className="font-mono text-data-sm text-ink-subtle">
                  {table?.rows.length} rows · {table?.headers.length} columns
                </span>
                <label className="ml-auto flex items-center gap-2">
                  <span className="font-mono text-label uppercase text-ink-subtle">
                    Separator
                  </span>
                  <select
                    value={table?.delimiter}
                    onChange={(e) => reparse(e.target.value as Delimiter)}
                    className="h-8 rounded-sm border border-hairline bg-surface px-2 text-body-sm text-ink outline-none focus:border-brand"
                  >
                    {(Object.keys(DELIMITER_LABEL) as Delimiter[]).map((d) => (
                      <option key={d} value={d}>
                        {DELIMITER_LABEL[d]}
                      </option>
                    ))}
                  </select>
                </label>
                <Button icon="restart_alt" onClick={() => setStage("pick")}>
                  Different file
                </Button>
              </div>

              <p className="mb-2 font-mono text-label uppercase text-ink-subtle">
                Match your columns
              </p>
              <ul className="mb-5 grid gap-2 sm:grid-cols-2">
                {IMPORT_FIELDS.map((field) => {
                  const value = mapping?.[field.id] ?? null;
                  const missing = field.required && value === null;
                  return (
                    <li
                      key={field.id}
                      className={cx(
                        "flex items-center gap-2 rounded-sm border px-2.5 py-1.5",
                        missing
                          ? "border-danger-border bg-danger-soft"
                          : "border-hairline",
                      )}
                    >
                      <span className="w-32 shrink-0 text-body-sm text-ink">
                        {field.label}
                        {field.required ? (
                          <span className="ml-0.5 text-danger">*</span>
                        ) : null}
                      </span>
                      <select
                        value={value === null ? "" : String(value)}
                        onChange={(e) =>
                          setMapping((prev) =>
                            prev === null
                              ? prev
                              : {
                                  ...prev,
                                  [field.id]:
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value),
                                },
                          )
                        }
                        className="h-8 min-w-0 flex-1 rounded-sm border border-hairline bg-surface px-2 text-body-sm text-ink outline-none focus:border-brand"
                      >
                        <option value="">— not in file —</option>
                        {table?.headers.map((h, i) => (
                          <option key={`${h}-${i}`} value={i}>
                            {h || `Column ${i + 1}`}
                          </option>
                        ))}
                      </select>
                    </li>
                  );
                })}
              </ul>

              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge tone={summary.ready > 0 ? "ok" : "neutral"} dot>
                  {summary.ready} ready
                </Badge>
                {summary.blocked > 0 ? (
                  <Badge tone="danger" dot>
                    {summary.blocked} blocked
                  </Badge>
                ) : null}
                {summary.warnings > 0 ? (
                  <Badge tone="warn" dot>
                    {summary.warnings} with warnings
                  </Badge>
                ) : null}
                {summary.needGeocoding > 0 ? (
                  <Badge tone="neutral">
                    <Icon name="wrong_location" className="text-[13px]" />
                    {summary.needGeocoding} need geocoding
                  </Badge>
                ) : null}
                {table && table.truncated > 0 ? (
                  <Badge tone="warn">
                    {table.truncated} rows past the limit ignored
                  </Badge>
                ) : null}
              </div>

              {unmappedRequired.length > 0 ? (
                <p className="mb-3 flex items-start gap-2 rounded-sm border border-danger-border bg-danger-soft px-3 py-2 text-body-sm text-danger">
                  <Icon name="error" className="mt-px text-[17px]" />
                  Match {unmappedRequired.map((f) => f.label).join(", ")} before
                  importing.
                </p>
              ) : null}

              <div className="overflow-hidden rounded-sm border border-hairline">
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-12">Line</Th>
                      <Th>Reference</Th>
                      <Th>Customer</Th>
                      <Th>Destination</Th>
                      <Th>Result</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedRows.slice(0, 100).map((row) => {
                      const errors = row.issues.filter(
                        (i) => i.severity === "error",
                      );
                      const warnings = row.issues.filter(
                        (i) => i.severity === "warning",
                      );
                      return (
                        <Tr key={row.line}>
                          <Td className="font-mono text-data-sm text-ink-subtle">
                            {row.line}
                          </Td>
                          <Td className="font-mono text-data-sm text-ink">
                            {row.values.crm_order_id || "—"}
                          </Td>
                          <Td className="max-w-[14rem] truncate text-ink-muted">
                            {row.values.customer_name || "—"}
                          </Td>
                          <Td className="max-w-[16rem]">
                            <span className="block truncate text-ink-muted">
                              {row.values.delivery_address || "—"}
                            </span>
                            <span className="font-mono text-data-sm text-ink-subtle">
                              {[
                                row.values.delivery_postcode,
                                row.values.delivery_country || "IE",
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </Td>
                          <Td>
                            {errors.length > 0 ? (
                              <ul className="space-y-0.5">
                                {errors.map((issue, n) => (
                                  <li
                                    key={n}
                                    className="flex items-start gap-1 text-caption text-danger"
                                  >
                                    <Icon
                                      name="error"
                                      className="mt-px text-[13px]"
                                    />
                                    {issue.message}
                                  </li>
                                ))}
                              </ul>
                            ) : warnings.length > 0 ? (
                              <ul className="space-y-0.5">
                                {warnings.map((issue, n) => (
                                  <li
                                    key={n}
                                    className="flex items-start gap-1 text-caption text-warn"
                                  >
                                    <Icon
                                      name="warning"
                                      className="mt-px text-[13px]"
                                    />
                                    {issue.message}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="flex items-center gap-1 text-caption text-ok">
                                <Icon name="check_circle" className="text-[13px]" />
                                Ready
                              </span>
                            )}
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
                {parsedRows.length > 100 ? (
                  <p className="border-t border-hairline bg-surface-muted px-4 py-2 text-caption text-ink-subtle">
                    Showing the first 100 of {parsedRows.length} rows. All of
                    them are validated and will import.
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-hairline px-6 py-3">
          <p className="mr-auto max-w-md text-caption text-ink-subtle">
            Rows with errors are skipped, not guessed at. Imported orders arrive
            without coordinates unless the file supplies them.
          </p>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon="upload"
            disabled={stage !== "map" || summary.ready === 0}
            onClick={commit}
          >
            Import {summary.ready > 0 ? summary.ready : ""}{" "}
            {summary.ready === 1 ? "order" : "orders"}
          </Button>
        </footer>
      </div>
    </>
  );
}
