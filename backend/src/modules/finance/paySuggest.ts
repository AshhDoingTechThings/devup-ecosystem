/**
 * Reading pay figures out of HR free text — pure functions, no database or
 * server imports, so they can be tested (and reused) in isolation.
 */

/** Indian rupee figures in HR text: "7,00,000", "25000", "Rs 10,000/month", "₹5000 pm". Nothing else is guessed. */
const MONEY_TEXT = /^\s*(?:rs\.?|inr|₹)?\s*(\d{1,3}(?:,\d{2})*(?:,\d{3})|\d+)(?:\.\d{1,2})?\s*(\/\s*(?:month|mo|m)|per\s*month|p\.?\s?m\.?|monthly|\/\s*(?:year|yr|annum)|per\s*(?:year|annum)|p\.?\s?a\.?|lpa|annual(?:ly)?)?\s*$/i;

export type PaySuggestion = {
  monthlyPaise: number;
  annualCtcPaise: number | null;
  basis: "ANNUAL_CTC" | "MONTHLY_FIGURE";
  confidence: "high" | "check";
  explanation: string;
} | { monthlyPaise: null; explanation: string };

/**
 * Reading Employee.ctc. In the live data every value is a bare number in the
 * Indian format (1,00,000 … 25,00,000), which is how a yearly CTC is written,
 * so a figure of ₹1 lakh or more is read as yearly and divided by 12. A
 * smaller bare figure (e.g. 25000) is far more likely a monthly amount, so it
 * is offered as monthly — but flagged for the CFO to check.
 */
export function suggestEmployeePay(ctc: string | null | undefined): PaySuggestion {
  if (!ctc || !ctc.trim()) return { monthlyPaise: null, explanation: "No CTC recorded in HR — enter the pay" };
  const m = ctc.match(MONEY_TEXT);
  if (!m) return { monthlyPaise: null, explanation: `HR has "${ctc}", which isn't a single amount — enter the pay` };
  const rupees = Number(m[1].replace(/,/g, ""));
  const unit = (m[2] ?? "").toLowerCase();
  const saysMonthly = /month|mo|^\/\s*m$|p\.?\s?m|monthly/.test(unit);
  const saysYearly = /year|yr|annum|p\.?\s?a|lpa|annual/.test(unit);
  if (saysMonthly) {
    return { monthlyPaise: rupees * 100, annualCtcPaise: rupees * 1200, basis: "MONTHLY_FIGURE", confidence: "high", explanation: `HR says ₹${rupees.toLocaleString("en-IN")} per month` };
  }
  if (saysYearly || rupees >= 100000) {
    const annual = (unit === "lpa" ? rupees * 100000 : rupees) * 100;
    return {
      monthlyPaise: Math.round(annual / 12),
      annualCtcPaise: annual,
      basis: "ANNUAL_CTC",
      confidence: saysYearly ? "high" : "check",
      explanation: `HR has a CTC of ₹${(annual / 100).toLocaleString("en-IN")}${saysYearly ? " per year" : ", read as yearly"} → ₹${(Math.round(annual / 12) / 100).toLocaleString("en-IN")} a month`,
    };
  }
  return { monthlyPaise: rupees * 100, annualCtcPaise: null, basis: "MONTHLY_FIGURE", confidence: "check", explanation: `HR has ₹${rupees.toLocaleString("en-IN")} with no unit — too small for a yearly CTC, so read as monthly. Please check.` };
}

/** Reading Intern.stipend. Live values are plain numbers (3000, 5000, 10000) or "Rs 10,000/month": all monthly. */
export function suggestStipend(stipendAmount: number | null, text: string | null | undefined) {
  if (stipendAmount != null) return { monthlyRupees: stipendAmount, confirmed: true, explanation: "Set" };
  if (!text || !text.trim()) return { monthlyRupees: null, confirmed: false, explanation: "No stipend recorded in HR — enter it (0 for an unpaid internship)" };
  const m = text.match(MONEY_TEXT);
  if (!m || /year|yr|annum|p\.?\s?a|lpa|annual/i.test(m[2] ?? "")) {
    return { monthlyRupees: null, confirmed: false, explanation: `HR has "${text}", which isn't a monthly amount — enter it` };
  }
  const rupees = Number(m[1].replace(/,/g, ""));
  return { monthlyRupees: rupees, confirmed: false, explanation: `HR says ₹${rupees.toLocaleString("en-IN")}${m[2] ? "" : ", read as monthly"}` };
}

