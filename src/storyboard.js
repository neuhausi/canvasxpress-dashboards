/**
 * Storyboards: a dashboard's guided tour. A spec's `storyboard` is an ordered list of steps; each
 * step is a complete view (a named filter scheme or explicit filters, parameter values, a panel to
 * bring into view) with a title and a line of narration. The player is a bar with previous / play /
 * next and a dot per step; stepping applies the view through the dashboard handle, so every step is
 * the dashboard's own state (filters, case card, highlighting), never a picture of it.
 *
 * Narration is plain text written by the author; nothing is generated and it is never parsed as HTML.
 *
 * @module storyboard
 */

/**
 * Create an element with an optional class and text (named `sbEl` so it does not collide with the
 * other modules' helpers in the concatenated bundle).
 * @param {Document} doc - Owning document.
 * @param {string} tag - Tag name.
 * @param {string} [cls] - Class name.
 * @param {string} [text] - Text content.
 * @returns {HTMLElement} The new element.
 * @private
 */
function sbEl(doc, tag, cls, text) {
  var node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * The steps of a spec's storyboard (an empty list when it has none).
 * @param {object} spec - A dashboard spec.
 * @returns {object[]} The step objects.
 * @public
 */
export function storyboardSteps(spec) {
  var board = spec && spec.storyboard;
  return board && Array.isArray(board.steps) ? board.steps.filter(function (step) {
    return step && typeof step === 'object';
  }) : [];
}

/**
 * Mount the storyboard player for a rendered dashboard. Nothing is mounted for a spec without steps.
 * Step 1 is applied on mount only when `opts.start` is true; by default the dashboard stays as the
 * author left it until the viewer presses play or next.
 * @param {object} opts - Options.
 * @param {object} opts.spec - The dashboard spec.
 * @param {object} opts.handle - The `renderDashboard` handle (`applyView`).
 * @param {HTMLElement} [opts.container] - Where to put the bar: first child of this element.
 * @param {HTMLElement} [opts.before] - Or: the element to insert the bar before.
 * @param {boolean} [opts.start=false] - Apply the first step now.
 * @param {Document} [opts.document] - The owning document.
 * @param {function} [opts.setTimer] - `setTimeout` replacement (tests).
 * @param {function} [opts.clearTimer] - `clearTimeout` replacement (tests).
 * @returns {(object|null)} The player `{element, go(i), next(), prev(), play(), pause(), index(), destroy()}`,
 *   or null when there is nothing to play.
 * @public
 */
export function mountStoryboard(opts) {
  var steps = storyboardSteps(opts.spec);
  var doc = opts.document || (typeof document !== 'undefined' ? document : null);
  if (!steps.length || !doc || !opts.handle || typeof opts.handle.applyView !== 'function') return null;
  var setTimer = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
  var clearTimer = opts.clearTimer || function (id) { clearTimeout(id); };
  var board = opts.spec.storyboard;

  var bar = sbEl(doc, 'section', 'cxd-storyboard');
  bar.setAttribute('aria-label', board.title || 'Storyboard');
  bar.tabIndex = 0;
  var head = sbEl(doc, 'div', 'cxd-sb-head');
  var prevBtn = sbEl(doc, 'button', 'cxd-sb-btn', '‹');
  var playBtn = sbEl(doc, 'button', 'cxd-sb-btn cxd-sb-play', '▶');
  var nextBtn = sbEl(doc, 'button', 'cxd-sb-btn', '›');
  prevBtn.type = playBtn.type = nextBtn.type = 'button';
  prevBtn.title = 'Previous step';
  nextBtn.title = 'Next step';
  var count = sbEl(doc, 'span', 'cxd-sb-count');
  var title = sbEl(doc, 'span', 'cxd-sb-title');
  var dots = sbEl(doc, 'span', 'cxd-sb-dots');
  head.appendChild(prevBtn);
  head.appendChild(playBtn);
  head.appendChild(nextBtn);
  head.appendChild(count);
  head.appendChild(title);
  head.appendChild(dots);
  var narration = sbEl(doc, 'p', 'cxd-sb-text');
  narration.setAttribute('aria-live', 'polite');
  bar.appendChild(head);
  bar.appendChild(narration);

  var current = -1;
  var playing = false;
  var timer = null;
  var token = 0;
  var dotButtons = steps.map(function (step, i) {
    var dot = sbEl(doc, 'button', 'cxd-sb-dot');
    dot.type = 'button';
    dot.title = step.title || ('Step ' + (i + 1));
    dot.addEventListener('click', function () { player.pause(); player.go(i); });
    dots.appendChild(dot);
    return dot;
  });

  function paint() {
    var step = steps[current];
    count.textContent = current < 0 ? steps.length + (steps.length === 1 ? ' step' : ' steps') : (current + 1) + ' / ' + steps.length;
    title.textContent = step ? (step.title || '') : (board.title || '');
    narration.textContent = step ? (step.narration || '') : '';
    narration.style.display = step && step.narration ? '' : 'none';
    dotButtons.forEach(function (dot, i) {
      dot.className = 'cxd-sb-dot' + (i === current ? ' cxd-sb-dot--on' : '');
    });
    playBtn.textContent = playing ? '❚❚' : '▶';
    playBtn.title = playing ? 'Pause' : 'Play';
    prevBtn.disabled = current <= 0;
    nextBtn.disabled = current >= steps.length - 1;
  }

  function schedule() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (!playing) return;
    var step = steps[current];
    var seconds = step && step.seconds > 0 ? step.seconds : (board.seconds > 0 ? board.seconds : 8);
    timer = setTimer(function () {
      timer = null;
      if (current >= steps.length - 1) { player.pause(); return; }
      player.go(current + 1);
    }, seconds * 1000);
  }

  var player = {
    element: bar,
    index: function () { return current; },
    go: function (i) {
      if (i < 0 || i >= steps.length) return Promise.resolve();
      current = i;
      var mine = ++token;
      paint();
      var step = steps[i];
      var done = opts.handle.applyView({
        scheme: step.scheme, filters: step.filters, params: step.params, focus: step.focus
      });
      // Count the dwell time from when the panels hold the step, not from the click.
      Promise.resolve(done).catch(function () {}).then(function () { if (mine === token) schedule(); });
      return done;
    },
    next: function () { return player.go(current + 1); },
    prev: function () { return player.go(current - 1); },
    play: function () {
      playing = true;
      if (current < 0 || current >= steps.length - 1) current = -1;
      paint();
      return player.go(current + 1);
    },
    pause: function () {
      playing = false;
      if (timer !== null) { clearTimer(timer); timer = null; }
      paint();
    },
    destroy: function () {
      player.pause();
      token++;
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }
  };

  prevBtn.addEventListener('click', function () { player.pause(); player.prev(); });
  nextBtn.addEventListener('click', function () { player.pause(); player.next(); });
  playBtn.addEventListener('click', function () { if (playing) player.pause(); else player.play(); });
  bar.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowRight') { player.pause(); player.next(); event.preventDefault(); }
    else if (event.key === 'ArrowLeft') { player.pause(); player.prev(); event.preventDefault(); }
  });

  if (opts.container) opts.container.insertBefore(bar, opts.container.firstChild);
  else if (opts.before && opts.before.parentNode) opts.before.parentNode.insertBefore(bar, opts.before);
  else doc.body.insertBefore(bar, doc.body.firstChild);
  paint();
  if (opts.start) player.go(0);
  return player;
}
