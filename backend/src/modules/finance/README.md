# Finance module — the CFO portal

DevUp's finance records: expenses, shared costs, staff claims, pay setup and bank details, for central DevUp and every startup. The UI is `/finance` on the main site. Finance roles are managed in the admin portal under **Finance Access**.

Built so far:
- **Slice 1:** roles, expenses, shared costs, claims, pay setup, dashboard.
- **Slice 2:** budgets, regular (recurring) bills, subscriptions and seats, meetings and events, and the daily job.
- **Slice 3:** payroll and stipend runs, the bank-transfer file, payment confirmation, payslips and stipend statements, and "My pay".

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
| `ECOSYSTEM_CFO` | Everything (more than one allowed; each action recorded under its author) | Everything. **The only role that approves, rejects, pays, voids, corrects, splits costs, and sees salaries, stipends and bank details.** |
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
| GET | `/budgets?scope=&current=1` · `/budgets/:id` · `/budgets/groups` | finance (budget's scope) | Budgets with allocated / spent / committed / available, per line; spending groups |
| POST · PATCH | `/budgets` · `/budgets/:id` | CFO | Create · change (changing amounts needs a `reason`; `version` increments) |
| POST | `/budgets/:id/archive` | CFO | Archive |
| GET · POST · PATCH | `/recurring` · `/recurring/:id` | finance · can manage scope | Regular bills. `autoApprove` is CFO-only |
| POST | `/recurring/generate` | can manage | Create every due bill now (the daily job does this too); never duplicates |
| GET | `/subscriptions?scope=` · `/subscriptions/:id` · `/subscriptions/usage` | finance | List with monthly cost and alerts · detail with seats and payments · who uses what |
| POST · PATCH | `/subscriptions` · `/subscriptions/:id` | can manage scope | Create · edit or cancel (`status: CANCELLED`). Full card numbers refused |
| POST · DELETE | `/subscriptions/:id/seats` · `/subscriptions/seats/:id` | can manage | Assign or remove a seat |
| POST | `/subscriptions/:id/charges` | can manage | Record a payment (becomes an expense; the renewal moves on a cycle) |
| GET · POST · PATCH | `/events` · `/events/:id` | finance · can manage | Meetings and events, with totals |
| POST | `/events/:id/costs` | can manage | Add a cost (an expense with source EVENT) |
| GET · POST | `/payroll/runs` · `/payroll/runs/:id` | CFO | Runs (one per kind, startup and month) · prepare a month (`kind` SALARY or STIPEND; stipend `basis` FIXED or ATTENDANCE) |
| PATCH | `/payroll/runs/:id/lines/:lineId` | CFO | Adjustments (incentive, bonus, deduction, reimbursement, final settlement) and hold, before approval |
| POST | `/payroll/runs/:id/submit` · `/reopen` · `/approve` (`confirm: true`) · `/cancel` | CFO | Draft → review → approved; back to draft; cancel (only with no payments) |
| POST | `/payroll/runs/:id/bank-file` | CFO | Bulk-transfer CSV (account numbers only in the file); run becomes PROCESSING |
| POST | `/payroll/runs/:id/lines/:lineId/pay` · `/fail` | CFO | Confirm a payment (idempotent per reference; records an expense) or record a failure with its reason |
| GET | `/payroll/runs/:id/report` | CFO | Run report as CSV |
| GET | `/me/pay` · `/payslips/:id` · `/stipend-statements/:id` | the person (or CFO) | My pay; payslip and stipend statement PDFs |
| POST | `/cron/daily` | scheduler (header `x-cron-secret`) | Create due bills; one digest a day to the CFO |
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

Then slice 2, then slice 3, each needing the one before:

```bash
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f backend/scripts/2026_finance_slice2.sql
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f backend/scripts/2026_finance_slice3.sql
```

**Production status:** all three were applied to production on 2026-11-16, after a full backup (`pg_dump`, all 104 tables). Verified afterwards:
- 18 new tables, RLS on, not readable by the API roles
- 29 categories and both guards in place
- every existing row count unchanged, and the other app's 35 tables intact
- no drift from `schema.prisma`

Rollbacks (`*_rollback.sql`) refuse while their records exist. Roll back in reverse order: slice 3, slice 2, then the foundation.

Verified on a local copy built from `main`'s schema, with production's default privileges:
- applies twice cleanly
- zero drift from `schema.prisma`
- RLS on everywhere, with no API-role access
- the guards refuse every forbidden change
- the rollback refuses with data and works when forced

## Deployment checklist

1. Create the **private** Supabase bucket `finance-documents` (or set `STORAGE_BUCKET_FINANCE`). It must not be public.
2. Make sure `CREDENTIAL_ENCRYPTION_KEY` is set on the backend (64 hex chars). Without it, bank details are refused (503), never stored in plain text.
3. Back up, then apply the foundation, slice 2 and slice 3 scripts, in that order (above). Done in production on 2026-11-16.
4. Deploy the backend (Render: Manual Deploy), then the frontend (Vercel) and the admin portal.
5. Set `FINANCE_CRON_SECRET` on the backend (24+ random characters). Create a Render cron job that runs daily, e.g. at 07:30 IST:
   `curl -fsS -X POST -H "x-cron-secret: $FINANCE_CRON_SECRET" https://<backend>/api/finance/cron/daily`
   It creates due regular bills and sends the CFO one digest a day. Running it twice does nothing extra.
6. The CFO verifies their email and signs in once.
7. Give the CFO role. Normally a super admin (not the CFO) does this in Admin → Finance Access. Until there is a real super admin, use the script (it refuses unverified accounts):
   `cd backend && npx ts-node scripts/grant-finance-role.ts --email <their email> --role ECOSYSTEM_CFO --operator "<your name>"` (dry run), then the same with `--apply`.
   There can be more than one CFO.
8. The CFO confirms pay in **Salaries & stipends**, adds regular bills and subscriptions, and sets this month's budgets.

## Tests

`backend/test/finance-payroll.test.ts` covers pay arithmetic (joiners, leavers, mid-month raises, prorated stipends), who is included in a run and why others are left out, one run per month even under concurrent requests, adjustments and holds, the bank file (account numbers never logged), idempotent payments that record one expense each, failures, the workspace lock on months in a run, payslips and "my pay".

`backend/test/finance-slice2.test.ts` covers budgets (hand-worked spent, committed and available, a startup's share of shared costs), recurring due dates and duplicate-safe creation, the daily job's secret and digest, subscriptions, seats and alerts, and events.

`backend/test/finance.test.ts` covers roles, scope isolation, the expense workflow, idempotent payment, corrections, races, cost splitting to the paisa, dashboard totals (no double counting), claims, file handling, pay setup and bank encryption. Run with a local database:

```bash
T=postgresql://test@127.0.0.1:55432/devup_test
DATABASE_URL=$T DIRECT_URL=$T TEST_DATABASE_URL=$T npm test
```

Always set `DATABASE_URL` and `DIRECT_URL` as well: `backend/.env` points at production.
