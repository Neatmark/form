# Supabase Setup Guide — Neatmark Image Storage & Security
## What this document covers
1. Creating the two new Storage buckets
2. Making all buckets private
3. Running the SQL (RLS + storage policies + schema)
4. Verifying everything works

---

## Step 1 — Create Storage Buckets

> **Important:** Do this BEFORE running the SQL file, because the SQL tries to insert into `storage.buckets`.
> If the buckets already exist the SQL uses `ON CONFLICT` and will just set them to private — that's fine.

### In the Supabase Dashboard → Storage

1. Open your project → **Storage** (left sidebar)
2. Click **New bucket**
3. Create these **three** buckets (create them one at a time):

| Bucket name       | Public? |
|-------------------|---------|
| `logos`           | ❌ OFF  |
| `original-photos` | ❌ OFF  |
| `small-photos`    | ❌ OFF  |

**For each bucket:**
- Enter the bucket name exactly as shown above (lowercase, hyphens)
- Toggle **"Public bucket"** → **OFF**
- Click **Create bucket**

---

## Step 2 — Run the SQL File

1. Go to your Supabase project → **SQL Editor**
2. Open `supabase-submissions.sql` from this project
3. Paste the entire file into the editor
4. Click **Run**

This does all of the following in one shot:
- Creates the `submissions` table (if it doesn't exist)
- Adds any missing columns (safe to re-run — uses `ADD COLUMN IF NOT EXISTS`)
- Enables **Row Level Security (RLS)** on the `submissions` table
- Sets all three buckets to private
- Creates storage policies (service role access only)
- Creates a "service role only" RLS policy on submissions

---

## Step 3 — Verify Buckets Are Private

After running the SQL:

1. Storage → click on `logos`
2. In the bucket settings panel, confirm "Public bucket" shows as **disabled**
3. Repeat for `original-photos` and `small-photos`

---

## Step 4 — Verify RLS Is Active

1. Go to **Database** → **Tables** → `submissions`
2. Click the **RLS** tab (or look for the shield icon)
3. Confirm "Row level security is enabled"
4. You should see one policy: **"Service role only"**

---

## Step 5 — Verify Storage Policies

1. Go to **Storage** → **Policies**
2. You should see three policies, one per bucket:
   - `Service role logos access`
   - `Service role original-photos access`
   - `Service role small-photos access`

Each should show:
- **Operation:** ALL
- **Target roles:** (none — service role bypasses all RLS)
- **USING expression:** `bucket_id = '...' AND auth.role() = 'service_role'`

---

## Step 6 — Environment Variables Check

Make sure these are set in your Netlify dashboard (Site → Environment variables):

| Variable              | Description                                    |
|-----------------------|------------------------------------------------|
| `SUPABASE_URL`        | Your Supabase project URL                      |
| `SUPABASE_SERVICE_KEY`| Your service role key (secret key, not anon)   |
| `RESEND_API_KEY`      | Resend API key for emails                      |
| `RESEND_FROM_EMAIL`   | Sender address (must be verified in Resend)    |
| `RECIPIENT_EMAIL`     | Admin email to receive intake notifications    |

> ⚠️ Make sure you're using the **service role key** (not the anon/public key).
> The service role key bypasses RLS, which is exactly what the Netlify functions need.

---

## How the New Image Flow Works

```
User uploads image in form
         │
         ▼
/.netlify/functions/upload-photo
         │
         ├── sharp: resize to max 1200px, 80% JPEG quality
         │
         ├── Upload ORIGINAL → Supabase bucket: original-photos
         │   path: originals/{timestamp}_{id}_{filename}.{ext}
         │
         └── Upload SMALL → Supabase bucket: small-photos
             path: small/{timestamp}_{id}_{filename}.jpg
                          │
                          ▼
              Returns: { smallRef, originalRef }
                          │
                          ▼
         Stored in DB as JSON string in q15-inspiration-refs text[]
         e.g. '{"smallRef":"small/...","originalRef":"originals/..."}'
```

### Email:
- When a form is submitted, `submit.js` fetches each small image from `small-photos`
- Images are base64-encoded and embedded inline in the admin notification email HTML
- Email stays compact; no large originals in the email

### Dashboard:
- `dashboard.js` reads the JSON refs, constructs proxy URLs via `get-photo.js`
- Small version shown in the grid (`/.netlify/functions/get-photo?bucket=small-photos&ref=...`)
- Hover shows a zoom icon; click opens the original in a new tab

### Image Serving (proxy):
- All images go through `/.netlify/functions/get-photo`
- This function uses the **service role key** server-side
- Browsers / email clients never have direct bucket access

---

## Troubleshooting

**Images not showing in dashboard:**
- Check browser console for 404 or 403 errors on `get-photo`
- Verify `SUPABASE_SERVICE_KEY` is the service role key, not anon key
- Confirm `small-photos` bucket exists and is not empty

**Upload fails with "Storage upload failed":**
- Confirm both `original-photos` and `small-photos` buckets exist
- Check Netlify function logs for the specific Supabase error message
- The `sharp` dependency requires a fresh `npm install` — make sure Netlify rebuilt after adding it to `package.json`

**sharp not found error in Netlify logs:**
- Confirm `netlify.toml` has `external_node_modules = ["sharp"]` under `[functions]`
- Trigger a fresh deploy (clear cache if needed)

**Existing uploads (old format) show broken images:**
- Old uploads stored plain refs in the `logos` bucket
- The new `parsePhotoRef` helper handles legacy plain-string refs gracefully
- Old images will be served via `get-logo` (old bucket) — they won't break
