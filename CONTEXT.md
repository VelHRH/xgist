# Glossary

Canonical vocabulary for XGist. Definitions only — no implementation detail.

- **Digest** — the automatic, scheduled run that fetches watched X accounts, ranks new posts, and sends the user previews to approve. Fired hourly by cron; each user is served at their chosen hours.

- **Activated user** — a user who has added at least one Watched account, confirmed their timezone, and confirmed a Digest time. Connecting a Publishing channel is not required to receive Digest Previews.

- **Watched account** — an X account whose posts are considered for a user's Digests.

- **Publishing channel** — the optional Telegram channel to which approved Previews are published. A user can receive Digests without one and is prompted to connect one when they first attempt to publish.

- **Guided setup** — the resumable onboarding flow for users who are not yet activated. It collects Watched accounts one at a time, confirms the user's timezone, and then asks the user to confirm a Digest time. After activation it offers, but does not require, a Publishing channel. Once activated, `/start` shows the user's current status and `/settings` manages the saved configuration.

- **Setup reminder** — the single proactive message sent roughly 24 hours after a user abandons Guided setup while still unactivated. It resumes the exact unfinished step; no further setup reminders are sent.

- **Pro access** — the entitlement to XGist's Pro limits and experience. It can come from a paid subscription, a time-limited promotional trial, courtesy access, or administrator access; the features are identical while the displayed plan label identifies the source honestly.

- **Inactive Pro configuration** — Watched accounts and Digest times saved beyond the Free plan's active limits after Pro access ends. They are retained but do not produce Digests; renewing Pro restores them. The user may choose which configuration remains active on Free.

- **Preview** — a single candidate post sent to the user in their DM with the ✅ Post / ❌ Skip / ✏️ Edit / 🕐 Schedule / 🫥 Spoiler controls. Publishing happens only when the user taps ✅ (or a scheduled publish fires).

- **Scheduled publish** — an *approved* preview queued (via 🕐 Schedule) to be copied into the channel at a chosen future hour. Distinct from the Digest schedule.

- **Paused** — a per-user state in which the automatic Digest skips the user: no fetch, no previews, until they resume. Does not affect already-queued Scheduled publishes, nor manual actions. (User's word for this was "stop scheduled autoscratch".)

- **Thread post** — a channel post built on demand from an X thread link the user pastes, rather than from the automatic Digest. Produces the same kind of Preview, with the same controls, and publishes to the same connected channel. Independent of the user's watched accounts — the pasted tweet can be from anyone.

- **Thread author** — the author of the *linked* tweet. The thread is that author's self-reply chain: walk up from the linked tweet to their first tweet (the root), then forward through consecutive self-replies. A reply into someone else's conversation, or a quote tweet, starts the thread at the linked tweet — other people's tweets are never pulled in.
