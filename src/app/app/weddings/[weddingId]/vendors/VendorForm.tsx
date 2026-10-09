"use client";

import { useActionState, useState, type ReactNode } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { VENDOR_CURRENCIES, isVendorCurrency, type VendorCurrency } from "@/lib/vendors/money";
import { VENDOR_CATEGORIES, VENDOR_STATUSES } from "@/lib/vendors/presentation";
import {
  VENDOR_CONTACT_NAME_MAX_LENGTH,
  VENDOR_CUSTOM_CATEGORY_MAX_LENGTH,
  VENDOR_NAME_MAX_LENGTH,
  VENDOR_NOTES_MAX_LENGTH,
  VENDOR_PHONE_MAX_LENGTH,
  type VendorField,
  type VendorFormValues,
} from "@/lib/vendors/validation";

import type { VendorFormState } from "./actions";

type Submitted = Readonly<{ state: VendorFormState; submission: number }>;

type Props = {
  /** Server Action: create or update a vendor. */
  action: (prev: VendorFormState, formData: FormData) => Promise<VendorFormState>;
  weddingId: string;
  /** Set when editing; the server re-derives authority and the wedding. */
  vendorId?: string;
  /** Unique per page; prefixes the field ids. */
  id: string;
  /** Starting values: the stored vendor (edit) or blanks plus a currency suggestion (create). */
  defaults: VendorFormValues;
  /**
   * LB-22: the vendor has schedule items or payments, so its currency can't
   * change. Shown as fixed text (submitted unchanged); the database decides.
   */
  currencyLocked?: boolean;
  submitLabel: string;
  pendingLabel: string;
};

/**
 * Every vendor field in one form, shared by "Agregar proveedor" and the
 * detail page's edit (one coherent write; the status is just another field).
 * Works without JavaScript, keeps typed values on errors, wires each error to
 * its field (aria-describedby) and announces success in a status region.
 * "¿Qué tipo de proveedor?" appears only for the category "Otro".
 */
export function VendorForm({
  action,
  weddingId,
  vendorId,
  id,
  defaults,
  currencyLocked = false,
  submitLabel,
  pendingLabel,
}: Props) {
  // Every completed submission is numbered, so the fields remount with the
  // right values: React resets a form after its action, and a <select> would
  // otherwise snap back to its FIRST rendered option (losing the chosen
  // category, status or currency on an error).
  const [{ state, submission }, formAction] = useActionState<Submitted, FormData>(
    async (previous, formData) => ({ state: await action(previous.state, formData), submission: previous.submission + 1 }),
    { state: null, submission: 0 },
  );
  const failure = state && !state.ok ? state : null;
  const values: VendorFormValues = { ...defaults, ...failure?.values };

  return (
    <div className="space-y-2">
      {/* Success: a cleared "create" form, a fresh "edit" value. Failure: the typed values. */}
      <VendorFields
        key={`${id}-${submission}`}
        formAction={formAction}
        weddingId={weddingId}
        vendorId={vendorId}
        id={id}
        values={values}
        errors={failure?.fieldErrors ?? {}}
        formError={failure?.formError}
        currencyLocked={currencyLocked}
        submit={<SubmitButton label={submitLabel} pendingLabel={pendingLabel} />}
      />
      <p role="status" className="text-success min-h-5 text-sm font-medium">
        {state?.ok ? state.data.message : null}
      </p>
    </div>
  );
}

function VendorFields({
  formAction,
  weddingId,
  vendorId,
  id,
  values,
  errors,
  formError,
  currencyLocked,
  submit,
}: {
  formAction: (formData: FormData) => void;
  weddingId: string;
  vendorId?: string;
  id: string;
  values: VendorFormValues;
  errors: Partial<Record<VendorField, string>>;
  formError?: string;
  currencyLocked: boolean;
  submit: ReactNode;
}) {
  const copy = getMessages().vendors;
  const fields = copy.fields;
  const [category, setCategory] = useState(values.category);
  const fieldId = (field: VendorField) => `${id}-${field}`;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="weddingId" value={weddingId} />
      {vendorId ? <input type="hidden" name="vendorId" value={vendorId} /> : null}
      {formError ? <Notice tone="error">{formError}</Notice> : null}

      <FormField
        id={fieldId("name")}
        name="name"
        type="text"
        label={fields.name}
        placeholder={vendorId ? undefined : fields.namePlaceholder}
        maxLength={VENDOR_NAME_MAX_LENGTH}
        autoComplete="off"
        defaultValue={values.name}
        error={errors.name}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id={fieldId("category")}
          name="category"
          label={fields.category}
          value={category}
          onChange={setCategory}
          error={errors.category}
          options={[
            { value: "", label: fields.chooseCategory },
            ...VENDOR_CATEGORIES.map((value) => ({ value, label: copy.categories[value] })),
          ]}
        />
        <SelectField
          id={fieldId("status")}
          name="status"
          label={fields.status}
          defaultValue={values.status || "considering"}
          error={errors.status}
          options={VENDOR_STATUSES.map((value) => ({ value, label: copy.statuses[value] }))}
        />
      </div>

      {category === "other" ? (
        <FormField
          id={fieldId("customCategory")}
          name="customCategory"
          type="text"
          label={fields.customCategory}
          hint={fields.customCategoryHint}
          maxLength={VENDOR_CUSTOM_CATEGORY_MAX_LENGTH}
          autoComplete="off"
          defaultValue={values.customCategory}
          error={errors.customCategory}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id={fieldId("contactName")}
          name="contactName"
          type="text"
          label={fields.contactName}
          maxLength={VENDOR_CONTACT_NAME_MAX_LENGTH}
          autoComplete="off"
          defaultValue={values.contactName}
          error={errors.contactName}
        />
        <FormField
          id={fieldId("email")}
          name="email"
          type="email"
          label={fields.email}
          hint={fields.emailHint}
          autoComplete="off"
          defaultValue={values.email}
          error={errors.email}
        />
        <FormField
          id={fieldId("phone")}
          name="phone"
          type="tel"
          label={fields.phone}
          maxLength={VENDOR_PHONE_MAX_LENGTH}
          autoComplete="off"
          defaultValue={values.phone}
          error={errors.phone}
        />
        <FormField
          id={fieldId("instagramHandle")}
          name="instagramHandle"
          type="text"
          label={fields.instagram}
          hint={fields.instagramHint}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={values.instagramHandle}
          error={errors.instagramHandle}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {currencyLocked && isVendorCurrency(values.currency) ? (
          <LockedCurrency id={fieldId("currency")} currency={values.currency} error={errors.currency} />
        ) : (
          <SelectField
            id={fieldId("currency")}
            name="currency"
            label={fields.currency}
            hint={fields.currencyHint}
            defaultValue={values.currency}
            error={errors.currency}
            options={[
              { value: "", label: fields.chooseCurrency },
              ...VENDOR_CURRENCIES.map((value) => ({ value, label: copy.currencies[value] })),
            ]}
          />
        )}
        <FormField
          id={fieldId("quotedAmount")}
          name="quotedAmount"
          type="text"
          inputMode="decimal"
          label={fields.quotedAmount}
          hint={fields.amountHint}
          autoComplete="off"
          defaultValue={values.quotedAmount}
          error={errors.quotedAmount}
        />
        <FormField
          id={fieldId("contractedAmount")}
          name="contractedAmount"
          type="text"
          inputMode="decimal"
          label={fields.contractedAmount}
          hint={fields.amountHint}
          autoComplete="off"
          defaultValue={values.contractedAmount}
          error={errors.contractedAmount}
        />
      </div>

      <TextareaField
        id={fieldId("notes")}
        name="notes"
        label={fields.notes}
        hint={fields.notesHint}
        maxLength={VENDOR_NOTES_MAX_LENGTH}
        defaultValue={values.notes}
        error={errors.notes}
      />

      {submit}
    </form>
  );
}

/** The vendor's currency as fixed text plus the reason, submitted unchanged. */
function LockedCurrency({ id, currency, error }: { id: string; currency: VendorCurrency; error?: string }) {
  const copy = getMessages().vendors;
  return (
    <div className="space-y-1.5" data-testid="vendor-currency-locked">
      <p id={`${id}-label`} className="block text-sm font-semibold">
        {copy.fields.currency}
      </p>
      <input type="hidden" name="currency" value={currency} />
      <p
        id={id}
        aria-describedby={describedBy(id, copy.currencyLockedHint, error)}
        className="flex min-h-11 items-center rounded-lg border border-border bg-accent-soft/40 px-3 py-2"
      >
        {copy.currencies[currency]}
      </p>
      <FieldMessages id={id} hint={copy.currencyLockedHint} error={error} />
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

function FieldMessages({ id, hint, error }: { id: string; hint?: string; error?: string }) {
  return (
    <>
      {hint ? (
        <p id={`${id}-hint`} className="text-muted text-sm">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-danger text-sm font-medium">
          {error}
        </p>
      ) : null}
    </>
  );
}

function SelectField({
  id,
  name,
  label,
  hint,
  error,
  options,
  defaultValue,
  value,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  hint?: string;
  error?: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string;
  /** Controlled (the category, which shows or hides the custom type). */
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <select
        id={id}
        name={name}
        className={inputClass}
        {...(onChange ? { value, onChange: (event) => onChange(event.target.value) } : { defaultValue })}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldMessages id={id} hint={hint} error={error} />
    </div>
  );
}

function TextareaField({
  id,
  name,
  label,
  hint,
  error,
  maxLength,
  defaultValue,
}: {
  id: string;
  name: string;
  label: string;
  hint?: string;
  error?: string;
  maxLength: number;
  defaultValue: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={4}
        maxLength={maxLength}
        defaultValue={defaultValue}
        className={inputClass}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
      />
      <FieldMessages id={id} hint={hint} error={error} />
    </div>
  );
}
