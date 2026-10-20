'use strict';
/* The login popup: hands the session to the page that opened it, then closes. */
(() => {
  const el = document.getElementById('jb-handoff');
  const token = el && el.dataset.token, h = el && el.dataset.h;
  try { if (window.opener && token) window.opener.postMessage({ type: 'jb-auth', token, h }, location.origin); } catch { /* the embed polls the handoff instead */ }
  setTimeout(() => { try { window.close(); } catch { /* the page says it can be closed */ } }, 400);
})();
