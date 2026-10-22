"use client";

/**
 * Port of apps/app's Portfolio/Profile/EditHeader/ (index + Form + Field +
 * Footer + Modal + Select + useResetFormOnClose, collapsed into one file).
 * No yup schema existed on the source form — validity is just "the Name
 * field has a value" — so there's nothing to port there; the submit payload
 * shaping IS kept byte-faithful per V-20.
 */

import { useEffect } from "react";
import { Formik, Form as FormikForm, useFormikContext } from "formik";
import { MapPin } from "lucide-react";

import {
  getCountryByCode,
  COUNTRIES,
} from "platform-constants/countries";
import { CompanyLegalStatus } from "#trpc";
import {
  Field,
  FormFooter,
  FormModal,
  FormSelect,
  TextArea,
  TextInput,
  useToast,
} from "@/components/portfolio";
import { trpc } from "@/lib/trpc";

import type { Company } from "./types";

interface FormValues {
  companyId: string;
  country?: string;
  description?: string;
  name?: string;
  otherNames?: string;
  legalName?: string | null;
  website?: string;
  status?: CompanyLegalStatus;
}

const STATUS_OPTIONS = [
  CompanyLegalStatus.ACTIVE,
  CompanyLegalStatus.INACTIVE,
  CompanyLegalStatus.DISSOLVED,
].map((status) => ({ label: status, value: status }));

const COUNTRY_OPTIONS = COUNTRIES.map((country) => ({
  label: country.title,
  value: country.code,
}));

export function EditHeader({
  company,
  isOpen,
  onClose,
}: {
  company: Company;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const { mutateAsync: updateCompanyInfo } =
    trpc.views.portfolio.company.updateCompanyInfo.useMutation();

  return (
    <Formik<FormValues>
      enableReinitialize
      initialValues={{
        companyId: company?.id ?? "",
        country: company?.country ?? "",
        otherNames: company?.otherNames ?? undefined,
        description: company?.description ?? undefined,
        name: company?.name ?? undefined,
        legalName: company?.legal_name,
        website: company?.personal_website ?? undefined,
        status: (company?.legal_status as CompanyLegalStatus) ?? undefined,
      }}
      validateOnChange
      onSubmit={async (values) => {
        try {
          await updateCompanyInfo({
            companyId: values.companyId,
            country: values.country ?? undefined,
            description: values.description ?? undefined,
            name: values.name ?? undefined,
            otherNames: values.otherNames ?? undefined,
            legalName: values.legalName ?? undefined,
            website: values.website ?? undefined,
            status: values.status ?? undefined,
          });
          await utils.views.portfolio.company.getOverview.invalidate();
          toast.success("Company updated");
          onClose();
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : "Failed to update company",
          );
        }
      }}
    >
      <EditHeaderModal isOpen={isOpen} onClose={onClose} />
    </Formik>
  );
}

function EditHeaderModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const {
    values,
    touched,
    setFieldValue,
    setFieldTouched,
    isSubmitting,
    resetForm,
  } = useFormikContext<FormValues>();

  // Matches apps/app's useResetFormOnClose — clears edits made in a session
  // that was dismissed without saving, so reopening starts from the company
  // as it currently is.
  useEffect(() => {
    if (!isOpen) resetForm();
  }, [isOpen, resetForm]);

  // The form encloses the whole modal, not just its body: Save lives in the
  // footer, and a submit button only submits a form it is inside.
  return (
    <FormikForm>
      <FormModal
        isOpen={isOpen}
        onClose={onClose}
        title="Edit company"
        size="lg"
        footer={
          <FormFooter
            onCancel={onClose}
            submitLabel="Save"
            isSubmitting={isSubmitting}
            isDisabled={Object.keys(touched).length === 0 || !values.companyId}
          />
        }
      >
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-3 gap-4">
            <Field icon={null} label="Name" required>
              <TextInput
                value={values.name ?? ""}
                placeholder="Company name"
                onChange={(e) => {
                  setFieldTouched("name", true);
                  setFieldValue("name", e.target.value);
                }}
              />
            </Field>
            <Field icon={null} label="Legal name">
              <TextInput
                value={values.legalName ?? ""}
                placeholder="Legal name"
                onChange={(e) => {
                  setFieldTouched("legalName", true);
                  setFieldValue("legalName", e.target.value);
                }}
              />
            </Field>
            <Field icon={null} label="Other names">
              <TextInput
                value={values.otherNames ?? ""}
                placeholder="Other names separated by commas"
                onChange={(e) => {
                  setFieldTouched("otherNames", true);
                  setFieldValue("otherNames", e.target.value);
                }}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field icon={null} label="Website">
              <TextInput
                value={values.website ?? ""}
                placeholder="Company website"
                onChange={(e) => {
                  setFieldTouched("website", true);
                  setFieldValue("website", e.target.value);
                }}
              />
            </Field>
            <Field
              label="Country"
              icon={<MapPin size={14} className="text-gray-400" />}
            >
              <FormSelect<string>
                value={
                  values.country
                    ? {
                        label: getCountryByCode(values.country)?.title ?? "",
                        value: getCountryByCode(values.country)?.code ?? "",
                      }
                    : undefined
                }
                setValue={(next) => {
                  setFieldTouched("country", true);
                  setFieldValue("country", next?.value ?? "");
                }}
                options={COUNTRY_OPTIONS}
              />
            </Field>
          </div>

          <Field icon={null} label="Status">
            <FormSelect<CompanyLegalStatus>
              value={
                values.status
                  ? { label: values.status, value: values.status }
                  : undefined
              }
              setValue={(next) => {
                setFieldValue("status", next?.value);
                setFieldTouched("status", true);
              }}
              options={STATUS_OPTIONS}
              placeholder="Select..."
            />
          </Field>

          <Field icon={null} label="Description">
            <TextArea
              value={values.description ?? ""}
              onChange={(e) => {
                setFieldTouched("description", true);
                setFieldValue("description", e.target.value);
              }}
              rows={3}
              placeholder="Company description"
            />
          </Field>
        </div>
      </FormModal>
    </FormikForm>
  );
}
