# Electronic records and signatures (21 CFR Part 11)

This page maps the controls of FDA 21 CFR Part 11 (and EU GMP Annex 11, which
asks for much the same) to what the dashboards server provides. It is written
for the quality and validation teams of regulated (GxP) users.

**Software alone does not make a system compliant.** Part 11 compliance is a
property of a *validated system operated under procedures*. The software
supplies technical controls. The regulated company validates the system for
its intended use, writes and follows the procedures, and trains its people. The
second column below says which is which.

## What the software records

- **Every change to a dashboard is a version** (Dashboards → **History**).
  - Each save appends an immutable version: the full spec as saved, who saved
    it, when (UTC), and the SHA-256 fingerprint of its canonical JSON.
  - Versions are never rewritten or deleted, not even when the dashboard is.
  - Restoring an old version saves it again as a new version, so the history
    only grows.
  - Every version can be opened and previewed read-only.
- **Electronic signatures** apply to one specific version:
  - The signer re-authenticates at signing: password accounts enter their
    password, and single sign-on accounts must have signed in within the last
    few minutes (otherwise they are sent back through the provider with
    `prompt=login`).
  - The signer chooses a **meaning** (`Authored`, `Reviewed`, `Approved`, set
    by `CXD_SIGNATURE_MEANINGS`).
  - The signature stores the signer, the meaning, the UTC time, the method, and
    the version's fingerprint.
  - It is **shown with the record**: name, date/time and meaning appear under the
    signed version in History.
  - An edit makes a new, unsigned version, and the signed one stays as it was.
- **Tamper evidence:**
  - Signatures are hash-chained, each including the previous one's hash.
  - A signature is reported invalid if the signed version's content no longer
    matches its fingerprint.
  - `GET /api/admin/signatures/verify` re-checks every signature: the chain and
    the content each one is bound to.
- **The audit trail** (Admin → *Audit log*) records who did what and when:
  - sign-ins (including failed ones);
  - saves (with the version number), restores, signings (with meaning and
    method), opens of old versions;
  - shares, security changes and deletions.
  - It is append-only and hash-chained (**Verify chain**), and exportable as
    CSV/JSON for inspection.

## Control-by-control

| Part 11 | Requirement | Provided by the software | The regulated company |
|---|---|---|---|
| §11.10(a) | Validation: accuracy, reliability, ability to discern invalid or altered records | Tamper evidence: hash-chained audit log and signatures; `verify` endpoints; fingerprinted versions. An automated test suite covers these controls. | Validates the installed system for its intended use (IQ/OQ/PQ or a risk-based CSV/CSA approach). |
| §11.10(b) | Accurate and complete copies, human-readable and electronic | Any version opens read-only in History, and its full spec is available as JSON (`/versions/{n}`). The current dashboard exports as self-contained HTML, PNG or PDF. The audit log exports as CSV/JSON. | Defines how copies are produced for inspection. |
| §11.10(c) | Protection of records for their retention period | Versions and signatures are never deleted by the application. They live in the database. | Backups, retention periods, archiving and restore tests ([deployment](deployment.md#backups)). |
| §11.10(d) | Limiting access to authorized individuals | Accounts, roles and permissions, groups, per-dashboard and per-dataset sharing, and row/column security ([governance](governance.md)). Single sign-on with the company directory ([SSO](sso.md)). | Access management procedures; periodic access review. |
| §11.10(e) | Secure, computer-generated, time-stamped audit trails of operator actions that do not obscure prior information | The audit log records every create/modify/delete with user and UTC time. Old versions stay, so a change never obscures what was there. Append-only and hash-chained. | Reviews audit trails per procedure; keeps them as long as the records. |
| §11.10(f) | Operational system checks (sequencing of steps) | A signature applies to a specific version; an edit creates a new, unsigned version. | Defines the review/approval workflow (which meanings, in what order) in an SOP. |
| §11.10(g) | Authority checks | Permissions decide who may create, share, schedule or sign (`dashboard.sign`); locks protect records. | Assigns roles per procedure. |
| §11.10(h) | Device checks | Not applicable to a web application in the usual reading. | Assesses where it applies. |
| §11.10(i) | Training of people who develop, maintain or use the system | — | Trains and documents. |
| §11.10(j) | Written policies holding individuals accountable for e-signatures | — | Signature policy and certification to the FDA (§11.100(c)). |
| §11.10(k) | Control over system documentation | This documentation, versioned with the code. | Controls its copies and change management. |
| §11.50 | Signature manifestation: printed name, date/time, meaning | Shown under the signed version (user name, UTC date/time, meaning). | Ensures user names identify people (e.g. SSO usernames or full names). |
| §11.70 | Signature/record linking: cannot be excised, copied or transferred to falsify | The signature carries the version's SHA-256, and its owner, dashboard and version are part of its hash. Editing the signed content is detected. So is editing, re-pointing or reordering a signature, or removing any but the newest. Each signing is also a separate `dashboard.sign` event in the audit log, so a removed newest signature still shows there. | Protects the database (access, backups) so records cannot be removed wholesale. |
| §11.100 | Uniqueness of e-signatures; identity verification | One account per person; single sign-on ties accounts to the company identity provider. | Verifies identities; never reassigns accounts. |
| §11.200(a) | Non-biometric signatures: two components (ID + password); re-authentication | The user must be signed in and re-enter the password (or complete a fresh single sign-on) at each signing. | Password policy (via the identity provider for SSO). |
| §11.300 | Controls for identification codes/passwords | Passwords are stored salted and hashed (PBKDF2). Failed sign-ins are audited. Single sign-on brings the provider's policies (MFA, lockout, expiry). | Password or identity-provider policy; handling of lost credentials. |

## Settings

| Variable | Default | Effect |
|---|---|---|
| `CXD_SIGNATURE_MEANINGS` | `Authored,Reviewed,Approved` | The meanings a signer can choose |
| `CXD_SIGN_REAUTH_SECONDS` | `300` | How recent a single sign-on sign-in must be to sign |

Signing needs the `dashboard.sign` permission (the `editor` role has it; see
[roles](governance.md#roles-and-permissions)).

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/dashboards/{id}/versions?owner=` | Versions, newest first, with their signatures (`valid` per signature), the meanings, `can_sign`, and how to re-authenticate |
| `GET` | `/api/dashboards/{id}/versions/{n}?owner=` | One version's spec |
| `POST` | `/api/dashboards/{id}/versions/{n}/restore?owner=` | Make it current again (saved as a new version; needs edit access) |
| `POST` | `/api/dashboards/{id}/sign?owner=` | `{version, meaning, password?}` → the signature |
| `GET` | `/api/admin/signatures/verify` | Admin: re-check every signature |

Audit actions: `dashboard.save` (with the version number), `dashboard.restore`,
`dashboard.sign`, `dashboard.version.open` and `admin.signatures.verify`.
