/**
 * Result of a form Server Action, consumed by `useActionState`.
 *
 * Messages are already-resolved catalog strings: actions never return raw
 * Supabase/Postgres errors, tokens or other internals to the client.
 * `values` echoes back non-sensitive input so a failed form keeps it
 * (never passwords).
 */
export type FormState<Field extends string, Data = undefined> =
  | Readonly<{ ok: true; data: Data }>
  | Readonly<{
      ok: false;
      fieldErrors?: Partial<Record<Field, string>>;
      formError?: string;
      values?: Partial<Record<Field, string>>;
    }>;

/** Reads a text field from FormData; non-string (File) or missing → "". */
export function formText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
