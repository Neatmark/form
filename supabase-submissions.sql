-- Supabase schema for Netlify form submissions
-- Uses quoted identifiers to match hyphenated field names from the form payload.

create extension if not exists "pgcrypto";

create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  history jsonb not null default '[]'::jsonb,
  "status" text not null default 'pending',
  "project-status" text,
  "client-name" text,
  "brand-name" text,
  "email" text,
  "delivery-date" text,
  "agreed-delivery-date" text,
  "q1-business-description" text,
  "q2-problem-transformation" text,
  "q3-ideal-customer" text,
  "q4-competitors" text,
  "q5-brand-personality" text,
  "q6-playful-serious" text,
  "q6-minimalist-expressive" text,
  "q6-approachable-authoritative" text,
  "q6-classic-contemporary" text,
  "q7-core-values" text,
  "q8-positioning" text,
  "q9-success-vision" text,
  "q10-brands-admired" text,
  "q11-brands-disliked" text,
  "q12-color" text[],
  "q13-colors-to-avoid" text,
  "q14-typography" text[],
  "q15-aesthetic" text[],
  "q15-aesthetic-description" text,
  "q16-brand-space" text,
  "q17-existing-assets" text,
  "q18-deliverables" text[],
  "q19-first-feeling" text,
  "q20-inspiration-refs" text[],
  "q21-anything-else" text,
  "brand-logo-ref" text
);

-- Migration for existing tables (run once if the table already exists):
-- alter table submissions add column if not exists history jsonb not null default '[]'::jsonb;
-- alter table submissions add column if not exists "brand-logo-ref" text;
-- alter table submissions add column if not exists "agreed-delivery-date" text;
-- alter table submissions add column if not exists "status" text not null default 'pending';
-- alter table submissions add column if not exists "project-status" text;
-- alter table submissions add column if not exists "q20-inspiration-refs" text[];
-- alter table submissions rename column "q20-anything-else" to "q21-anything-else";
