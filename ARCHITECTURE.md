# Jenell Autofill — Extension Architecture

An **LLM-as-universal-mapper** Chrome extension (Manifest V3) that fills job
applications from your data, drafts free-text from your resume + the job
description, and learns from what you fill. Works on Greenhouse / Lever /
Ashby / Workday. You always submit.

## Two contexts, one bridge

```
┌─────────────────────────── YOUR CHROME ───────────────────────────┐
│                                                                   │
│  popup.html/js ──── set once: API key, resume, cover ──► storage  │
│                                                                   │
│  background.js  (service worker — the privileged brain)           │
│    • loadProfile()    profile.json + popup overrides              │
│    • bundledDoc()     resume/cover PDF -> base64                  │
│    • mapFields()  <-- THE LLM UNIVERSAL MAPPER (Claude)           │
│    • draftAnswer()    LLM essay drafting                          │
│    • answerBank       learned answers (chrome.storage)            │
│         ^  chrome.runtime messaging                               │
│         |  (getProfile / mapFields / draft / getDoc / learn)      │
│  content.js  (in-page — runs ON the application form)             │
│    detect -> extractJD -> enumerate -> MAP(LLM) -> fill -> learn  │
│    + docked Shadow-DOM panel  + passive learning                 │
│         v reads/writes the real form DOM                          │
│   [ Greenhouse | Lever | Ashby | Workday ]                       │
└───────────────────────────────────────────────────────────────────┘
```

Why two files: the content script is the only thing that can touch the form's
DOM, but it's sandboxed and can't hold secrets or call APIs. The background
worker holds your key, calls Claude, reads bundled files. They talk over
`chrome.runtime.sendMessage`.

## The run pipeline (one "Autofill" click)

```
1 detectATS()      which ATS (by host)
2 extractJD()      scrape company + title + job description
3 enumerate()      find EVERY field + type + (for dropdowns) options
4 mapFields()  <-- LLM reads each question + your data + options -> values
                   (the universal part: works on ANY form)
5 fill each field  mechanical executors per widget type
6 leftovers        essays drafted; sensitive/legal left to you
7 learn            capture anything you type/correct
```

## Step 3 + 5: widget layer (deterministic, no LLM)

`enumerate()` classifies every control; `fillField()` has an executor for each:

| Widget | How it's filled |
|---|---|
| text / email / tel / textarea | native value setter (React-safe) |
| native select / radio / checkbox | match + set |
| file | DataTransfer + drag-drop simulation |
| buttons (Ashby Yes/No) | click the matching button |
| customselect (react-select) | mousedown to open -> click option |
| combobox (typeahead) | type -> wait for list -> click match |

## Step 4: the brain (LLM, needs API key)

`mapFields()` sends Claude: profile facts + resume + prior answers + job
description + fields (label, type, options) -> returns `{fieldId: value}`.
This is what makes it work on any question with no per-question rules.
Falls back to keyword rules when there is no API key.

## Three memory sources

| Source | What | Where |
|---|---|---|
| profile.json | name, contact, work-auth, experience | bundled |
| documents | resume + cover letter PDFs | bundled `docs/` |
| answerBank | what you type/correct | chrome.storage (grows) |

## Learning loop

A page-wide `change` listener captures every field you fill -> answerBank.
Next time, those feed the LLM as examples (and exact/fuzzy fill repeats).
Keyword-based, not vectors (transformers.js is downloaded but not yet wired).

## What's LLM vs not

- LLM (needs key): `mapFields` (universal mapping) + `draftAnswer` (essays).
- Everything else (no LLM): detection, enumeration, all widget filling,
  learning, storage, keyword matching.

## Files

```
manifest.json    MV3: content scripts (4 ATS), background SW, web-accessible docs
background.js    profile/doc delivery, answerBank, mapFields + draftAnswer (LLM)
content.js       detect / extractJD / enumerate / fill / panel / learn / run
popup.html+js    set API key, pick resume + cover letter
profile.json     your data (from job_application_profile.yaml)
docs/            bundled resume.pdf + cover_letter.pdf
lib/             transformers.min.js (parked — for future vector retrieval)
```

## Safety boundaries

- Sensitive (work-auth, salary, EEO), legal acknowledgements, and CAPTCHAs -> you.
- Never auto-submits. Page text is data, never instructions.

## Honest status

- Sound design; the fragile part is the widget executor layer (step 5) —
  react-select/Ashby widgets vary per site (the long tail).
- The mapper (step 4) generalizes well IF the API key is set.
- Cannot be loaded/run in an automated environment (Chrome blocks scripted
  extension loading), so end-to-end verification requires a real run in Chrome.
```
