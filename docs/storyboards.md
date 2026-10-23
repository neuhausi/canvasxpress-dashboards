# Storyboards

A storyboard is a guided tour of a dashboard: an ordered list of steps, each a complete view of the
dashboard with a title and a line of narration. A player bar above the board has previous, play and next
buttons and a dot per step. Stepping applies the dashboard's own state (its filters, its parameters, the
panel in view), so a step is live: the charts re-filter, the case card loads the patient, and the viewer
can stop the tour at any step and explore from there.

```json
{
  "params": { "case": { "value": "P001" } },
  "filterSchemes": { "Drug arm": [{ "dataRef": "data", "field": "arm", "values": ["Drug"] }] },
  "storyboard": {
    "title": "Trial overview",
    "seconds": 8,
    "steps": [
      { "title": "The whole cohort", "narration": "Forty patients, two arms." },
      { "title": "Drug arm only", "narration": "Survival is better on the drug.", "scheme": "Drug arm" },
      { "title": "One patient", "narration": "P007 is a late event in the placebo arm.",
        "params": { "case": "P007" }, "focus": "case", "seconds": 12 }
    ]
  }
}
```

## Steps

| Key | Meaning |
|---|---|
| `title`, `narration` | Plain text shown in the bar. Narration is never read as HTML. |
| `scheme` | A name in `filterSchemes`: the filter state for this step. |
| `filters` | Or: the filter predicates themselves (same shape as a saved scheme). Not both. |
| `params` | Parameter values for this step; every name must be declared in `params`. |
| `focus` | A panel id to scroll into view. |
| `seconds` | How long this step stays up while playing (default: the storyboard's `seconds`, else 8). |

**Every step is the whole view.** Filters a step does not name are cleared and parameters it does not
name return to their defaults, so going back to an earlier step, or jumping to any dot, always shows
exactly that step. To keep something across steps, repeat it.

Playing starts a step's timer once its panels hold the new data, so a slow query does not eat the time.
Playing stops on the last step. Opening the dashboard leaves it as the author saved it: nothing is applied
until the viewer presses play or a step button (left and right arrow keys work when the bar has focus).

## Where it shows

The viewer pages, shared links, the R and Python wrappers (`cxdashboard()`, `Dashboard`) and the embed
all show the player when the spec has a `storyboard`. In code: `mountStoryboard({ spec, handle, container })`
after `renderDashboard`, and `handle.applyView({ scheme, filters, params, focus })` to put the dashboard
in a view yourself.

## Authoring

In the builder, **Data → Storyboard**: set the filters and parameters you want to show, then **+ Step from
the current view** to snapshot them (choose a panel first to bring it into view), write the title and
narration, and reorder or remove steps. Apply saves it in the spec.
