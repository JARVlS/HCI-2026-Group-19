# Reading the usage log

Arbor records how its interface is used in live mode, so the group can compare design variants in
the course's A/B study (IMPLEMENTATION_PLAN.md M6) and find the places where the interface gets in
the way. This page says what the log can answer, how to derive the study measures from it, and
what is still missing.

How the log works (the event catalogue, sending, caps) is in
[`frontend/README.md` → Usage log](../frontend/README.md#usage-log). The routes that read it are in
[`backend/docs/api.md`](../backend/docs/api.md).

## Ground rules

- **The interface is under study, not the person.** Every question below compares conditions or
  looks for friction in the design. Results are reported per condition, as per-participant
  measures and group comparisons (M6 analysis plan), and never as one person's activity.
- **Live mode only.** The demo (`?demo=1`, provider `scripted`) records nothing and sends nothing.
- **Never recorded:** the session token, passwords, the API keys of an own model, full endpoint
  URLs (only the host), and usernames. The backend files events under a random user id. Tests
  search every event for these values (`frontend/src/lib/events.test.ts`, `app.events.test.ts`).
- **Texts are recorded** (messages, replies, drafts, guesses, titles), each cut to 8,000
  characters. They are needed to check whether the thought linter labels turns correctly
  (ADR-15, M9): a label can only be checked against the text it was given.
- **Access:** only the study team can read raw events (the `/logs` page and the CSV export need
  the backend's admin token). The data lives in the project's database, never in this
  repository. **Exports go in `research/exports/`**, which git ignores. Never commit an export,
  a screenshot of the logs page, or quotes from it.
- **Participants are told** what is recorded before a study session (the consent line planned in
  M6).

## What each part of the log can answer

Every event has an `id`, its `type`, `clientTs` and `conversationId`. Its payload carries `visit`
(random per page load), `seq` (its order within the visit) and `design`. The backend adds the user
id, the user's condition and the server time.

| Area | Events | What it can answer |
|---|---|---|
| **Context** | `session_start` (browser, screen and window size, touch, language, time zone, URL parameters, chat/tree/concept counts, guest or account), `resize` | Which devices and window sizes the layout has to work on; first visit vs. returning with an existing knowledge tree |
| **Conversation** | `turn_sent` (text, length, words, label, thinking percent), `reply_first` / `reply_done` (text, latency, model, stopped), `turn_error`, `retry`, `turn_stopped` | How long prompts are; how fast answers feel; how often a turn fails; which model answered (for the limitations section) |
| **The judge** | `analysis_shown` (label, concepts judged, reasons, new concepts and trees), `score`, `relabel` | Share of "thought along" vs. delegated turns per participant (the primary measure of the score-visibility candidate). `relabel` marks a user who disagrees with the judge's label, a direct signal for the judge's validity |
| **Writing a prompt** | `compose` (time from first key to send, key presses, deletions, pastes, pasted characters), `draft_paste`, `draft_abandoned`, `draft_fill` | How a prompt came about: typed or pasted, how much it was revised (deletions ÷ key presses), how many drafts were given up. This is the "who did the thinking" question Arbor is built around |
| **Feedback while typing** | `filter_rated`, `draft_rated`, `hint_hover` (score line, or an underlined word and its rule) | Whether the linter's rating changes between the first draft and the sent prompt; whether people open the feedback at all |
| **Guess before reveal** | `veil_shown`, `reveal` (guess, its length, time veiled), `veil_skip` | Whether the veil is used or skipped, and how much people write before revealing |
| **Knowledge pane and forest** | `view_start`, `view_change` (via key, command, click), `pane_action` (rest on a leaf, open references, jump to message, scrub), `forest_open` / `forest_close` / `forest_zoom` / `forest_filter`, `pane_tree`, `tree_created` | Time per view (tree vs. outline), pane actions per minute, whether the trees are used for finding things or only looked at |
| **Navigation and discoverability** | `nav` (from, to, via, time to choose), `radial_open` / `radial_cancel` (reason, time), `shortcut`, `command`, `onboarding`, `concept_try`, `squirrel_poke` / `squirrel_tip` | Which ways of moving around people actually use; how learnable the radial menu is (cancel rate, time to choose); which features get found |
| **Re-reading and reuse** | `message_rest`, `message_jump`, `transcript_copy` | Which messages people come back to; whether reply text gets reused |
| **Clicks** | `click` (position in the window and its size, the part of the page and the place inside it, what was pressed as tag and class, the view, mouse or touch, time since the previous click up to 10 s, whether a key was pressed in between) | Which parts of the page get used; how fast people get from one part to another (the logs page's heatmap and its *from part to part* table) |
| **Hover durations** | `hover` (which kind of place, its id, how long, where it began) on messages, leaves, prompt hints, forest trees, the why list, the squirrel and the radial menu's options | Whether hover-driven features are found and how long they hold attention; how long people rest on each radial option before choosing |
| **Attention over time** | `page_hidden` / `page_visible`, `idle_start` / `idle_end` (no input for 60 s on a visible page) | Active time: a visit's length minus its hidden and idle stretches |
| **Robustness** | `client_error`, `load_failed`, `analysis_failed`, `toast`, `offline` / `online`, `events_dropped` | Bugs to fix before and during the study, and whether any data was lost |

## Measures you can compute today

- **Active time per visit:** last minus first event, minus `page_hidden` → `page_visible`
  stretches, minus `idle_end.ms`.
- **Time per pane view:** from `view_start`, `view_change`, the hidden and idle stretches (the logs
  page already does this: `paneTime` in `frontend/src/logs/visit.ts`).
- **Thinking share:** per participant, the mean `turn_sent.thinking` and the share of turns
  labelled own, together and ai (`analysis_shown.mode`).
- **Revision:** `compose.deletes / compose.keys`; the first vs. the last `draft_rated` before a
  `turn_sent`.
- **Pasted share:** `compose.pastedChars / compose.chars` per sent prompt.
- **Pause before writing:** the `reply_done` time compared with the first key of the next prompt
  (`turn_sent.clientTs − compose.ms`).
- **Radial menu:** cancels ÷ opens; median `nav.ms` where `via` is `radial` or `radial_flick`.
- **Answer latency:** `reply_first.ms` and `reply_done.ms`.
- **Navigation speed:** median `click.sincePrev` per pair of regions, with the threshold that separates related clicks (the logs page has it as a slider, up to 10 s). Leave out pairs with `typed` when typing is not part of the path.
- **Hover to action:** the share of `hover`s with a click inside `[clientTs − ms, clientTs]`, per kind of place.
- **Radial choice time:** per option, the dwell of the last `hover` (`radial`) before a `nav` via `radial`; compare with `nav.ms` for the whole gesture.
- **Cost:** the `usage` table (tokens per user, day and task).

## Reading the data correctly

- A **visit** is one page load, not one person or one study session. A reload starts a new visit.
  A **user** is one browser for a guest, or one account. Analyse per participant id once it is
  set (see below).
- Order events within a visit by `seq`. `clientTs` is the device's clock. `server_ts` is the
  same for a whole batch.
- Events wait in the browser and go out in batches. A visit cut off offline arrives with the next
  visit, under its own `visit` id.
- `events_dropped` means the local queue overflowed, and its `count` says how many events were
  lost. Report it if it appears.
- A text field shorter than its `chars` value was cut at 8,000 characters.
- `click` and `hover` hold no text: positions, window sizes, fixed names of parts of the page and their classes, and ids. Positions only compare across visits with a similar window size; regions compare across all of them.

## Not logged yet (24 Nov 2026)

| What | Why it matters | Where |
|---|---|---|
| **Participant id and condition.** The app creates its session without them, so `users.condition` is empty for everyone | The export cannot be split into A and B | M6 `StudyConfig`: read `?pid&cond` and send them with `POST /api/session` (the backend already accepts both) |
| **`task_start` / `task_end`** with a task id | Without them the study task cannot be told apart from free exploration, and time on task is guesswork | M6 study task script |
| **What a condition showed**, e.g. `score_shown`, or `block_start` with the active variant | A check, from the log itself, that the two conditions really differed only in the IV | M6 score visibility test, thinking feedback variants |
| **`quiz_answer`** with correctness, **`nudge_action`** | Learning outcome and response to nudges | M6 event log |
| **Mastery `P(L)`** after each attempt | The descriptive BKT section | M6 |
| **A draft id** on `filter_rated`, `draft_rated`, `hint_hover`, `draft_paste`, `compose` | These events can only be tied to one prompt by their timing today | `frontend/src/lib/draftLog.ts` |
| **Reading a reply** (time on screen, scrolled to the end) | Long replies may go unread; `message_rest` is only a weak stand-in | proposal |
| **Window focus and blur** | The window can lose focus without being hidden (another app alongside it), which counts as active time today | proposal, `frontend/src/lib/pageEvents.ts` |

Suggested order: the first two (without them nothing above answers the A/B question), then what a
condition showed, then the draft id, quiz and mastery. A script in `research/` that turns an
export into one row per participant (active time, thinking share, revision, pasted share, pane
use, radial stats) would let the pilot data be checked on its first day.
