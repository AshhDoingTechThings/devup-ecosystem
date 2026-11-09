"use client";

import { useState, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { Upload, Loader2, Search, Filter, Share2, Check, ExternalLink } from "lucide-react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import ErrorBoundary from "@/components/ErrorBoundary";
import PageControls from "@/components/PageControls";
import MobileBottomSheet from "@/components/MobileBottomSheet";

const CareerNetworkGraph = dynamic(
  () => import("@/components/3d/CareerNetworkGraph"),
  { ssr: false }
);

const TABS = ["All Roles", "Internships", "Full-time Jobs", "Remote Only"];

const TYPE_LABELS: Record<string, string> = {
  INTERNSHIP: "Internship",
  FULL_TIME: "Full-time",
  PART_TIME: "Part-time",
  CONTRACT: "Contract",
};

const WORK_MODES = [
  { label: "In-office", value: "OFFICE" },
  { label: "Hybrid", value: "HYBRID" },
  { label: "Remote", value: "REMOTE" },
];

type Job = {
  id: string;
  role: string;
  company: string;
  type: string;
  rawType: string;
  workMode: string;
  domain: string;
  location: string;
  stipend: string;
  date: string;
  logo: string;
  description: string;
  skills: string[];
};

/** Remote if the job says so, or its location does ("Hyderabad / Remote"). */
const isRemoteJob = (j: Job) => j.workMode === "REMOTE" || /remote/i.test(j.location);

/** Stipend text in thousands of rupees: "Rs 20,000/month" → 20, "12000" → 12, "Remote" → null. */
function stipendInThousands(text: string): number | null {
  const match = text.replace(/,/g, "").match(/\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /\d\s*k\b/i.test(text) ? n : n / 1000;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

/* Small share button on each card */
function CardShareButton({ jobId, jobTitle, company }: { jobId: string; jobTitle: string; company: string }) {
  const [copied, setCopied] = useState(false);

  function handleShare(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const url = `${window.location.origin}/careers/${jobId}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleShare}
      title="Copy share link"
      className="p-2 rounded-lg border border-white/[0.06] bg-white/[0.03] transition-all duration-200 hover:border-[#c8f135]/30 hover:bg-[#c8f135]/5 hover:scale-110 active:scale-95"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-[#c8f135]" />
      ) : (
        <Share2 className="w-3.5 h-3.5 text-[#6b6b6b]" />
      )}
    </button>
  );
}

export default function CareersPage() {
  const [activeTab, setActiveTab] = useState(TABS[0]);
  const [stipendValue, setStipendValue] = useState(0);
  const [domains, setDomains] = useState<string[]>([]);
  const [locationQuery, setLocationQuery] = useState("");
  const [workModes, setWorkModes] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [searchQuery, setSearchQuery] = useState("");
  const [bottomSheetOpen, setBottomSheetOpen] = useState(false);

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/jobs?limit=100`)
      .then(res => res.json())
      .then(data => {
        if (data.success && data.data) {
          const formatted = data.data.map((j: any) => ({
            id: j.id,
            role: j.title,
            company: j.startup?.name || "DevUp",
            type: TYPE_LABELS[j.type] ?? j.type ?? "Full-time",
            rawType: j.type ?? "",
            workMode: j.workMode ?? "",
            domain: j.domain ?? "",
            location: j.location || "Remote",
            stipend: j.stipend || j.salaryRange || "",
            date: timeAgo(j.createdAt),
            logo: (j.startup?.name || "D")[0],
            description: j.description,
            skills: Array.isArray(j.skills) ? j.skills : [],
          }));
          setJobs(formatted);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  /*
   * The search box, tabs and sidebar filters used to be decorative: the list
   * rendered every job whatever was typed or ticked.
   */
  const domainOptions = useMemo(
    () => [...new Set(jobs.map((j) => j.domain).filter(Boolean))].sort(),
    [jobs]
  );

  const filteredJobs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const loc = locationQuery.trim().toLowerCase();
    return jobs.filter((j) => {
      if (activeTab === "Internships" && j.rawType !== "INTERNSHIP") return false;
      if (activeTab === "Full-time Jobs" && j.rawType !== "FULL_TIME") return false;
      if (activeTab === "Remote Only" && !isRemoteJob(j)) return false;
      if (q && ![j.role, j.company, j.domain, j.location, ...j.skills].some((v) => String(v ?? "").toLowerCase().includes(q))) return false;
      if (domains.length && !domains.includes(j.domain)) return false;
      if (loc && !j.location.toLowerCase().includes(loc)) return false;
      if (workModes.length && !workModes.some((m) => (m === "REMOTE" ? isRemoteJob(j) : j.workMode === m))) return false;
      if (stipendValue > 0) {
        const k = stipendInThousands(j.stipend);
        if (k === null || k < stipendValue) return false;
      }
      return true;
    });
  }, [jobs, activeTab, searchQuery, domains, locationQuery, workModes, stipendValue]);

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const clearFilters = () => {
    setActiveTab(TABS[0]);
    setSearchQuery("");
    setDomains([]);
    setLocationQuery("");
    setWorkModes([]);
    setStipendValue(0);
  };

  const filterLabel = { fontFamily: "var(--font-inter), sans-serif", fontSize: "11px", color: "#6b6b6b", textTransform: "uppercase" as const, marginBottom: "12px", letterSpacing: "0.05em" };

  /** The same filters in the desktop sidebar and the mobile sheet. */
  const renderFilters = (place: "desktop" | "mobile") => (
    <>
      {domainOptions.length > 0 && (
        <div>
          <div style={filterLabel}>Domain</div>
          <div className="space-y-3">
            {domainOptions.map(d => (
              <label key={d} className="flex items-center gap-3 cursor-pointer group">
                <div className="relative flex items-center justify-center w-4 h-4 border border-white/20 rounded-[4px] bg-transparent group-hover:border-white/40 transition-colors">
                  <input
                    type="checkbox"
                    checked={domains.includes(d)}
                    onChange={() => setDomains((cur) => toggle(cur, d))}
                    className="opacity-0 absolute inset-0 cursor-pointer peer"
                  />
                  <div className="hidden peer-checked:block w-2 h-2 bg-[#c8f135] rounded-[2px]" />
                </div>
                <span style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "14px", color: "#a1a1a1" }} className="group-hover:text-white transition-colors">{d}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <label htmlFor={`careers-location-${place}`} style={{ ...filterLabel, display: "block" }}>Location</label>
        <input
          id={`careers-location-${place}`}
          type="text"
          value={locationQuery}
          onChange={(e) => setLocationQuery(e.target.value)}
          placeholder="e.g. Bengaluru, Remote"
          className="w-full bg-[#111111] border border-white/10 rounded-[8px] px-3 py-2 outline-none focus:border-[#c8f135]/40 focus:shadow-[0_0_0_3px_rgba(200,241,53,0.08)] transition-all"
          style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "14px", color: "#e4e4e4" }}
        />
      </div>

      <div>
        <div style={filterLabel}>Type</div>
        <div className="flex flex-wrap gap-2">
          {WORK_MODES.map(({ label, value }) => {
            const on = workModes.includes(value);
            return (
              <button
                key={value}
                type="button"
                aria-pressed={on}
                onClick={() => setWorkModes((cur) => toggle(cur, value))}
                className="px-3 py-1.5 rounded-full"
                style={{ background: on ? "rgba(200,241,53,0.1)" : "#111111", border: `1px solid ${on ? "rgba(200,241,53,0.3)" : "rgba(255,255,255,0.08)"}`, color: on ? "#c8f135" : "#a1a1a1", fontSize: "13px", fontFamily: "var(--font-inter), sans-serif" }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="flex justify-between items-center mb-12">
          <div style={{ ...filterLabel, marginBottom: 0 }}>Min Stipend/Salary</div>
          <div style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "12px", color: "#c8f135" }}>{stipendValue > 0 ? `₹${stipendValue}k+` : "Any"}</div>
        </div>
        <div className="relative w-full h-1 bg-white/10 rounded-full">
          <div className="absolute top-0 left-0 h-full bg-[#c8f135] rounded-full" style={{ width: `${stipendValue}%` }} />
          <input
            type="range"
            min="0" max="100" step="5"
            value={stipendValue}
            onChange={(e) => setStipendValue(Number.parseInt(e.target.value, 10))}
            aria-label="Minimum stipend or salary, in thousands of rupees"
            className="absolute inset-0 w-full opacity-0 cursor-pointer"
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full pointer-events-none shadow-md"
            style={{ left: `calc(${stipendValue}% - 8px)` }}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={clearFilters}
        className="mt-4 bg-transparent border-none text-[#6b6b6b] hover:text-[#e4e4e4] transition-colors cursor-pointer"
        style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "13px" }}
      >
        Clear All Filters
      </button>
    </>
  );

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <PageHeader
        label="OPPORTUNITIES"
        headline="Find your next\nrole."
        accentWord="role"
        subtitle="Internships, full-time positions, and remote roles across the DevUp ecosystem and partner companies."
        variant="grid"
      />

      <ErrorBoundary>
        <CareerNetworkGraph jobs={jobs} />
      </ErrorBoundary>

      <div className="max-w-7xl mx-auto px-4 md:px-8 mt-12 pb-24">
        
        {/* Mobile Page Controls (Search, Tabs, Filter Button) */}
        <div className="md:hidden block mb-6">
          <PageControls
            search={
              <div className="relative w-full">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6b6b6b]" />
                <input
                  type="text"
                  placeholder="Search roles or companies..."
                  aria-label="Search roles or companies"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-[#111111] border border-white/10 rounded-lg py-3 pl-10 pr-4 outline-none transition-all focus:border-[#c8f135]/40"
                  style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "14px", color: "#e4e4e4" }}
                />
              </div>
            }
            filters={
              <>
                {TABS.map((tab) => {
                  const isActive = activeTab === tab;
                  return (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className="whitespace-nowrap rounded-full transition-all duration-150 flex-shrink-0"
                      style={{
                        padding: "8px 16px",
                        fontFamily: "var(--font-inter), sans-serif",
                        fontSize: "14px",
                        border: `1px solid ${isActive ? 'rgba(200,241,53,0.3)' : 'rgba(255,255,255,0.08)'}`,
                        background: isActive ? 'rgba(200,241,53,0.1)' : 'transparent',
                        color: isActive ? '#c8f135' : '#6b6b6b',
                      }}
                    >
                      {tab}
                    </button>
                  )
                })}
              </>
            }
            sort={
              <button
                onClick={() => setBottomSheetOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-[#111111] border border-white/10 rounded-lg text-[#e4e4e4] transition-colors hover:bg-white/5"
                style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "14px" }}
              >
                Filters <Filter size={14} />
              </button>
            }
          />
        </div>

        {/* Desktop Prominent Tabs (Hidden on mobile) */}
        <div className="hidden md:flex flex-col sm:flex-row justify-center gap-4 mb-16">
          {TABS.map((tab) => {
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className="transition-all duration-200"
                style={{
                  background: isActive ? "rgba(200,241,53,0.06)" : "#111111",
                  border: `1px solid ${isActive ? 'rgba(200,241,53,0.3)' : 'rgba(255,255,255,0.07)'}`,
                  borderRadius: "10px",
                  padding: "12px 24px",
                  fontFamily: "var(--font-syne), sans-serif",
                  fontSize: "15px",
                  fontWeight: 600,
                  color: isActive ? "#c8f135" : "#6b6b6b",
                  cursor: "pointer"
                }}
              >
                {tab}
              </button>
            )
          })}
        </div>

        {/* Two Column Layout */}
        <div className="flex flex-col lg:flex-row gap-12">
          
          {/* Left Sidebar Filters (Desktop only) */}
          <div className="hidden lg:block w-[260px] shrink-0 space-y-8">
            {renderFilters("desktop")}
          </div>

          {/* Right Content */}
          <div className="flex-1 flex flex-col gap-4">
            <div style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "14px", color: "#6b6b6b", marginBottom: "8px" }}>
              {loading ? "Loading..." : `${filteredJobs.length} opportunities found`}
            </div>

            {/* Loading State */}
            {loading && (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-[#c8f135]" />
              </div>
            )}

            {/* Empty State */}
            {!loading && jobs.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p style={{ fontFamily: "var(--font-syne), sans-serif", fontSize: "18px", color: "#fff", marginBottom: "8px" }}>No jobs posted yet</p>
                <p style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "14px", color: "#6b6b6b" }}>Check back soon — startups are always hiring.</p>
              </div>
            )}

            {/* Nothing matches the filters */}
            {!loading && jobs.length > 0 && filteredJobs.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p style={{ fontFamily: "var(--font-syne), sans-serif", fontSize: "18px", color: "#fff", marginBottom: "8px" }}>No roles match these filters</p>
                <button type="button" onClick={clearFilters} className="mt-2 text-[#c8f135] bg-transparent border-none cursor-pointer" style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "14px" }}>
                  Clear all filters
                </button>
              </div>
            )}

            {/* Job List */}
            {filteredJobs.map((job) => {
              const isInternship = job.rawType === "INTERNSHIP";
              const isRemote = isRemoteJob(job);
              let badgeColor = "#c8f135";
              if (isInternship) {
                badgeColor = "#fb923c";
              } else if (isRemote) {
                badgeColor = "#38bdf8";
              }

              return (
                <Link
                  key={job.id}
                  href={`/careers/${job.id}`}
                  className="group relative flex flex-col sm:flex-row sm:items-center gap-4 bg-[#111111] border border-white/5 rounded-[12px] p-5 cursor-pointer transition-all duration-200 hover:border-white/15 hover:translate-x-1 no-underline"
                >
                  <div className="absolute left-[-1px] top-4 bottom-4 w-[4px] bg-[#c8f135] rounded-r-md opacity-0 group-hover:opacity-100 transition-opacity" />
                  
                  <div className="w-[40px] h-[40px] bg-[#0a0a0a] rounded-[10px] flex items-center justify-center shrink-0 border border-white/10">
                    <span style={{ fontFamily: "var(--font-syne), sans-serif", fontSize: "16px", fontWeight: 700, color: "#fff" }}>{job.logo}</span>
                  </div>

                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-3 mb-2">
                      <h4 style={{ fontFamily: "var(--font-syne), sans-serif", fontSize: "15px", fontWeight: 700, color: "#fff" }}>
                        {job.role}
                      </h4>
                      <span 
                        className="px-2 py-0.5 rounded-[4px]"
                        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", color: badgeColor, fontSize: "11px", fontFamily: "var(--font-inter), sans-serif" }}
                      >
                        {job.type}
                      </span>
                    </div>
                    
                    <div className="flex flex-wrap items-center gap-2" style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "13px", color: "#6b6b6b" }}>
                      <span>{job.company}</span>
                      <span>·</span>
                      <span>{job.location}</span>
                      <span>·</span>
                      <span style={{ color: "#a1a1a1" }}>{job.stipend}</span>
                    </div>
                  </div>

                  <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-3 mt-4 sm:mt-0">
                    <div style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "12px", color: "#3d3d3d" }}>
                      {job.date}
                    </div>
                    <div className="flex items-center gap-2">
                      <CardShareButton jobId={job.id} jobTitle={job.role} company={job.company} />
                      <span
                        className="px-3.5 py-1.5 bg-[#c8f135] text-black font-semibold rounded-[6px] transition-all group-hover:shadow-[0_0_20px_rgba(200,241,53,0.2)]"
                        style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "13px" }}
                      >
                        View & Apply
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}

            {/* Resume Upload bottom card */}
            <div className="mt-16 bg-[#0f0f0f] border border-dashed rounded-[16px] p-12 text-center flex flex-col items-center" style={{ borderColor: "rgba(200,241,53,0.2)" }}>
              <Upload className="w-8 h-8 mb-4" style={{ color: "#c8f135" }} />
              <h3 style={{ fontFamily: "var(--font-syne), sans-serif", fontSize: "22px", color: "#fff", marginBottom: "8px" }}>
                Let startups find you
              </h3>
              <p style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "15px", color: "#6b6b6b", marginBottom: "24px", maxWidth: "400px" }}>
                Upload your resume and get discovered by ecosystem founders actively hiring.
              </p>
              {/* Resumes are uploaded on the profile page; this button did nothing. */}
              <Link
                href="/profile"
                className="px-6 py-3 bg-[#c8f135] text-black font-semibold rounded-[8px] mb-3 no-underline"
                style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "14px" }}
              >
                Upload Resume
              </Link>
              <div style={{ fontFamily: "var(--font-inter), sans-serif", fontSize: "12px", color: "#3d3d3d" }}>
                PDF, up to 10MB
              </div>
            </div>
            
          </div>
      </div>

      <MobileBottomSheet
        isOpen={bottomSheetOpen}
        onClose={() => setBottomSheetOpen(false)}
        title="Filters"
        footer={
          <button
            onClick={() => setBottomSheetOpen(false)}
            className="w-full py-3 bg-[#c8f135] text-black font-bold rounded-xl"
            style={{ fontFamily: 'var(--font-inter), sans-serif', fontSize: '15px' }}
          >
            Apply Filters
          </button>
        }
      >
        <div className="space-y-8">
          {renderFilters("mobile")}
        </div>
      </MobileBottomSheet>
    </div>

    </div>
  );
}
