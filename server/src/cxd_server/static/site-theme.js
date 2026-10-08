/**
 * Follow the website's style preset inside the Dashboards app.
 *
 * canvasxpress.org lets a visitor pick a style preset (navbar palette icon); the pick
 * is saved in localStorage "cx-site-theme". The app is served same-origin under
 * /dashboards/, so that key is readable here: this sets the same data-site-theme on
 * <html>, which site-themes.css (generated from the website's tokens) turns into the
 * CanvasXpress --cx-ui-* roles the dashboards chrome is built on. Charts inside
 * follow too (the engine's dark roles read the same variables).
 *
 * Precedence: ?theme=<name> in the URL (also saved) > saved pick > none (engine look).
 * Always-dark presets declare --site-theme-mode: dark in site-themes.css; for those
 * the page's data-cx-ui-theme is forced to "dark" (the engine's own dark roles then
 * provide everything the preset does not), and restored to "auto" otherwise.
 *
 * Load AFTER the site-themes.css <link> (the stylesheet must be parsed for the
 * mode lookup) and before paint, i.e. in <head>.
 */
(function () {
  var html = document.documentElement;
  var KEY = 'cx-site-theme';
  var pick = '';
  try {
    var q = (location.search.match(/[?&]theme=([^&]+)/) || [])[1];
    if (q) { pick = decodeURIComponent(q); localStorage.setItem(KEY, pick); }
    else { pick = localStorage.getItem(KEY) || ''; }
  } catch (e) {}

  var apply = function (name) {
    if (!name || name === 'classic' || !/^[a-z0-9-]+$/.test(name)) {
      html.removeAttribute('data-site-theme');
      if (html.getAttribute('data-cx-ui-theme') === 'dark' && html.hasAttribute('data-cx-site-forced-dark')) {
        html.setAttribute('data-cx-ui-theme', 'auto');
      }
      html.removeAttribute('data-cx-site-forced-dark');
      return;
    }
    html.setAttribute('data-site-theme', name);
    var mode = '';
    try { mode = getComputedStyle(html).getPropertyValue('--site-theme-mode').trim(); } catch (e) {}
    if (mode === 'dark') {
      html.setAttribute('data-cx-ui-theme', 'dark');
      html.setAttribute('data-cx-site-forced-dark', '1');
    } else if (html.hasAttribute('data-cx-site-forced-dark')) {
      html.setAttribute('data-cx-ui-theme', 'auto');
      html.removeAttribute('data-cx-site-forced-dark');
    }
  };
  apply(pick);

  /** Switch the preset at runtime (used by a picker, or from the console). */
  window.cxSetSiteTheme = function (name) {
    apply(name);
    try { if (name) { localStorage.setItem(KEY, name); } else { localStorage.removeItem(KEY); } } catch (e) {}
  };

  /* A pick made on the website in another tab applies here on the next change event. */
  try {
    window.addEventListener('storage', function (e) {
      if (e.key === KEY) { apply(e.newValue || ''); }
    });
  } catch (e) {}
})();
