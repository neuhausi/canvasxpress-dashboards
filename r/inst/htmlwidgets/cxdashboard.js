// A thin shell: everything that matters (reading the payload, suggesting a dashboard, waiting for the
// engine, rendering, readable errors) is CanvasXpressDashboards.renderPayload, shared by every
// language wrapper. This file only adds what is specific to htmlwidgets and Shiny.
HTMLWidgets.widget({
  name: 'cxdashboard',
  type: 'output',

  factory: function (el) {
    var handle = null;
    var generation = 0;     // a newer renderValue() supersedes an older, still-pending render

    // Report back to a Shiny app as input$<outputId>_<name>.
    function publish(name, value) {
      if (window.HTMLWidgets && HTMLWidgets.shinyMode && window.Shiny && Shiny.setInputValue) {
        Shiny.setInputValue(el.id + '_' + name, value, { priority: 'event' });
      }
    }

    return {
      renderValue: function (x) {
        var mine = ++generation;
        if (handle && typeof handle.destroy === 'function') { try { handle.destroy(); } catch (e) { /* gone */ } }
        handle = null;
        el.style.height = 'auto';
        // Static pages load scripts in order, but Shiny injects a widget's dependencies dynamically:
        // renderPayload waits (bounded) for the bundle and the engine.
        var ready = window.CanvasXpressDashboards && window.CanvasXpressDashboards.renderPayload;
        if (!ready) {
          var wait = setInterval(function () {
            if (window.CanvasXpressDashboards && window.CanvasXpressDashboards.renderPayload) { clearInterval(wait); run(); }
          }, 50);
          setTimeout(function () { clearInterval(wait); }, 20000);
          return;
        }
        run();

        function run() {
          if (mine !== generation) return;
          window.CanvasXpressDashboards.renderPayload(el, x, {
            idPrefix: 'cxdashboard-' + el.id,
            isCurrent: function () { return mine === generation; },
            onTemplate: function (template) { publish('template', template); },
            // Report once the panels hold the new data, so the app sees a settled dashboard.
            onParamChange: function (name, value, done, h) {
              Promise.resolve(done).then(function () { if (mine === generation && (h || handle)) publish('params', (h || handle).getParams()); });
            }
          }).then(function (h) {
            if (!h || mine !== generation) return;
            handle = h;
            publish('params', h.getParams());
          });
        }
      },

      resize: function () { /* the layout follows its container */ },

      // Used by the Shiny proxy messages below.
      call: function (method, args) {
        if (!handle) return;
        if (method === 'setParam') handle.setParam(args.name, args.value);
        else if (method === 'focusPanel') handle.focusPanel(args.panel);
      },
      getHandle: function () { return handle; }
    };
  }
});

if (window.HTMLWidgets && HTMLWidgets.shinyMode && window.Shiny) {
  Shiny.addCustomMessageHandler('cxdashboard-proxy', function (message) {
    var widget = HTMLWidgets.find('#' + message.id);
    if (widget) widget.call(message.method, message.args || {});
  });
}
