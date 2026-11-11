/** Long enough to read the name, short enough never to feel like waiting on purpose. */
const SHORTEST_MS = 900;
const FADE_MS = 400;

let hidden = false;

/** Fades out the start-up screen drawn by index.html. Safe to call more than once. */
export function hideSplash() {
  if (hidden) return;
  hidden = true;
  const splash = document.getElementById('splash');
  if (!splash) return;
  const wait = Math.max(0, SHORTEST_MS - performance.now());
  window.setTimeout(() => {
    splash.classList.add('gone');
    window.setTimeout(() => splash.remove(), FADE_MS);
  }, wait);
}

/** What the start-up screen says it is doing. */
export function splashNote(text: string) {
  const note = document.querySelector('#splash .note');
  if (note) note.textContent = text;
}
