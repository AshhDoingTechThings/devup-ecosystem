/**
 * The default expense categories, in plain language. Groups are what the
 * dashboard charts by; keys are stable identifiers that never change once
 * created (names can be edited).
 *
 * The finance migration inserts these, and ensureDefaultCategories() keeps
 * them present on any database (tests, a fresh environment). Neither ever
 * overwrites a category the CFO has renamed or switched off.
 */
export const DEFAULT_CATEGORIES: Array<{ key: string; name: string; group: string; description: string }> = [
  // Office & operations
  { key: "office_rent", name: "Office rent", group: "Office & operations", description: "Rent for office or co-working space" },
  { key: "electricity", name: "Electricity", group: "Office & operations", description: "Electricity bills" },
  { key: "water", name: "Water", group: "Office & operations", description: "Water bills and drinking water" },
  { key: "internet", name: "Internet", group: "Office & operations", description: "Broadband and Wi-Fi" },
  { key: "telephone", name: "Telephone", group: "Office & operations", description: "Phone lines and mobile plans" },
  { key: "housekeeping", name: "Housekeeping / maid", group: "Office & operations", description: "Cleaning staff and housekeeping" },
  { key: "office_maintenance", name: "Office maintenance & repairs", group: "Office & operations", description: "Repairs, servicing and upkeep" },
  { key: "security", name: "Security", group: "Office & operations", description: "Guards and security services" },
  { key: "office_supplies", name: "Office supplies & stationery", group: "Office & operations", description: "Stationery, printing, cleaning materials" },
  { key: "refreshments", name: "Refreshments", group: "Office & operations", description: "Tea, coffee and snacks at the office" },
  // People
  { key: "salaries", name: "Salaries", group: "People", description: "Employee salaries" },
  { key: "stipends", name: "Intern stipends", group: "People", description: "Intern stipend payments" },
  { key: "incentives", name: "Bonuses & incentives", group: "People", description: "Approved bonuses and incentives" },
  { key: "training", name: "Training & learning", group: "People", description: "Courses, certifications, workshops attended" },
  // Software & tools
  { key: "software", name: "Software subscriptions", group: "Software & tools", description: "SaaS and AI tools, licences" },
  { key: "hosting", name: "Hosting & cloud", group: "Software & tools", description: "Servers, cloud, domains" },
  // Meetings & events
  { key: "meetings", name: "Meetings", group: "Meetings & events", description: "Team, founder, client and investor meetings" },
  { key: "team_events", name: "Team get-togethers", group: "Meetings & events", description: "Dinners, celebrations, outings" },
  { key: "events", name: "Events & workshops", group: "Meetings & events", description: "Hosting events, hackathons, workshops" },
  { key: "food_hospitality", name: "Food & hospitality", group: "Meetings & events", description: "Food and hospitality for guests" },
  // Travel
  { key: "travel", name: "Travel", group: "Travel", description: "Tickets, cabs, fuel" },
  { key: "accommodation", name: "Accommodation", group: "Travel", description: "Hotels and stays" },
  // Growth
  { key: "marketing", name: "Marketing & advertising", group: "Marketing", description: "Ads, promotions, printing for marketing" },
  // Assets
  { key: "equipment", name: "Equipment", group: "Equipment", description: "Laptops, devices, hardware" },
  { key: "furniture", name: "Furniture", group: "Equipment", description: "Desks, chairs, fittings" },
  // Professional
  { key: "professional_fees", name: "Professional fees", group: "Professional services", description: "Legal, accounting, consultants" },
  { key: "bank_charges", name: "Bank charges", group: "Professional services", description: "Bank and payment gateway fees" },
  { key: "taxes_govt", name: "Taxes & government fees", group: "Professional services", description: "Registrations, filings, government fees" },
  // Anything else
  { key: "other", name: "Other", group: "Other", description: "Anything that fits nowhere else" },
];
