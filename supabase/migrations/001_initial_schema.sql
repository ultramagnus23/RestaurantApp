-- ============================================
-- MEZA: DIAGNOSTIC TOOL SCHEMA
-- ============================================
-- Fresh schema for the "Final Build" spec - a small, single-purpose
-- diagnostic tool (POS CSV in, one printable revenue-leak finding out),
-- not a restaurant intelligence platform. The old schema (occupancy,
-- experiments, environment, recommendations, etc.) is preserved in full
-- history on the archive/legacy branch, not carried forward here.
--
-- RLS: every table scoped by restaurant_id via a plain owner-chain
-- (restaurant_id -> restaurants.owner_id -> auth.uid()). No demo-mode/
-- multi-tenant machinery - this tool is explicitly single-founder,
-- single-venue-at-a-time; a cross-tenant RLS test still applies (a
-- second restaurant/owner must never see the first's rows), it just
-- doesn't need the is_writable_restaurant()-style demo gating the old
-- schema had.

create extension if not exists pgcrypto;

-- ============================================
-- RESTAURANTS (venues)
-- ============================================

create table restaurants (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    name text not null,
    location text not null,
    timezone text not null default 'Asia/Kolkata',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index idx_restaurants_owner on restaurants(owner_id);

alter table restaurants enable row level security;

create policy "Owners can view their restaurants"
    on restaurants for select
    using (owner_id = auth.uid());

create policy "Owners can create restaurants"
    on restaurants for insert
    with check (owner_id = auth.uid());

create policy "Owners can update their restaurants"
    on restaurants for update
    using (owner_id = auth.uid());

-- ============================================
-- VENUE COLUMN MAPS
-- ============================================
-- Saves each venue's CSV column -> canonical field mapping so re-uploads
-- auto-apply it instead of re-asking. One active mapping per venue - a
-- new upload's interactive mapping step overwrites it, not versions it
-- (no history need at this scope).

create table venue_column_maps (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    -- canonical field name -> source CSV column name, e.g.
    -- {"external_bill_id": "Bill No", "gross": "Net Amount", ...}
    mapping jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (restaurant_id)
);

alter table venue_column_maps enable row level security;

create policy "Owners can view their column maps"
    on venue_column_maps for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can manage their column maps"
    on venue_column_maps for all
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

-- ============================================
-- INGESTION BATCHES
-- ============================================
-- One row per CSV upload attempt - the observability trail ground rule 2
-- requires ("any analysis that can't run says why"): how many rows came
-- in, how many parsed, how many were rejected and why.

create table ingestion_batches (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    filename text,
    uploaded_at timestamptz not null default now(),
    rows_in integer not null default 0,
    rows_parsed integer not null default 0,
    rows_rejected integer not null default 0,
    -- array of {row_number, reason} - never just a count, per ground rule 2
    -- ("any analysis that can't run says why, in plain language").
    rejection_reasons jsonb not null default '[]'
);

create index idx_ingestion_batches_restaurant_time on ingestion_batches(restaurant_id, uploaded_at desc);

alter table ingestion_batches enable row level security;

create policy "Owners can view their ingestion batches"
    on ingestion_batches for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can insert ingestion batches"
    on ingestion_batches for insert
    with check (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

-- ============================================
-- BILLS
-- ============================================
-- external_bill_id is unique per venue, not globally - the idempotency
-- key a re-ingest upserts against. PII (customer name, phone number) is
-- scrubbed before this row is ever written - see ground rule 3 and its
-- proving test (app-layer, not enforceable at the schema level alone,
-- since the columns to hold that PII simply don't exist here).

create table bills (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    external_bill_id text not null,
    opened_at timestamptz not null,
    settled_at timestamptz,
    table_ref text,
    gross numeric(10,2) not null,
    discount numeric(10,2) not null default 0,
    payment_type text check (payment_type in ('upi', 'card', 'cash', 'other')),
    created_at timestamptz not null default now(),
    unique (restaurant_id, external_bill_id)
);

create index idx_bills_restaurant_opened on bills(restaurant_id, opened_at desc);

alter table bills enable row level security;

create policy "Owners can view their bills"
    on bills for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can manage their bills"
    on bills for all
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

-- ============================================
-- BILL ITEMS
-- ============================================

create table bill_items (
    id uuid primary key default gen_random_uuid(),
    bill_id uuid not null references bills(id) on delete cascade,
    item_name_raw text not null,
    item_name_norm text,
    category text,
    qty numeric(8,2) not null default 1,
    price numeric(10,2) not null,
    created_at timestamptz not null default now()
);

create index idx_bill_items_bill on bill_items(bill_id);
create index idx_bill_items_name_norm on bill_items(item_name_norm) where item_name_norm is not null;

alter table bill_items enable row level security;

create policy "Owners can view their bill items"
    on bill_items for select
    using (bill_id in (
        select id from bills where restaurant_id in (
            select id from restaurants where owner_id = auth.uid()
        )
    ));

create policy "Owners can manage their bill items"
    on bill_items for all
    using (bill_id in (
        select id from bills where restaurant_id in (
            select id from restaurants where owner_id = auth.uid()
        )
    ));

-- ============================================
-- DISH COSTS
-- ============================================
-- Manual entry, up to ~15 dishes (enforced app-side, not a hard DB cap).
-- The only cost data that exists - never inferred, never estimated.

create table dish_costs (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    item text not null,
    cost numeric(10,2) not null,
    price numeric(10,2) not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index idx_dish_costs_restaurant on dish_costs(restaurant_id);

alter table dish_costs enable row level security;

create policy "Owners can view their dish costs"
    on dish_costs for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can manage their dish costs"
    on dish_costs for all
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

-- ============================================
-- DATA QUALITY PROFILES
-- ============================================
-- Computed automatically after every ingest. capability_mask carries the
-- plain-language, owner-readable suppression reasons that get printed
-- verbatim on the one-pager - written for an owner, not an engineer.

create table data_quality_profiles (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    computed_at timestamptz not null default now(),
    timestamps_live boolean,
    timestamps_evidence jsonb,
    table_ref_coverage_pct numeric(5,2),
    item_name_consistency_pct numeric(5,2),
    history_depth_days integer,
    weekly_volume numeric(8,2),
    -- {"attach_rate": {"allowed": true, "reason": null},
    --  "menu_mix": {"allowed": true, "reason": null},
    --  "turnover_dwell": {"allowed": false, "reason": "Table-time analysis
    --    not possible: bills are entered together at closing, so
    --    individual table timings aren't real."}}
    capability_mask jsonb not null default '{}'
);

create index idx_dqp_restaurant_time on data_quality_profiles(restaurant_id, computed_at desc);

alter table data_quality_profiles enable row level security;

create policy "Owners can view their data quality profiles"
    on data_quality_profiles for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can insert data quality profiles"
    on data_quality_profiles for insert
    with check (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

-- ============================================
-- LEAK FINDINGS
-- ============================================

create table leak_findings (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    rule text not null,
    scope text,
    size_inr_month numeric(10,2),
    confidence numeric(5,2),
    -- the inline evidence + arithmetic a reader can audit - never just a
    -- headline number with nothing behind it.
    evidence jsonb not null default '{}',
    status text not null default 'candidate'
        check (status in ('candidate', 'insufficient_data', 'suppressed')),
    computed_at timestamptz not null default now()
);

create index idx_leak_findings_restaurant_time on leak_findings(restaurant_id, computed_at desc);

alter table leak_findings enable row level security;

create policy "Owners can view their leak findings"
    on leak_findings for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can insert leak findings"
    on leak_findings for insert
    with check (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

-- ============================================
-- REPORTS
-- ============================================
-- draft -> reviewed -> delivered. "delivered" requires an explicit manual
-- action - nothing in this schema or any job auto-advances a report past
-- "reviewed". snapshot freezes the one-pager's content at generation time
-- so what was reviewed/delivered can't silently drift if underlying data
-- changes later - auditable, not just re-computed on demand.

create table reports (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    status text not null default 'draft' check (status in ('draft', 'reviewed', 'delivered')),
    headline_finding_id uuid references leak_findings(id) on delete set null,
    snapshot jsonb not null default '{}',
    generated_at timestamptz not null default now(),
    reviewed_at timestamptz,
    delivered_at timestamptz
);

create index idx_reports_restaurant_time on reports(restaurant_id, generated_at desc);

alter table reports enable row level security;

create policy "Owners can view their reports"
    on reports for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can manage their reports"
    on reports for all
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));
