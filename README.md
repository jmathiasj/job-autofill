# AutoApply — Job Application Autofill (Chrome Extension)

A Manifest V3 Chrome extension that fills job applications from your own data,
drafts grounded free-text answers from your resume + the job description, and
**learns from what you fill** so it gets better over time. Works on
**Greenhouse, Lever, Ashby, Workday, iCIMS, SmartRecruiters, Workable,
Jobvite, BambooHR, and Taleo**. It never auto-submits — you always review and
submit.

## What it does

- **Universal field mapper (Claude Opus 4.8, structured outputs):** reads each
  question + your profile + the job description and decides what to fill —
  works on any form, no per-site rules. Every answer carries a source and a
  confidence level.
- **Hallucination firewall:** the AI's output is validated deterministically
  before it touches the form — dropdown answers must match a real option
  exactly, emails/phones/links must exist verbatim in your profile, and
  low-confidence answers go to a review queue instead of the form. When the
  data can't answer a question, the field is left blank for you — never guessed.
- **Verified fills:** every fill is read back from the page and confirmed;
  anything that didn't take is flagged, never silently dropped.
- **Workday first-class:** auto-creates your Work Experience / Education
  entries, handles its listbox widgets and split date fields, and an autopilot
  toggle re-runs autofill as the wizard advances pages.
- **Essay drafting + "AI edit":** grounded answers for free-text questions and
  tailored cover letters (textarea or generated PDF). Focus any essay field and
  a ✦ AI edit chip lets you rewrite it with an instruction ("shorter",
  "mention my Rust work") — style is steerable, facts stay locked to your resume.
- **Dual resumes:** bundle a default and an alternate variant; the mapper picks
  per job description (overridable in the panel).
- **Learning loop:** every field you fill or correct is saved to an answer bank
  and fed back next time — both to the AI and as direct fills. Curated
  preferences live in `profile.json`'s `answer_bank`.
- **Applications dashboard:** every run is tracked locally (company, role,
  status funnel: filled → applied → interview → offer), with follow-up
  reminders, CSV export, and a debug-log export.
- **Safety boundaries:** sensitive fields (work authorization, salary, EEO),
  legal acknowledgements, and CAPTCHAs are **left to you**, never auto-decided
  by the AI; demographic self-ID fills only from your exact profile values.

## Adopt it (first-time setup, ~5 minutes)

The extension code gives you the mapper, validation, and the learning loop.
Three things are **yours** and not included in this repo — you supply them:
your profile data, your resume/cover-letter PDFs, and your Anthropic API key.

### 1. Get the code

```bash
git clone <this repo>
cd job-autofill
```

### 2. Add your profile data

```bash
cp profile.example.json profile.json
```

Open `profile.json` and fill in **your** details — name, contact, work
eligibility (including sponsorship details if you need visa sponsorship),
education, and experience. Empty fields are simply skipped. Add any standing
answers to `answer_bank` as `"question": "answer"` pairs — they fill exactly
on matching forms and teach the AI your preferences everywhere else.

**→ See [`PROFILE_GUIDE.md`](./PROFILE_GUIDE.md) for a field-by-field guide**,
including how answer-bank matching works and how to update your data later.

### 3. Add your documents

```
docs/resume.pdf          (required)
docs/resume_ai.pdf       (optional second variant - e.g. AI/ML-targeted)
docs/cover_letter.pdf    (optional default cover letter)
```

Uploads are renamed after the name in your profile automatically.

### 4. Add your Anthropic API key

Get one at <https://console.anthropic.com>. Either paste it in the extension
popup (stored only in your browser), or create a gitignored `secrets.js`:

```js
export const ANTHROPIC_KEY = "sk-ant-...";
```

> Without a key the extension still runs, but falls back to keyword matching
> instead of the AI mapper.

### 5. Load the extension in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. The **AutoApply** icon appears in your toolbar (the popup shows a setup
   checklist: profile / resume / key)

### 6. Use it

1. Open a job application on any supported platform
2. The docked **AutoApply** panel appears (drag its header to move it)
3. Click **⚡ Autofill this page** and watch the step-by-step progress
4. Review: green outlines = filled & verified, amber = needs your eyes; the
   panel lists everything filled and everything needing you
5. Click **✓ Check before submit** — it flags any required field still empty
6. **You** click submit; the dashboard tracks it automatically

## Your data stays yours

`profile.json`, `secrets.js`, and `docs/*.pdf` are gitignored — never
committed. The answer bank, application history, and run logs live only in
your browser's local storage. Nothing is uploaded anywhere except the AI calls
you trigger, which go directly to Anthropic's API.

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md). Short version:

```
detect → [Workday: create sections] → enumerate (shadow-DOM aware)
       → resolve (deterministic: profile rules / answer banks)
       → MAP (LLM, schema-enforced, source + confidence per answer)
       → VALIDATE (deterministic firewall rejects ungrounded output)
       → fill (per-widget executors) → VERIFY (DOM read-back)
       → review queue (human) → learn + track + log
```

## Current status / limits

- The full pipeline (grounded mapping, validation, verified fills, Workday
  sections, learning, dashboard) is implemented and working end to end.
- The fragile part is, as always, the per-widget fill layer for exotic custom
  controls; failures are surfaced in the panel rather than hidden.
- Cannot be verified in CI (Chrome blocks scripted extension loading) — test
  on real postings and use the dashboard's debug-log export to report issues.
