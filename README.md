# AutoApply — Job Application Autofill (Chrome Extension)

A Manifest V3 Chrome extension that fills job applications from your own data,
drafts free-text answers from your resume + the job description, and **learns
from what you fill** so it gets better over time. Works on **Greenhouse, Lever,
Ashby, and Workday**. It never auto-submits — you always review and submit.

## What it does

- **Universal field mapper (LLM):** reads each question + your profile + the job
  description and decides what to fill — works on any form, no per-site rules.
- **Essay drafting (LLM):** drafts free-text answers from your resume + the JD.
- **Feedback / learning loop:** every field you fill or correct is saved to an
  answer bank and fed back in next time — both to the LLM and as direct fills.
- **Safety boundaries:** sensitive fields (work authorization, salary, EEO),
  legal acknowledgements, and CAPTCHAs are **left to you**, never auto-filled.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how it works internally.

---

## Adopt it (first-time setup, ~5 minutes)

The extension code gives you the mapper and the learning loop automatically.
Three things are **yours** and not included in this repo — you supply them:
your profile data, your resume/cover-letter PDFs, and your Anthropic API key.

### 1. Get the code

```bash
git clone git@github.com:jmathiasj/job-autofill.git
cd job-autofill
```

(Or download the folder as a zip and unzip it.)

### 2. Add your profile data

Copy the template and fill in **your** details:

```bash
cp profile.example.json profile.json
```

Open `profile.json` and replace the blank values with your name, contact info,
work eligibility, education, and experience.

### 3. Add your documents

Put your own PDFs in the `docs/` folder, named exactly:

```
docs/resume.pdf
docs/cover_letter.pdf
```

### 4. Add your Anthropic API key

The LLM mapper and essay drafting need a key. Get one at
<https://console.anthropic.com>. You enter it in the extension popup in step 6
(it is stored locally in the browser, never committed).

> Without a key the extension still runs, but falls back to keyword matching
> instead of the LLM mapper.

### 5. Load the extension in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this project folder
5. The **AutoApply** icon appears in your toolbar

### 6. Set your key

Click the **AutoApply** toolbar icon → paste your Anthropic API key → save.
The popup also lets you confirm your resume is picked up.

### 7. Use it

1. Open a job application on Greenhouse / Lever / Ashby / Workday
2. The docked **AutoApply** panel appears on the page
3. Click **⚡ Autofill this page**
4. Review every field, fix anything wrong, fill the sensitive ones yourself
5. **You** click submit

That's it. As you fill and correct fields, the answer bank grows and future
applications get more accurate automatically.

---

## Your data stays yours

`profile.json`, `docs/resume.pdf`, and `docs/cover_letter.pdf` are listed in
`.gitignore` — they are **never committed** to the repo. Your learned answer
bank lives only in your browser's local storage. Each person who adopts this
uses their own profile, documents, and key.

## Current status / limits

- LLM mapping + drafting and the learn → store → feed-back loop are implemented
  and working end to end.
- Semantic vector retrieval (`lib/transformers.min.js`) is bundled but **not yet
  wired in** — matching is currently keyword/Jaccard based.
- The fragile part is the per-widget fill layer for unusual react-select /
  Workday controls; some exotic widgets may need a manual fill.
