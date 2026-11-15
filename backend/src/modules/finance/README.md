# Finance module — the CFO portal

DevUp's finance records: expenses, shared costs, staff claims, pay setup and bank details, for central DevUp and every startup. The UI is `/finance` on the main site. Finance roles are managed in the admin portal under **Finance Access**.

This is slice 1. Budgets, payroll runs, recurring bills, subscriptions, startup invoices and reminders, revenue, collaborations and report exports come in later slices.

## Ideas that hold everything together

| Idea | Rule |
|---|---|
| Scope | Every record has `startupId`. `null` means **central DevUp operations** (office, shared tools, central staff), tracked separately from every startup. |
| Money | Whole **paise** in integers. One entry is at most ₹1 crore. Amounts are entered in rupees and converted exactly (`money.ts`). |
| History | Nothing financial is hard-deleted. A **paid** expense is final: mistakes are fixed with an `ADJUSTMENT` entry that points at it. The database enforces this (see Migration). |
| Audit | Every change writes `AuditLog` with entity `Finance…`, field-by-field for edits. The database refuses to edit or delete these entries. |
| Shared costs | A central expense can be split between startups (percent, fixed, headcount, usage). The ecosystem total counts the expense **once**; each startup sees its share separately. |
| Pay figures | HR's `Employee.ctc` and `Intern.stipend` are free text. They are shown as **suggestions**; nothing is used for pay until the CFO confirms it. |
| Bank details | Account number and UPI ID are encrypted (AES-256-GCM, `lib/secrets.ts`). Only the last four digits are ever returned, logged or shown. No passwords, PINs or card data. |
| Files | Private bucket `finance-documents`. Served only by five-minute signed links, and every open is audited. |

## Who may do what

Finance roles live in `FinanceRole`, separate from `User.role`. A platform admin gets **no** finance access unless granted.

| Role | Scope | Can |
|---|---|---|
| `ECOSYSTEM_CFO` | Everything (one at a time) | Everything. **The only role that approves, rejects, pays, voids, corrects, splits costs, and sees salaries, stipends and bank details.** |
| `STARTUP_FINANCE_MANAGER` | One startup | Add, edit and submit that startup's expenses. Cannot approve or pay. Other startups and central DevUp answer 404. |
| `FINANCE_VIEWER` | One startup, or everything | Read only. Never sees pay or bank details. |
| Staff (no role) | Their own claims | Claim expenses for a startup where they have an active employee, intern or member record. See only their own claims. |
| `SUPER_ADMIN` | — | Grant and revoke roles. Only to accounts with a **verified email**, and **never to themselves**. No finance data unless also granted a role. |

## API — `/api/finance`

Every route needs a signed-in user. Pay and bank routes are CFO-only; role routes are SUPER_ADMIN-only.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/me` | anyone | My roles, visible startups, startups I can claim for |
| GET | `/categories` | anyone | Expense categories (plain-language) |
| GET | `/overview?scope=&period=&from=&to=` | finance | Dashboard figures. `scope`: `all`, `central` or a startup id. `period`: `day`, `week`, `month`, `quarter`, `year` (Indian FY) or `custom` |
| GET | `/startups` | finance | Startups I can see |
| GET / POST | `/vendors` | finance (POST: can manage) | Vendors |
| GET | `/expenses?scope&status&kind&categoryId&from&to&q&page` | finance | List, with totals by status |
| POST | `/expenses` | can manage scope | Create. `action`: `draft`, `submit`, or `paid` (CFO: a bill already paid) |
| GET / PATCH / DELETE | `/expenses/:id` | finance / can manage / draft only | Detail (with files, corrections, history) · edit · delete a draft |
| POST | `/expenses/:id/submit` | can manage or claimant | Send for approval |
| POST | `/expenses/:id/approve` · `/reject` · `/request-info` · `/void` | CFO | Review. Reject, info and void need a reason |
| POST | `/expenses/:id/pay` | CFO | Record a payment made outside the app. Idempotent per reference |
| POST | `/expenses/:id/correct` | CFO | Adjustment entry for a paid expense |
| PUT | `/expenses/:id/allocations` | CFO | Split a central cost; empty `shares` removes the split |
| POST | `/expenses/:id/attachments` | can manage (CFO if paid) | Upload receipt or proof (JPG, PNG, WebP, PDF ≤ 8 MB, checked by content) |
| GET | `/attachments/:id/link` | whoever may see the record | Five-minute signed link |
| GET / POST | `/me/claims` | staff | My claims · new claim |
| GET / PATCH / DELETE | `/me/claims/:id` | claimant | View · edit while open · delete a draft |
| POST | `/me/claims/:id/submit` · `/attachments` | claimant | Resubmit · attach receipt |
| GET | `/pay?startup=` | CFO | Everyone to pay: HR figures, suggestions, confirmed pay, bank (last 4) |
| PUT | `/pay/employees/:id/compensation` | CFO | Confirm monthly pay from a date (components must add up). Previous pay is closed, not overwritten |
| PUT | `/pay/interns/:id/stipend` | CFO | Confirm monthly stipend (whole rupees, 0 = unpaid). Written to `Intern.stipendAmount` |
| PUT | `/pay/bank` | CFO | Save bank details (encrypted). The previous account is kept, deactivated |
| GET / POST | `/roles` | SUPER_ADMIN | List · grant |
| POST | `/roles/:id/revoke` | SUPER_ADMIN | Revoke (kept on record) |
| GET | `/roles/candidates?q=` · `/roles/startups` · `/roles/log` | SUPER_ADMIN | Pick a verified account · all startups · access log |

## Migration (production)

The shared database also holds another application's `Rise*` tables, so **never** use `prisma db push` against it. Apply the hand-written script:

```bash
# 1. Back up first (pg_dump v17 matches production).
# 2. Apply. It is additive and safe to re-run.
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f backend/scripts/2026_finance_foundation.sql
# 3. Only then deploy the backend.
```

The script:
- creates the 9 finance tables and 7 enums
- turns **RLS on with no access for `anon`/`authenticated`** (this database's default privileges would otherwise expose new tables to the public key)
- seeds 29 categories
- installs two guards: finance audit entries are immutable, and expenses are never deleted (a paid expense is final)

Rollback: `scripts/2026_finance_foundation_rollback.sql` refuses while any finance record exists.

Verified on a local copy built from `main`'s schema, with production's default privileges:
- applies twice cleanly
- zero drift from `schema.prisma`
- RLS on everywhere, with no API-role access
- the guards refuse every forbidden change
- the rollback refuses with data and works when forced

## Deployment checklist

1. Create the **private** Supabase bucket `finance-documents` (or set `STORAGE_BUCKET_FINANCE`). It must not be public.
2. Make sure `CREDENTIAL_ENCRYPTION_KEY` is set on the backend (64 hex chars). Without it, bank details are refused (503), never stored in plain text.
3. Back up, then apply `2026_finance_foundation.sql` (above).
4. Deploy the backend (Render: Manual Deploy), then the frontend (Vercel) and the admin portal.
5. The CFO verifies their email and signs in once.
6. A super admin (not the CFO) opens Admin → Finance Access and gives them the CFO role.
7. The CFO confirms pay in **Salaries & stipends** and starts recording this month's bills.

## Tests

`backend/test/finance.test.ts` covers roles, scope isolation, the expense workflow, idempotent payment, corrections, races, cost splitting to the paisa, dashboard totals (no double counting), claims, file handling, pay setup and bank encryption. Run with a local database:

```bash
T=postgresql://test@127.0.0.1:55432/devup_test
DATABASE_URL=$T DIRECT_URL=$T TEST_DATABASE_URL=$T npm test
```

Always set `DATABASE_URL` and `DIRECT_URL` as well: `backend/.env` points at production.
