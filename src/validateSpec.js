/**
 * Lightweight, dependency-free validator for the dashboard spec.
 *
 * This is intentionally not a full JSON-Schema engine — it enforces the
 * structural invariants the renderer relies on and returns human-readable
 * errors. The canonical contract is `schema/dashboard.schema.json`; keep the
 * two in sync. For editor autocomplete / CI, validate against that schema with
 * a real JSON-Schema tool; this function is the runtime guard.
 *
 * @module validateSpec
 */

/**
 * Validate a dashboard spec.
 *
 * @param {object} spec - The dashboard spec to validate.
 * @returns {{ valid: boolean, errors: string[] }} Result with a list of
 *   error messages (empty when valid).
 */
export function validateSpec(spec) {
  var errors = [];

  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { valid: false, errors: ['spec must be an object'] };
  }

  if (typeof spec.id !== 'string' || spec.id.length === 0) {
    errors.push('spec.id is required and must be a non-empty string');
  }

  if (spec.version != null && !(Number.isInteger(spec.version) && spec.version >= 1)) {
    errors.push('spec.version must be an integer >= 1');
  }

  // --- layout ---
  var layout = spec.layout;
  if (layout == null || typeof layout !== 'object') {
    errors.push('spec.layout is required and must be an object');
  } else {
    if (!Array.isArray(layout.items)) {
      errors.push('spec.layout.items is required and must be an array');
    } else {
      layout.items.forEach(function (item, i) {
        var at = 'spec.layout.items[' + i + ']';
        if (item == null || typeof item !== 'object') {
          errors.push(at + ' must be an object');
          return;
        }
        if (typeof item.panel !== 'string') {
          errors.push(at + '.panel is required and must be a string');
        } else if (spec.panels == null || !hasOwn(spec.panels, item.panel)) {
          errors.push(at + '.panel "' + item.panel + '" has no matching entry in spec.panels');
        }
        ['x', 'y', 'w', 'h'].forEach(function (k) {
          if (!Number.isInteger(item[k])) {
            errors.push(at + '.' + k + ' is required and must be an integer');
          }
        });
        if (Number.isInteger(item.w) && item.w < 1) errors.push(at + '.w must be >= 1');
        if (Number.isInteger(item.h) && item.h < 1) errors.push(at + '.h must be >= 1');
        if (Number.isInteger(item.x) && item.x < 0) errors.push(at + '.x must be >= 0');
        if (Number.isInteger(item.y) && item.y < 0) errors.push(at + '.y must be >= 0');
      });
    }
    if (layout.cols != null && !(Number.isInteger(layout.cols) && layout.cols >= 1)) {
      errors.push('spec.layout.cols must be an integer >= 1');
    }
  }

  // --- panels ---
  if (spec.panels == null || typeof spec.panels !== 'object' || Array.isArray(spec.panels)) {
    errors.push('spec.panels is required and must be an object map');
  } else {
    Object.keys(spec.panels).forEach(function (key) {
      var panel = spec.panels[key];
      var at = 'spec.panels["' + key + '"]';
      if (panel == null || typeof panel !== 'object') {
        errors.push(at + ' must be an object');
        return;
      }
      // A param control with a static option list drives a backend query and
      // needs no data of its own, so it is exempt from the data requirement.
      var paramWithOptions = panel.type === 'control' && panel.mode === 'param' &&
        Array.isArray(panel.options);
      if (panel.type !== 'text' && !paramWithOptions && panel.dataRef == null && panel.data == null) {
        errors.push(at + ' must have either a dataRef or inline data');
      }
      if (panel.type === 'control') {
        if (panel.compartment != null && panel.compartment !== 'x' && panel.compartment !== 'z') {
          errors.push(at + '.compartment must be "x" (samples) or "z" (variables)');
        }
        if (panel.style != null &&
            ['auto', 'dropdown', 'radio', 'buttons'].indexOf(panel.style) === -1) {
          errors.push(at + '.style must be "auto", "dropdown", "radio", or "buttons"');
        }
        if (panel.mode != null && panel.mode !== 'filter' && panel.mode !== 'param') {
          errors.push(at + '.mode must be "filter" or "param"');
        }
        if (panel.mode === 'param') {
          if (typeof panel.param !== 'string' || panel.param.length === 0) {
            errors.push(at + ' of mode "param" requires a param name string');
          } else if (spec.params == null || !hasOwn(spec.params, panel.param)) {
            errors.push(at + '.param "' + panel.param + '" has no matching entry in spec.params');
          }
        }
      }
      if (panel.align != null && ['left', 'center', 'right'].indexOf(panel.align) === -1) {
        errors.push(at + '.align must be "left", "center", or "right"');
      }
      if (panel.valign != null && ['top', 'middle', 'bottom'].indexOf(panel.valign) === -1) {
        errors.push(at + '.valign must be "top", "middle", or "bottom"');
      }
      if (panel.dataRef != null) {
        if (spec.data == null || !hasOwn(spec.data, panel.dataRef)) {
          errors.push(at + '.dataRef "' + panel.dataRef + '" has no matching entry in spec.data');
        }
      }
    });
  }

  // --- data sources ---
  if (spec.data != null) {
    if (typeof spec.data !== 'object' || Array.isArray(spec.data)) {
      errors.push('spec.data must be an object map');
    } else {
      Object.keys(spec.data).forEach(function (key) {
        var src = spec.data[key];
        var at = 'spec.data["' + key + '"]';
        if (src == null || typeof src !== 'object') {
          errors.push(at + ' must be an object');
          return;
        }
        if (src.kind !== 'inline' && src.kind !== 'connector' && src.kind !== 'dataset') {
          errors.push(at + '.kind must be "inline", "connector", or "dataset"');
        }
        if (src.kind === 'inline' && src.value == null) {
          errors.push(at + ' of kind "inline" requires a value');
        }
        if (src.kind === 'connector' && typeof src.url !== 'string') {
          errors.push(at + ' of kind "connector" requires a url string');
        }
        if (src.kind === 'dataset' && (typeof src.id !== 'string' || src.id.length === 0)) {
          errors.push(at + ' of kind "dataset" requires an id string');
        }
        // A `query` template maps request keys to literals or "$param" tokens;
        // every token must name a declared parameter.
        if (src.query != null) {
          if (typeof src.query !== 'object' || Array.isArray(src.query)) {
            errors.push(at + '.query must be an object map');
          } else {
            Object.keys(src.query).forEach(function (qk) {
              var token = src.query[qk];
              if (typeof token === 'string' && token.charAt(0) === '$') {
                var name = token.slice(1);
                if (spec.params == null || !hasOwn(spec.params, name)) {
                  errors.push(at + '.query["' + qk + '"] references undeclared param "' + name + '"');
                }
              }
            });
          }
        }
      });
    }
  }

  // --- params ---
  if (spec.params != null) {
    if (typeof spec.params !== 'object' || Array.isArray(spec.params)) {
      errors.push('spec.params must be an object map');
    } else {
      Object.keys(spec.params).forEach(function (name) {
        var def = spec.params[name];
        // A param is either a bare default value or a { value, type } object.
        if (def != null && typeof def === 'object' && !Array.isArray(def) &&
            def.type != null &&
            ['string', 'number', 'boolean'].indexOf(def.type) === -1) {
          errors.push('spec.params["' + name + '"].type must be "string", "number", or "boolean"');
        }
      });
    }
  }

  // --- controls ---
  if (spec.controls != null) {
    if (!Array.isArray(spec.controls)) {
      errors.push('spec.controls must be an array');
    } else {
      spec.controls.forEach(function (control, i) {
        var at = 'spec.controls[' + i + ']';
        if (control == null || typeof control !== 'object') {
          errors.push(at + ' must be an object');
          return;
        }
        if (control.kind !== 'filter' && control.kind !== 'table') {
          errors.push(at + '.kind must be "filter" or "table"');
        }
        if (control.dataRef != null && (spec.data == null || !hasOwn(spec.data, control.dataRef))) {
          errors.push(at + '.dataRef "' + control.dataRef + '" has no matching entry in spec.data');
        }
      });
    }
  }

  return { valid: errors.length === 0, errors: errors };
}

/**
 * Own-property check that is safe against inherited/`hasOwnProperty`-shadowed keys.
 *
 * @param {object} obj - Object to test.
 * @param {string} key - Property name.
 * @returns {boolean} True when obj has key as an own property.
 * @private
 */
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
