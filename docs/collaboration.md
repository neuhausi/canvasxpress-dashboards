# Collaboration: comments, threads and @mentions

Signed-in viewers of a dashboard can leave **comments**, reply in **threads**,
**@mention** teammates (who get an email), **anchor** a comment to a panel, and
**resolve** a thread. It turns a shared dashboard from a picture into a
conversation. Everything is server-side and audited.

## Who can do what

- **Comment / reply** — anyone who can *view* the dashboard: its owner, a user
  it's shared with (a grant), or any signed-in viewer of a shipped example.
- **Resolve / reopen / delete** — the comment's **author**, the **dashboard
  owner**, or an **admin**.
- Anonymous (link-only) viewers do not see the comments UI; commenting requires
  signing in.

## Using it (hosted app)

1. Open a dashboard in the **viewer** (`view.html?id=…` — e.g. by clicking it on
   the Dashboards page). Comments do **not** appear on the standalone example
   pages or in the Builder.
2. Click the floating **💬 Comments** control (bottom-left; it shows an unread
   count) to open the rail.
3. Type a comment — optionally pick a **panel** to anchor it to, and `@name` to
   mention a teammate. **Reply** threads under a comment; **Resolve** collapses a
   settled thread (reopen any time).

## @mention email

When a comment mentions `@user`, that user is emailed a notification (the
mention, the dashboard, and a link) — provided they're a real user with a
deliverable address and email is configured on the server (`CXD_SMTP_*`; see
[scheduling](scheduling.md) for the SMTP settings). Self-mentions and users
without an address are skipped, and a mail failure never blocks the comment.

## API

All endpoints are under a dashboard and resolve the owner the same way the
dashboard read does (owner / shared grant / shipped example); pass `?owner=` to
act on a dashboard shared with you.

| Method & path | Does |
|---|---|
| `GET /api/dashboards/{id}/comments` | List comments, threaded (`replies` under each root). |
| `POST /api/dashboards/{id}/comments` | Add one. Body: `{ body, panelId?, parentId? }`. |
| `POST /api/dashboards/{id}/comments/{cid}/resolve` | `{ resolved: true|false }`. |
| `DELETE /api/dashboards/{id}/comments/{cid}` | Delete (also removes its replies). |

A comment carries `author`, `created_at`, `mentions` (resolved against real
users), optional `panel_id` and `parent_id`, and `resolved`/`resolved_at`.
Deleting a dashboard removes its comments.

## Embedding the rail yourself

The viewer wires it for you; to add it to your own page, after rendering call:

```js
CanvasXpressDashboards.mountComments({
  baseUrl: '/dashboards',          // the API base
  dashboardId: spec.id,
  owner: owner,                    // when it's a dashboard shared with you
  currentUser: 'alice',            // from /auth/me
  users: ['bob', 'carol'],         // for @mention highlighting (from /api/directory)
  panels: [{ id: 'p1', title: 'Revenue' }]   // for the anchor picker + badge
});
```
