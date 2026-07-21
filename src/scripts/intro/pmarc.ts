// The PMArc intro: the name writes itself on, folds to its initials, the
// practice syllable joins in the contrasting face, and the finished wordmark
// docks into the top bar as the permanent logo. Plays over an opaque veil in
// the page background color while the hero loads underneath, and ends by
// revealing the page.
//
// Whether it plays at all is decided by a pre-paint inline script in
// index.astro, which sets data-intro="pending" on the root element only when
// the visitor has not seen it (localStorage) and does not prefer reduced
// motion. That split matters: the decision must land before first paint so
// neither the hero nor the bar brand flashes ahead of the veil, and this
// module, which arrives with the bundle, could be seconds late on a slow
// connection. No JS means the attribute is never set and the page is simply
// itself.
//
// The intro is skippable three ways (click, Escape, the labeled button); a
// skip and a completed play end in the identical state and both remember in
// localStorage, so the intro plays at most once per browser.

import gsap from 'gsap';

const SEEN_KEY = 'pmarc-intro';
const FIRST = 'Payam';
const LAST = 'Madelat';

export function runIntro(): void {
  const root = document.documentElement;
  const overlay = document.getElementById('intro');
  if (root.dataset.intro !== 'pending' || !overlay) return;
  // Double guard: the boot script already respects reduced motion, but the
  // preference can change between visits to the same cached page.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish(overlay, false);
    return;
  }

  // Build and measure only once the display and script faces have loaded. The
  // mark freezes its own width at the start so the name types inside a still
  // block; measured against fallback metrics that frozen width stops matching
  // the real one the instant the fonts swap in, and releasing it at the fold
  // jerks the mark sideways. The veil covers this wait.
  document.fonts.ready.then(() => play(overlay));
}

// The measured, animated body of the intro, deferred until the fonts are ready
// so every width the timeline freezes is a final one.
function play(overlay: HTMLElement): void {
  const root = document.documentElement;
  const mark = overlay.querySelector<HTMLElement>('.intro-mark');
  const skip = overlay.querySelector<HTMLElement>('.intro-skip');
  if (!mark) {
    finish(overlay, false);
    return;
  }

  // Build the name as one span per letter so each can be typed on and fold
  // away independently. Letters start invisible but keep their space, which
  // lets the row's full width be known from the start: the mark is frozen to
  // that width so the name types left to right inside a still block, the way
  // typing looks, instead of recentering with every letter. The initials
  // carry a marker and survive the fold; everything else, the space included,
  // collapses into them.
  const letters: HTMLElement[] = [];
  const foldable: HTMLElement[] = [];
  const words = [FIRST, LAST];
  words.forEach((word, w) => {
    for (const ch of word) {
      const span = document.createElement('span');
      span.className = 'intro-letter';
      span.textContent = ch;
      span.style.visibility = 'hidden';
      const keep = (w === 0 && ch === 'P') || (w === 1 && ch === 'M');
      if (!keep) foldable.push(span);
      letters.push(span);
      mark.insertBefore(span, mark.querySelector('.intro-arc'));
    }
    if (w === 0) {
      const gap = document.createElement('span');
      gap.className = 'intro-letter intro-gap';
      gap.innerHTML = '&nbsp;';
      gap.style.visibility = 'hidden';
      foldable.push(gap);
      letters.push(gap);
      mark.insertBefore(gap, mark.querySelector('.intro-arc'));
    }
  });
  const arc = mark.querySelector<HTMLElement>('.intro-arc');

  // A typing caret that steps to the right edge of each letter as it lands.
  // Its blink is a CSS animation toggled by the .on class, so GSAP is free to
  // own its horizontal position (transform) without the two fighting over
  // opacity. Letters keep their space while hidden, so the caret's own flow
  // position is fixed at the end of the name and every step is a translate
  // back to the last typed letter.
  const caret = document.createElement('span');
  caret.className = 'intro-caret';
  mark.appendChild(caret);
  const caretHome = caret.offsetLeft;

  let done = false;
  const seal = (): void => {
    if (done) return;
    done = true;
    finish(overlay, true);
  };

  const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });

  tl.set(overlay, { autoAlpha: 1 }, 0);
  tl.set(mark, { width: mark.offsetWidth }, 0);
  // Park the caret at the first letter's left edge from the start, so it blinks
  // in place ready to type instead of flashing at its home slot at the end of
  // the row until the first letter finally cues its position.
  tl.set(caret, { x: () => letters[0].offsetLeft - caretHome }, 0);

  // Type the name at a human cadence, slow enough to register as typing and to
  // leave the finished name up long enough to read. The caret is solid while it
  // writes, so it rides the text instead of blinking out mid-word; it blinks
  // only when idle, a beat before the first letter and again while the name
  // rests. x is measured against the caret's own home, so each step is a
  // translate back from the row end to the just-typed letter.
  const PER_LETTER = 0.13; // typing cadence, seconds per letter (jittered below)
  const READY = 0.4; // caret sits ready at the start before the first letter
  const DWELL = 1.4; // hold the whole name, idling, long enough to read it

  tl.add(() => caret.classList.add('on'), 0.2);

  // Go solid, then write the name letter by letter.
  let at = 0.2 + READY;
  tl.set(caret, { opacity: 1 }, at);
  tl.add(() => caret.classList.remove('on'), at);
  letters.forEach((el, i) => {
    tl.set(el, { visibility: 'visible' }, at);
    tl.set(caret, { x: () => el.offsetLeft + el.offsetWidth - caretHome }, at);
    at += PER_LETTER + (hash01(i) - 0.5) * 0.05;
  });

  // Rest on the finished name, caret idling (blink), long enough to read it.
  tl.add(() => caret.classList.add('on'), at + 0.25);
  at += DWELL;

  // Retire the caret before the fold: stop the blink and hide it, but keep the
  // element so the frozen row width does not change (removing it would reflow).
  tl.add(() => caret.classList.remove('on'), at);
  tl.set(caret, { opacity: 0 }, at);

  // Fold to the initials: the non-initial letters shrink toward their own
  // left edge and give up their width, so the row compacts and P meets M.
  // The frozen row width is released here; at this instant auto width equals
  // the frozen value, so nothing jumps, and from here the centering follows
  // the shrinking row. Foldable widths are pinned to pixels first, because
  // auto widths do not animate.
  tl.add(() => {
    gsap.set(mark, { width: 'auto' });
    for (const el of foldable) gsap.set(el, { width: el.offsetWidth, transformOrigin: 'left center' });
  }, at);
  tl.to(foldable, {
    width: 0,
    scaleX: 0.4,
    autoAlpha: 0,
    duration: 0.65,
    ease: 'power3.inOut',
    stagger: 0.015,
  }, at);

  // Arc joins: it takes its width while sliding out from behind the M, so PM
  // glides left to make room and the wordmark recenters itself. The stylesheet
  // parks it at zero width so it cannot shift the name during the write-on;
  // its natural width is only measurable once that parking is lifted.
  if (arc) {
    tl.add(() => {
      gsap.set(arc, { width: 'auto' });
      const w = arc.offsetWidth;
      gsap.set(arc, { width: 0, x: '-0.18em', autoAlpha: 0 });
      gsap.to(arc, { width: w, x: 0, autoAlpha: 1, duration: 0.55, ease: 'power3.out' });
    }, '+=0.1');
    tl.to({}, { duration: 0.65 });
  }

  // Dock: measured at run time, not build time, so a resize during the intro
  // still lands the mark exactly on the bar brand. The veil fades first and
  // the page comes back while the mark is still traveling.
  tl.add(() => {
    const brand = document.querySelector<HTMLElement>('.bar .brand');
    const veil = overlay.querySelector<HTMLElement>('.intro-veil');
    if (!brand) {
      seal();
      return;
    }
    const from = mark.getBoundingClientRect();
    const to = brand.getBoundingClientRect();
    const scale = to.width / from.width;
    if (veil) gsap.to(veil, { autoAlpha: 0, duration: 0.6, ease: 'power1.inOut' });
    gsap.set(mark, { transformOrigin: '0 0' });
    gsap.to(mark, {
      x: to.left - from.left,
      y: to.top - from.top,
      scale,
      duration: 0.85,
      ease: 'power3.inOut',
      onComplete: () => {
        // Hand over: the real bar brand appears under the flying copy, the
        // copy fades, and the overlay leaves the document.
        root.removeAttribute('data-intro');
        gsap.to(mark, { autoAlpha: 0, duration: 0.18, onComplete: seal });
      },
    });
  });

  const abort = (): void => {
    tl.kill();
    seal();
  };
  skip?.addEventListener('click', abort);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target !== skip) abort();
  });
  addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      removeEventListener('keydown', onKey);
      abort();
    }
  });
}

// A stable value in [0,1) from an index, used only to jitter the typing
// cadence so it reads as a hand rather than a metronome. The usual sine hash;
// it needs no state and the exact distribution does not matter here.
function hash01(i: number): number {
  const x = Math.sin(i * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

// The single exit: page restored, intro remembered. Also the whole of the
// intro for anyone who reaches this module with the play already vetoed.
function finish(overlay: HTMLElement, remember: boolean): void {
  document.documentElement.removeAttribute('data-intro');
  overlay.remove();
  if (remember) {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Private browsing: the intro will simply play again next visit.
    }
  }
}
