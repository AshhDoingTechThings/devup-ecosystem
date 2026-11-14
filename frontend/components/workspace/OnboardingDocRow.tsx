"use client";

import { useRef } from "react";
import { Upload, Check, FileText, ExternalLink, AlertCircle } from "lucide-react";
import { ONBOARDING_DOC_LABELS, DOC_STATUS_TONE } from "@/lib/api/workspace";

/**
 * One line of a person's onboarding checklist: its review state, the file
 * they sent (a short-lived signed link) and an upload button. Shared by the
 * onboarding page and the employee dashboard.
 */
export default function OnboardingDocRow({ item, personId, uploading, onUpload }: any) {
  const fileRef = useRef<HTMLInputElement>(null);
  const tone = DOC_STATUS_TONE[item.status] ?? DOC_STATUS_TONE.PENDING;
  const needsAction = item.status === "PENDING" || item.status === "REJECTED";

  return (
    <div className="py-3.5 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-[#e4e4e4]">{item.label ?? ONBOARDING_DOC_LABELS[item.docType]}</span>
          {!item.isRequired && <span className="text-[9px] text-[#5a5a5a]">optional</span>}
        </div>

        {item.rejectReason && (
          <p className="flex items-start gap-1.5 text-[11px] mt-1" style={{ color: "#f87171" }}>
            <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" /> {item.rejectReason}
          </p>
        )}

        {item.fileName && !needsAction && (
          <a href={item.fileUrl} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1 text-[11px] text-[#8b8b8b] hover:text-white transition mt-1">
            <FileText className="w-3 h-3" /> {item.fileName} <ExternalLink className="w-2.5 h-2.5" />
          </a>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[10px] px-2 py-1 rounded whitespace-nowrap" style={{ background: tone.bg, color: tone.fg }}>
          {tone.label}
        </span>

        {item.status !== "APPROVED" && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUpload(personId, item.docType, f);
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition disabled:opacity-40"
              style={
                needsAction
                  ? { background: "rgba(200,241,53,0.12)", color: "#c8f135" }
                  : { background: "rgba(255,255,255,0.05)", color: "#8b8b8b" }
              }
            >
              {uploading ? "Uploading…" : (
                <>
                  <Upload className="w-3 h-3" />
                  {item.status === "REJECTED" ? "Re-upload" : item.status === "SUBMITTED" ? "Replace" : "Upload"}
                </>
              )}
            </button>
          </>
        )}

        {item.status === "APPROVED" && <Check className="w-4 h-4 text-[#c8f135]" />}
      </div>
    </div>
  );
}

