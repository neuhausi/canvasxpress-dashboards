## Resubmission

This is a resubmission of 0.1.0. In response to the CRAN review, I have:

* Single-quoted the remaining software names in the Title and Description.
  'R Markdown' and 'Quarto' are now quoted, matching the already-quoted
  'CanvasXpress', 'htmlwidgets', 'RStudio' and 'shiny'. This also resolves the
  "possibly misspelled words: RStudio" note.

## Test environments

* local macOS, R 4.5.3

## R CMD check results

0 errors | 0 warnings | 1 note

* The note is "New submission".

I ran the check with `--no-manual` because the machine has no LaTeX; the HTML
manual builds without problems.

## Notes

The package bundles one minified JavaScript file,
`inst/htmlwidgets/lib/canvasxpress-dashboards/canvasxpress-dashboards.umd.js`.
It is MIT-licensed and written by the package author (see `inst/COPYRIGHTS` and
`inst/htmlwidgets/LICENSE.dashboards-js`). The unminified source is at
https://github.com/neuhausi/canvasxpress-dashboards (src/), and the file is
generated from it.

The package suggests 'canvasXpress' (already on CRAN) but doesn't require it.
Examples and tests don't use the network.
