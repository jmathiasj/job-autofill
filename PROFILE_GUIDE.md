# Filling out your profile (`profile.json`)

Your profile is the **single source of truth** for everything the extension
fills. The grounding rule is absolute: **if a fact is not in this file (or
your resume PDF / learned answers), the extension leaves the field blank for
you - it never guesses.** So the more complete and accurate this file is, the
more of every application fills itself.

## Setup

```bash
cp profile.example.json profile.json
```

Edit `profile.json` in any editor, or paste it into the extension popup
(**Format / validate** checks your JSON). Empty strings (`""`) are simply
skipped - fill what applies to you, delete nothing.

After any edit: reload the extension at `chrome://extensions` (⟳).

---

## Section by section

### `identity`
Name, email, phone, location. Used constantly and filled deterministically
(no AI involved). Phone format: any human format works
(`+1-555-123-4567`) - the extension converts to the bare 10-digit national
number on platforms that need it (Workday).
`full_name` also names your uploaded files (`Your_Name_Resume.pdf`).

### `links`
LinkedIn / GitHub / portfolio / website URLs. Filled verbatim - and a safety
check rejects any URL the AI produces that isn't literally in this file.

### `work_eligibility`
The highest-stakes section - fill it carefully and truthfully:

| Field | Example (citizen) | Example (visa holder) |
|---|---|---|
| `authorized_to_work_us` | `"Yes"` | `"Yes"` |
| `require_sponsorship_now_or_future` | `"No"` | `"Yes"` |
| `sponsorship_details` | `""` | `"Currently on H-1B; will require transfer/sponsorship"` |
| `visa_status` | `"U.S. Citizen"` | `"H-1B"` |
| `citizenship` | `"United States"` | `"India"` |
| `us_citizen` | `"Yes"` | `"No"` |

These drive the many phrasings of sponsorship/citizenship questions
("Do you now or in the future require…", "Are you a citizen of…"). The AI
answers *only* from these values - e.g. "citizen of Cuba, Iran…?" is answered
No because your `citizenship` says otherwise.

### `logistics`
Years of experience, relocation, remote/onsite preference,
`current_location`, start date, notice period, salary stance, travel.
Tip: keep `salary_expectation` non-committal ("Open to discussion…") - salary
fields are treated as sensitive and surfaced for your review anyway.

### `eeo_voluntary`
Demographic self-identification (gender, race/ethnicity, veteran status,
disability status). **Optional.** If filled, use the exact phrasing you want
on forms (e.g. `"No, I do not have a disability"`). These fill only from
these literal values - the AI is forbidden from deciding them. Leave empty
to always answer these yourself.

### `education` — **order matters**
`education[0]` must be your **most recent** degree. On Workday-style forms
the extension creates one Education block per entry and assigns them in
order: section 1 = `education[0]`, section 2 = `education[1]`, etc.
Dates as `"Aug 2021"`-style strings; they convert to MM/YYYY where needed.

### `experience` — **order matters**
Same rule: `experience[0]` = current/most recent role, with `"current": true`
(that answers "I currently work here" and leaves end-dates blank).
`highlights` are used **verbatim** for "Role Description" fields - write them
as the resume bullets you want pasted, one string each.

### `projects_publications`, `skills`, `leadership`
Feed the AI's context for skills questions and essay drafting. Skills also
answer "rate your experience with X"-type questions - if a skill isn't listed
here or in your experience, the AI won't claim it.

### `narrative`
Short first-person blurbs (intro, strengths, why-company template) the AI
draws on when drafting essays and cover letters. You can embed standing
drafting instructions here too - e.g. a note like "never mention X, always
lead with Y" inside a narrative field will steer every draft.

### `answer_bank` — your standing preferences
Plain `"question": "answer"` pairs. This is where you teach the extension
your answers to recurring screener questions:

```json
"answer_bank": {
  "How did you hear about us?": "LinkedIn",
  "Have you ever been employed by this company or one of its affiliates?": "No",
  "Do you opt-in to receive text messages from recruiting?": "Yes",
  "Which U.S. State do you reside in?": "California"
}
```

How matching works, so you know what to expect:
- **Exact question** (ignoring case/punctuation) → fills instantly, no AI.
- **≥80% similar** wording → auto-fills your answer (verified like any fill).
- **65-80% similar** → appears pre-filled in the review panel for one click -
  deliberately not automatic, because this band contains traps where similar
  wording needs a different answer ("authorized to work" vs "authorized
  *without sponsorship*").
- Everything else → the AI sees your whole bank as "answers you've previously
  given" and generalizes (e.g. your "No" to *"employed by Stripe or a Stripe
  affiliate?"* correctly becomes "No" for any other company - and "Yes" for a
  company that actually appears in your `experience`).

Tip: when you add an entry from a real form, add it **twice** - once with the
exact wording you saw, once with the company name replaced by "this company".

The bank also grows on its own: every answer you type or correct on a real
form is captured automatically. The curated entries here and the learned ones
merge, with your real-form corrections taking precedence.

---

## Updating later

- **Facts changed** (new role, moved cities, visa change): edit `profile.json`,
  reload the extension. Done.
- **A form asked something new**: just answer it on the form once - it's
  learned automatically. Promote it to `answer_bank` if you want it permanent
  and file-backed.
- **Wrong answer got learned**: fix it on any form (corrections override), or
  clear the learned bank by removing `answerBank` via the popup's profile
  editor / extension storage.

## What NOT to put here

- Placeholder text ("TODO", "fill me in") - leave fields `""` instead, so
  they're skipped rather than filled with junk.
- Anything untrue. The extension is built to survive a recruiter's scrutiny:
  it will faithfully reproduce whatever you write, on every application.
- API keys or secrets - those go in `secrets.js` or the popup, never here.
