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

import { JOIN_TYPES, AXES, derivedCycle } from './join.js';
import { FIELD_KINDS } from './filters.js';
import { specCompatibility, DASHBOARD_SCHEMA_VERSION } from './spec.js';

/** @type {string[]} Data source kinds. */
var DATA_KINDS = ['inline', 'connector', 'dataset', 'join', 'function'];

/** @type {string[]} Languages a data function may be written in. */
var FUNCTION_LANGUAGES = ['python', 'r'];

/** @type {string[]} How related panels show marked rows (CanvasXpress highlightMode). */
var MARKING_MODES = ['focus', 'highlight', 'ghost'];

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

  // --- format version (schemaVersion "MAJOR.MINOR"; absent = the legacy 1.0) ---
  var warnings = [];
  var compat = specCompatibility(spec);
  if (spec.$schema != null && typeof spec.$schema !== 'string') {
    errors.push('spec.$schema must be a URL string');
  }
  if (compat.status === 'invalid') {
    errors.push('spec.schemaVersion must be "MAJOR.MINOR" (e.g. "' + DASHBOARD_SCHEMA_VERSION + '")');
  } else if (compat.status === 'newer-major') {
    errors.push('spec.schemaVersion ' + compat.version + ' needs a newer canvasxpress-dashboards (this one reads ' +
      DASHBOARD_SCHEMA_VERSION.split('.')[0] + '.x)');
  }
  // A newer MINOR may add source kinds this version does not know: those
  // sources are skipped (their panels show an error) instead of failing all.
  var newerMinor = compat.status === 'newer-minor';

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
      // A param control that sources its choices statically (`options`), from
      // another dataset (`optionsFrom`), or takes free text (`style:"search"`)
      // drives a backend query and needs no data of its own, so it is exempt
      // from the data requirement.
      var paramWithOptions = panel.type === 'control' && panel.mode === 'param' &&
        (Array.isArray(panel.options) || panel.optionsFrom != null || panel.style === 'search');
      // A config control drives a target panel's config from its own static
      // option list, so it too needs no data of its own.
      var isConfigControl = panel.type === 'control' && panel.mode === 'config';
      if (panel.type !== 'text' && panel.type !== 'image' && panel.type !== 'filters' &&
          !paramWithOptions && !isConfigControl &&
          panel.dataRef == null && panel.data == null) {
        errors.push(at + ' must have either a dataRef or inline data');
      }
      if (panel.type === 'image') {
        // src is optional (an empty image renders a placeholder, like empty text),
        // but when present it must be a string.
        if (panel.src != null && typeof panel.src !== 'string') {
          errors.push(at + '.src must be a string (URL or data: URI)');
        }
        if (panel.fit != null &&
            ['contain', 'cover', 'fill', 'none', 'scale-down'].indexOf(panel.fit) === -1) {
          errors.push(at + '.fit must be "contain", "cover", "fill", "none", or "scale-down"');
        }
      }
      if (panel.type === 'filters') checkFiltersPanel(panel, at, spec.data, errors);
      if (panel.transpose != null && typeof panel.transpose !== 'boolean') {
        errors.push(at + '.transpose must be true or false');
      }
      if (panel.type === 'control') {
        if (panel.compartment != null && panel.compartment !== 'x' && panel.compartment !== 'z') {
          errors.push(at + '.compartment must be "x" (samples) or "z" (variables)');
        }
        if (panel.style != null &&
            ['auto', 'dropdown', 'radio', 'buttons', 'search', 'slider'].indexOf(panel.style) === -1) {
          errors.push(at + '.style must be "auto", "dropdown", "radio", "buttons", "search", or "slider"');
        }
        if (panel.mode != null && panel.mode !== 'filter' && panel.mode !== 'param' && panel.mode !== 'config') {
          errors.push(at + '.mode must be "filter", "param", or "config"');
        }
        if (panel.mode === 'config') {
          if (typeof panel.target !== 'string' || panel.target.length === 0) {
            errors.push(at + ' of mode "config" requires a target panel id string');
          } else if (spec.panels == null || !hasOwn(spec.panels, panel.target)) {
            errors.push(at + '.target "' + panel.target + '" has no matching entry in spec.panels');
          }
          if (!Array.isArray(panel.options) || panel.options.length === 0) {
            errors.push(at + ' of mode "config" requires a non-empty options array');
          } else {
            panel.options.forEach(function (opt, oi) {
              if (opt == null || typeof opt !== 'object' || Array.isArray(opt) ||
                  opt.config == null || typeof opt.config !== 'object') {
                errors.push(at + '.options[' + oi + '] must be an object with a config fragment');
              }
            });
          }
        }
        if (panel.mode === 'param') {
          if (typeof panel.param !== 'string' || panel.param.length === 0) {
            errors.push(at + ' of mode "param" requires a param name string');
          } else if (spec.params == null || !hasOwn(spec.params, panel.param)) {
            errors.push(at + '.param "' + panel.param + '" has no matching entry in spec.params');
          }
          if (panel.optionsFrom != null) {
            var from = panel.optionsFrom;
            if (typeof from !== 'object' || Array.isArray(from)) {
              errors.push(at + '.optionsFrom must be an object');
            } else if (typeof from.dataRef !== 'string' ||
                spec.data == null || !hasOwn(spec.data, from.dataRef)) {
              errors.push(at + '.optionsFrom.dataRef has no matching entry in spec.data');
            }
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
      // Chart-click cross-filter: a clicked mark sets this parameter.
      if (panel.clickParam != null) {
        if (typeof panel.clickParam !== 'string') {
          errors.push(at + '.clickParam must be a string');
        } else if (spec.params == null || !hasOwn(spec.params, panel.clickParam)) {
          errors.push(at + '.clickParam "' + panel.clickParam + '" has no matching entry in spec.params');
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
        if (DATA_KINDS.indexOf(src.kind) === -1) {
          var kindMessage = at + '.kind must be "inline", "connector", "dataset", "join", or "function"';
          if (newerMinor) warnings.push(kindMessage + ' (unknown kind from a newer format: skipped)');
          else errors.push(kindMessage);
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
        if (src.kind === 'join') checkJoin(src, at, spec.data, errors);
        else if (src.axis != null && AXES.indexOf(src.axis) === -1) {
          errors.push(at + '.axis must be "smps" or "vars"');
        }
        if (src.kind === 'function') checkFunction(src, at, spec, errors);
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

  // --- cycles (a join / data function reading itself, directly or indirectly) ---
  if (spec.data != null && typeof spec.data === 'object' && !Array.isArray(spec.data)) {
    Object.keys(spec.data).forEach(function (key) {
      var src = spec.data[key];
      if (!src || (src.kind !== 'join' && src.kind !== 'function')) return;
      var cycle = derivedCycle(key, spec.data);
      // Flag each ref on the cycle; a ref that only leads into one is not flagged.
      if (cycle && cycle[0] === key) {
        errors.push('spec.data["' + key + '"] ' + src.kind + ' depends on itself (' + cycle.join(' -> ') + ')');
      }
    });
  }

  // --- relationships (cross-source marking / filtering) ---
  if (spec.relationships != null) {
    if (!Array.isArray(spec.relationships)) {
      errors.push('spec.relationships must be an array');
    } else {
      spec.relationships.forEach(function (rel, i) {
        var at = 'spec.relationships[' + i + ']';
        if (rel == null || typeof rel !== 'object' || Array.isArray(rel)) {
          errors.push(at + ' must be an object');
          return;
        }
        checkRelation(rel, at, spec.data, errors, 'relationship');
      });
    }
  }
  if (spec.markingMode != null && MARKING_MODES.indexOf(spec.markingMode) === -1) {
    errors.push('spec.markingMode must be "focus", "highlight", or "ghost"');
  }

  // --- filter schemes (named Filters-panel states) ---
  if (spec.filterSchemes != null) {
    if (typeof spec.filterSchemes !== 'object' || Array.isArray(spec.filterSchemes)) {
      errors.push('spec.filterSchemes must be an object map');
    } else {
      Object.keys(spec.filterSchemes).forEach(function (name) {
        var at = 'spec.filterSchemes["' + name + '"]';
        var scheme = spec.filterSchemes[name];
        if (!Array.isArray(scheme)) {
          errors.push(at + ' must be an array of filters');
          return;
        }
        scheme.forEach(function (p, i) { checkFilterPredicate(p, at + '[' + i + ']', spec.data, errors); });
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

  var result = { valid: errors.length === 0, errors: errors };
  if (warnings.length) result.warnings = warnings;
  return result;
}

/**
 * Validate a `kind:"join"` source: `left`/`right` name other sources, `how` is a
 * known join type, and `on` is a column name, `{left, right}`, or an array of those.
 *
 * @param {object} src - The join source spec.
 * @param {string} at - Error path prefix.
 * @param {object} data - The spec's data map.
 * @param {string[]} errors - Error list to append to.
 * @returns {void}
 * @private
 */
function checkJoin(src, at, data, errors) {
  checkRelation(src, at, data, errors, 'of kind "join"');
  if (src.how != null && JOIN_TYPES.indexOf(src.how) === -1) {
    errors.push(at + '.how must be one of "' + JOIN_TYPES.join('", "') + '"');
  }
  if (src.suffix != null && typeof src.suffix !== 'string') {
    errors.push(at + '.suffix must be a string');
  }
}

/**
 * Validate a `kind:"function"` source: a language, non-empty code, inputs
 * naming other sources (as identifiers the code can use), an `args` template
 * whose `$param` tokens are declared, and an optional runtime URL.
 *
 * @param {object} src - The function source.
 * @param {string} at - Error path prefix.
 * @param {object} spec - The dashboard spec (for data / params).
 * @param {string[]} errors - Error list to append to.
 * @returns {void}
 * @private
 */
function checkFunction(src, at, spec, errors) {
  if (FUNCTION_LANGUAGES.indexOf(src.language) === -1) {
    errors.push(at + ' of kind "function" requires language "python" or "r"');
  }
  if (typeof src.code !== 'string' || !src.code.trim()) {
    errors.push(at + ' of kind "function" requires a code string');
  }
  var inputs = src.inputs;
  var pairs = [];
  if (Array.isArray(inputs)) {
    inputs.forEach(function (ref) { pairs.push([ref, ref]); });
  } else if (inputs != null && typeof inputs === 'object') {
    Object.keys(inputs).forEach(function (name) { pairs.push([name, inputs[name]]); });
  } else if (inputs != null) {
    errors.push(at + '.inputs must be an array of refs or a {name: ref} map');
  }
  pairs.forEach(function (pair) {
    if (typeof pair[0] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pair[0])) {
      errors.push(at + '.inputs name "' + pair[0] + '" must be an identifier (letters, digits, _)');
    }
    if (typeof pair[1] !== 'string' || spec.data == null || !hasOwn(spec.data, pair[1])) {
      errors.push(at + '.inputs "' + pair[1] + '" has no matching entry in spec.data');
    }
  });
  if (src.args != null) {
    if (typeof src.args !== 'object' || Array.isArray(src.args)) {
      errors.push(at + '.args must be an object map');
    } else {
      Object.keys(src.args).forEach(function (name) {
        var token = src.args[name];
        if (typeof token === 'string' && token.charAt(0) === '$' &&
            (spec.params == null || !hasOwn(spec.params, token.slice(1)))) {
          errors.push(at + '.args["' + name + '"] references undeclared param "' + token.slice(1) + '"');
        }
      });
    }
  }
  if (src.runtime != null && typeof src.runtime !== 'string') {
    errors.push(at + '.runtime must be a URL string');
  }
}

/**
 * Validate a Filters panel: `fields` entries are field names (of the panel's
 * dataRef) or `{field, dataRef?, kind?, label?}`, and every field has a source.
 *
 * @param {object} panel - The Filters panel.
 * @param {string} at - Error path prefix.
 * @param {object} data - The spec's data map.
 * @param {string[]} errors - Error list to append to.
 * @returns {void}
 * @private
 */
function checkFiltersPanel(panel, at, data, errors) {
  if (panel.fields != null && !Array.isArray(panel.fields)) {
    errors.push(at + '.fields must be an array');
    return;
  }
  var fields = panel.fields || [];
  if (panel.dataRef == null && !fields.length) {
    errors.push(at + ' of type "filters" requires a dataRef or fields');
  }
  fields.forEach(function (f, i) {
    var fat = at + '.fields[' + i + ']';
    if (typeof f === 'string') {
      if (!f.length) errors.push(fat + ' must be a non-empty field name');
      else if (panel.dataRef == null) errors.push(fat + ' needs the panel dataRef (or use {field, dataRef})');
      return;
    }
    if (f == null || typeof f !== 'object' || Array.isArray(f) || typeof f.field !== 'string' || !f.field.length) {
      errors.push(fat + ' must be a field name or {field, dataRef?, kind?}');
      return;
    }
    if (f.dataRef != null && (data == null || !hasOwn(data, f.dataRef))) {
      errors.push(fat + '.dataRef "' + f.dataRef + '" has no matching entry in spec.data');
    } else if (f.dataRef == null && panel.dataRef == null) {
      errors.push(fat + ' needs a dataRef (on the field or the panel)');
    }
    if (f.kind != null && FIELD_KINDS.indexOf(f.kind) === -1) {
      errors.push(fat + '.kind must be "values", "range", or "search"');
    }
  });
}

/**
 * Validate one saved filter (a filter-scheme entry):
 * `{dataRef, field, values? | min? / max? | text?}`.
 *
 * @param {*} p - The filter.
 * @param {string} at - Error path prefix.
 * @param {object} data - The spec's data map.
 * @param {string[]} errors - Error list to append to.
 * @returns {void}
 * @private
 */
function checkFilterPredicate(p, at, data, errors) {
  if (p == null || typeof p !== 'object' || Array.isArray(p)) {
    errors.push(at + ' must be an object');
    return;
  }
  if (typeof p.dataRef !== 'string' || data == null || !hasOwn(data, p.dataRef)) {
    errors.push(at + '.dataRef has no matching entry in spec.data');
  }
  if (typeof p.field !== 'string' || !p.field.length) {
    errors.push(at + '.field must be a non-empty string');
  }
  if (p.values != null && !Array.isArray(p.values)) errors.push(at + '.values must be an array');
  ['min', 'max'].forEach(function (k) {
    if (p[k] != null && (typeof p[k] !== 'number' || !isFinite(p[k]))) errors.push(at + '.' + k + ' must be a number');
  });
  if (p.text != null && typeof p.text !== 'string') errors.push(at + '.text must be a string');
}

/**
 * Validate the parts a join source and a `spec.relationships` entry share:
 * `left`/`right` name sources, `on` is a column name, `{left, right}`, or an
 * array of those, and the axes are `"smps"` or `"vars"`.
 *
 * @param {object} rel - The join source or relationship.
 * @param {string} at - Error path prefix.
 * @param {object} data - The spec's data map.
 * @param {string[]} errors - Error list to append to.
 * @param {string} what - How to name the entry in a "requires" error.
 * @returns {void}
 * @private
 */
function checkRelation(rel, at, data, errors, what) {
  ['left', 'right'].forEach(function (side) {
    var ref = rel[side];
    if (typeof ref !== 'string' || ref.length === 0) {
      errors.push(at + ' ' + what + ' requires a ' + side + ' ref string');
    } else if (data == null || !hasOwn(data, ref)) {
      errors.push(at + '.' + side + ' "' + ref + '" has no matching entry in spec.data');
    }
  });
  var src = rel;
  if (src.on != null) {
    var keys = Array.isArray(src.on) ? src.on : [src.on];
    var validKey = function (key) {
      return (typeof key === 'string' && key.length > 0) ||
        (key != null && typeof key === 'object' && !Array.isArray(key) &&
          typeof key.left === 'string' && key.left.length > 0 &&
          typeof key.right === 'string' && key.right.length > 0);
    };
    if (keys.length === 0 || !keys.every(validKey)) {
      errors.push(at + '.on must be a column name, {left, right}, or a non-empty array of those');
    }
  }
  ['axis', 'leftAxis', 'rightAxis'].forEach(function (field) {
    if (src[field] != null && AXES.indexOf(src[field]) === -1) {
      errors.push(at + '.' + field + ' must be "smps" or "vars"');
    }
  });
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
