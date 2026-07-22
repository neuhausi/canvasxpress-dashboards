/**
 * A tiny synchronous DOM stub — just enough of the element API that
 * renderDashboard/injectStyles exercise, so the renderer can be tested under
 * `node --test` without a browser or jsdom. It supports tag/`.class`/`#id`
 * selectors for querySelector(All), classList, style, and the tree ops used by
 * the renderer. For full-fidelity rendering, the Playwright harness (Phase 1
 * acceptance) drives a real browser.
 *
 * @module tests/helpers/dom-stub
 */

/**
 * Install a global `document` (and `globalThis.document`) backed by the stub.
 * @returns {void}
 */
export function installDom() {
  var doc = new StubDocument();
  globalThis.document = doc;
}

/** A stub DOM element. */
class StubElement {
  /**
   * @param {string} tag - Tag name.
   * @param {StubDocument} ownerDocument - Owning document.
   */
  constructor(tag, ownerDocument) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this.id = '';
    this._text = '';
    this._classes = [];
    this.classList = {
      add: (function (self) { return function () {
        for (var i = 0; i < arguments.length; i++) {
          if (self._classes.indexOf(arguments[i]) === -1) self._classes.push(arguments[i]);
        }
      }; })(this),
      remove: (function (self) { return function () {
        for (var i = 0; i < arguments.length; i++) {
          var idx = self._classes.indexOf(arguments[i]);
          if (idx !== -1) self._classes.splice(idx, 1);
        }
      }; })(this),
      contains: (function (self) { return function (c) { return self._classes.indexOf(c) !== -1; }; })(this)
    };
  }

  /** @returns {string} The space-joined class list. */
  get className() { return this._classes.join(' '); }
  /** @param {string} value - Space-separated classes. */
  set className(value) { this._classes = String(value).split(/\s+/).filter(Boolean); }

  /** @returns {string} Text content. */
  get textContent() { return this._text; }
  /** @param {string} value - New text; clears children. */
  set textContent(value) { this._text = String(value); this.children = []; }

  /** @returns {string} innerHTML (only '' clearing is supported). */
  get innerHTML() { return ''; }
  /** @param {string} _value - Setting '' clears children. */
  set innerHTML(_value) { this.children = []; }

  /**
   * @param {StubElement} child - Child to append.
   * @returns {StubElement} The child.
   */
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  /**
   * @param {string} name - Attribute name.
   * @param {string} value - Attribute value.
   * @returns {void}
   */
  setAttribute(name, value) { this.attributes[name] = String(value); }

  /**
   * @param {string} selector - `tag`, `.class`, or `#id`.
   * @returns {StubElement|null} First match in the subtree.
   */
  querySelector(selector) { return this._find(selector, false)[0] || null; }

  /**
   * @param {string} selector - `tag`, `.class`, or `#id`.
   * @returns {StubElement[]} All matches in the subtree.
   */
  querySelectorAll(selector) { return this._find(selector, true); }

  /**
   * Depth-first collect matching descendants.
   * @param {string} selector - Selector.
   * @param {boolean} all - Collect all vs. stop early.
   * @returns {StubElement[]} Matches.
   * @private
   */
  _find(selector, all) {
    var out = [];
    var match = matcher(selector);
    (function walk(node) {
      for (var i = 0; i < node.children.length; i++) {
        var child = node.children[i];
        if (match(child)) {
          out.push(child);
          if (!all) return;
        }
        walk(child);
      }
    })(this);
    return out;
  }
}

/** A stub document. */
class StubDocument {
  constructor() {
    this.head = new StubElement('head', this);
    this.body = new StubElement('body', this);
    this._byId = {};
  }

  /**
   * @param {string} tag - Tag name.
   * @returns {StubElement} A new detached element.
   */
  createElement(tag) { return new StubElement(tag, this); }

  /**
   * @param {string} id - Element id.
   * @returns {StubElement|null} Element with that id anywhere in the tree.
   */
  getElementById(id) {
    var found = null;
    [this.head, this.body].forEach(function (rootEl) {
      if (found) return;
      var hits = rootEl.querySelectorAll('#' + id);
      if (hits.length) found = hits[0];
      else if (rootEl.id === id) found = rootEl;
    });
    return found;
  }
}

/**
 * Build a predicate for a simple selector.
 * @param {string} selector - `tag`, `.class`, or `#id`.
 * @returns {function(StubElement): boolean} Predicate.
 */
function matcher(selector) {
  if (selector[0] === '.') {
    var cls = selector.slice(1);
    return function (el) { return el.classList.contains(cls); };
  }
  if (selector[0] === '#') {
    var id = selector.slice(1);
    return function (el) { return el.id === id; };
  }
  var tag = selector.toUpperCase();
  return function (el) { return el.tagName === tag; };
}
