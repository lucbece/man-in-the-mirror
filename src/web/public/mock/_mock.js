// Mock glue only: loads the shared nav and marks the current page. Not part of the panel.
(async () => {
  const page = document.body.dataset.page;
  const res = await fetch('_nav.html');
  const nav = document.createElement('div');
  nav.innerHTML = await res.text();
  const el = nav.firstElementChild;
  el.querySelector(`[data-page="${page}"]`)?.setAttribute('aria-current', 'page');
  document.querySelector('.shell').prepend(el);
})();
