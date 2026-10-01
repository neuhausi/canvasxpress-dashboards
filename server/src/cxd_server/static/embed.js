/*
 * <cxd-embed src="https://…/embed.html?token=…&panel=…"></cxd-embed>
 *
 * Web-component embed for a published CanvasXpress Dashboards chart. Creates a
 * borderless, full-width iframe and grows it to the height the embedded page
 * reports ({type:'cxd-embed:resize', height} via postMessage). Messages are
 * matched by event.source, so any number of embeds can share one host page.
 * Attributes: src (required), height (initial px, default 480), title.
 */
(function () {
  if (typeof window === 'undefined' || !window.customElements || window.customElements.get('cxd-embed')) {
    return;
  }

  var frames = [];

  // One element-scoped stylesheet for every <cxd-embed> on the host page.
  function injectStyles() {
    if (document.getElementById('cxd-embed-styles')) {
      return;
    }
    var sheet = document.createElement('style');
    sheet.id = 'cxd-embed-styles';
    sheet.textContent = 'cxd-embed{display:block}cxd-embed>iframe{display:block;width:100%;border:0}';
    (document.head || document.documentElement).appendChild(sheet);
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'cxd-embed:resize' || !(data.height > 0)) {
      return;
    }
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === event.source) {
        frames[i].style.height = Math.ceil(data.height) + 'px';
      }
    }
  });

  function CxdEmbed() {
    return Reflect.construct(HTMLElement, [], CxdEmbed);
  }
  CxdEmbed.prototype = Object.create(HTMLElement.prototype);
  CxdEmbed.prototype.constructor = CxdEmbed;
  Object.setPrototypeOf(CxdEmbed, HTMLElement);

  CxdEmbed.observedAttributes = ['src'];

  CxdEmbed.prototype.connectedCallback = function () {
    if (this._frame) {
      return;
    }
    var frame = document.createElement('iframe');
    frame.setAttribute('title', this.getAttribute('title') || 'CanvasXpress chart');
    frame.setAttribute('loading', 'lazy');
    injectStyles();
    frame.style.height = (parseInt(this.getAttribute('height'), 10) || 480) + 'px';
    frame.src = this.getAttribute('src') || 'about:blank';
    this.appendChild(frame);
    this._frame = frame;
    frames.push(frame);
  };

  CxdEmbed.prototype.disconnectedCallback = function () {
    var index = frames.indexOf(this._frame);
    if (index !== -1) {
      frames.splice(index, 1);
    }
  };

  CxdEmbed.prototype.attributeChangedCallback = function (name, oldValue, newValue) {
    if (name === 'src' && this._frame && newValue && newValue !== oldValue) {
      this._frame.src = newValue;
    }
  };

  window.customElements.define('cxd-embed', CxdEmbed);
})();
