/* Hermes Duet project site — small, dependency-free progressive enhancement.
   Everything here is optional polish: with JS off, the page is still complete. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ------------------------------------------------------------ nav */
  const body = document.body;
  const nav = $('#nav');
  const toggle = $('#navToggle');
  const panel = $('#navPanel');

  function closeNav() {
    body.classList.remove('nav-open');
    toggle?.setAttribute('aria-expanded', 'false');
  }

  toggle?.addEventListener('click', () => {
    const open = body.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  $$('#navPanel a').forEach((a) => a.addEventListener('click', closeNav));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNav();
  });
  document.addEventListener('click', (e) => {
    if (!body.classList.contains('nav-open')) return;
    if (!panel?.contains(e.target) && !toggle?.contains(e.target)) closeNav();
  });

  /* ------------------------------------------------------------ scroll chrome */
  const progress = $('#progressBar');
  const navLinks = $$('.nav__links .nav__link');
  const sectionIds = navLinks.map((a) => a.getAttribute('href')).filter(Boolean);
  let ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY || document.documentElement.scrollTop;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const pct = max > 0 ? Math.min(1, y / max) : 0;
      if (progress) progress.style.transform = `scaleX(${pct})`;
      nav?.classList.toggle('is-scrolled', y > 8);

      let active = '';
      const threshold = Math.min(260, window.innerHeight * 0.34);
      for (const id of sectionIds) {
        const el = document.querySelector(id);
        if (el && el.getBoundingClientRect().top <= threshold) active = id;
      }
      navLinks.forEach((a) => {
        const on = a.getAttribute('href') === active;
        a.classList.toggle('is-active', on);
        if (on) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ------------------------------------------------------------ reveal */
  const revealEls = $$('[data-reveal]');
  if ('IntersectionObserver' in window && !reduceMotion.matches) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add('is-in'));
  }

  /* ------------------------------------------------------------ phone preview */
  const scenes = $$('.scene');
  const sceneButtons = $$('[data-goto]');
  const sceneLabel = $('#sceneLabel');
  const phoneStage = $('.phone-stage');
  const sceneOrder = ['brief', 'approval', 'tasks', 'make'];
  const sceneNames = {
    brief: 'Morning brief · demo data',
    approval: 'Approval card · demo data',
    tasks: 'Tasks · demo data',
    make: 'Make · demo data',
  };
  let sceneTimer = null;
  let sceneIndex = 0;
  let manualScene = false;
  let phoneHovered = false;

  function showScene(name, fromUser = false) {
    const idx = sceneOrder.indexOf(name);
    if (idx === -1) return;
    sceneIndex = idx;
    if (fromUser) manualScene = true;

    scenes.forEach((scene) => {
      const on = scene.dataset.scene === name;
      scene.classList.toggle('is-on', on);
      scene.setAttribute('aria-hidden', String(!on));
    });

    $$('.phone-dot').forEach((dot) => {
      const on = dot.dataset.goto === name;
      dot.classList.toggle('is-on', on);
      dot.setAttribute('aria-pressed', String(on));
    });

    $$('.phone__tab').forEach((tab) => {
      const target = tab.dataset.goto;
      const on = target === name || (target === 'brief' && name === 'approval');
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-pressed', String(on));
    });

    if (sceneLabel) sceneLabel.textContent = sceneNames[name] ?? sceneNames.brief;
    scheduleScene();
  }

  function scheduleScene() {
    clearTimeout(sceneTimer);
    if (manualScene || phoneHovered || reduceMotion.matches || document.hidden) return;
    sceneTimer = setTimeout(() => {
      showScene(sceneOrder[(sceneIndex + 1) % sceneOrder.length]);
    }, 7200);
  }

  sceneButtons.forEach((btn) => {
    btn.addEventListener('click', () => showScene(btn.dataset.goto, true));
  });

  if (phoneStage) {
    phoneStage.addEventListener('pointerenter', () => {
      phoneHovered = true;
      clearTimeout(sceneTimer);
    });
    phoneStage.addEventListener('pointerleave', () => {
      phoneHovered = false;
      scheduleScene();
    });
    phoneStage.addEventListener('focusin', () => {
      phoneHovered = true;
      clearTimeout(sceneTimer);
    });
    phoneStage.addEventListener('focusout', () => {
      phoneHovered = false;
      scheduleScene();
    });
  }
  document.addEventListener('visibilitychange', scheduleScene);
  reduceMotion.addEventListener?.('change', scheduleScene);
  showScene('brief');
  scheduleScene();

  /* ------------------------------------------------------------ approval simulation */
  const demoCard = $('#demoCard');
  const draft = $('#draftText');
  const approveBtn = $('#approveBtn');
  const declineBtn = $('#declineBtn');
  const resetBtn = $('#resetDemo');
  const demoStatus = $('#demoStatus');
  const demoStamp = $('#demoStamp');
  const initialDraft = draft ? draft.value : '';
  const waitingStatus = 'Card posted by request_approval. The turn has ended; the agent is waiting on you.';

  function setDemoState(kind, text) {
    if (!demoCard || !demoStatus) return;
    demoCard.classList.toggle('is-approved', kind === 'approved');
    demoCard.classList.toggle('is-declined', kind === 'declined');
    demoStatus.dataset.tone = kind === 'approved' ? 'good' : kind === 'declined' ? 'stop' : '';
    demoStatus.textContent = text;
    if (demoStamp) demoStamp.textContent = kind === 'approved' ? 'APPROVED' : kind === 'declined' ? 'NOT NOW' : '';
    if (approveBtn) approveBtn.disabled = kind !== 'reset';
    if (declineBtn) declineBtn.disabled = kind !== 'reset';
    if (draft) draft.readOnly = kind !== 'reset';
  }

  approveBtn?.addEventListener('click', () => {
    if (!draft) return;
    const value = draft.value.trim();
    if (!value) {
      setDemoState('reset', 'The draft is empty. Write something first — there is nothing to approve.');
      demoStatus.dataset.tone = 'stop';
      return;
    }
    const edited = value !== initialDraft.trim();
    const preview = value.length > 150 ? value.slice(0, 150).trimEnd() + '…' : value;
    const text = edited
      ? `[approval c_7f3a] APPROVED with edits. The agent resumes the same Hermes session and sends your version verbatim: “${preview}”`
      : '[approval c_7f3a] APPROVED. The agent resumes the same Hermes session and sends your draft exactly.';
    setDemoState('approved', text);
  });

  declineBtn?.addEventListener('click', () => {
    setDemoState('declined', '[approval c_7f3a] NOT NOW. The turn ends, nothing is sent, and the draft is discarded.');
  });

  resetBtn?.addEventListener('click', () => {
    if (draft) draft.value = initialDraft;
    setDemoState('reset', waitingStatus);
    demoStatus.dataset.tone = '';
    demoCard?.classList.remove('is-approved', 'is-declined');
    if (demoStamp) demoStamp.textContent = '';
    if (approveBtn) approveBtn.disabled = false;
    if (declineBtn) declineBtn.disabled = false;
    draft?.focus();
  });

  /* ------------------------------------------------------------ tools filter */
  const toolFilter = $('#toolFilter');
  const toolCount = $('#toolCount');
  const toolsEmpty = $('#toolsEmpty');
  const tools = $$('.tool');
  const toolTotal = tools.length;

  function filterTools() {
    const q = (toolFilter?.value || '').trim().toLowerCase();
    let visible = 0;
    tools.forEach((tool) => {
      const hay = `${tool.textContent} ${tool.dataset.tags || ''}`.toLowerCase();
      const show = !q || hay.includes(q);
      tool.hidden = !show;
      if (show) visible += 1;
    });
    if (toolCount) toolCount.textContent = !q ? `${toolTotal} tools` : `${visible} of ${toolTotal} tools`;
    toolsEmpty?.classList.toggle('is-on', visible === 0);
  }
  toolFilter?.addEventListener('input', filterTools);

  /* ------------------------------------------------------------ copy buttons */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  $$('[data-copy-target]').forEach((btn) => {
    const prior = btn.innerHTML;
    let timer;
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target) return;
      const ok = await copyText(target.innerText.replace(/ /g, ' '));
      if (!ok) return;
      clearTimeout(timer);
      btn.classList.add('is-done');
      btn.textContent = 'COPIED';
      timer = setTimeout(() => {
        btn.classList.remove('is-done');
        btn.innerHTML = prior;
      }, 1600);
    });
  });

  /* ------------------------------------------------------------ lightbox */
  const lightbox = $('#lightbox');
  const lightboxImg = $('#lightboxImg');
  const lightboxCap = $('#lightboxCap');
  const lightboxClose = $('#lightboxClose');
  const lightboxOpen = $('#lightboxOpen');

  function openLightbox(src, caption, alt) {
    if (!lightbox || !lightboxImg) return;
    lightboxImg.src = src;
    lightboxImg.alt = alt || '';
    if (lightboxCap) lightboxCap.textContent = caption || '';
    if (lightboxOpen) lightboxOpen.href = new URL(src, window.location.href).href;
    if (typeof lightbox.showModal === 'function') lightbox.showModal();
    else lightbox.setAttribute('open', '');
  }

  $$('.shot').forEach((shot) => {
    shot.addEventListener('click', () => {
      const img = $('img', shot);
      openLightbox(shot.dataset.full, shot.dataset.caption, img?.alt);
    });
  });
  lightboxClose?.addEventListener('click', () => lightbox?.close());
  lightbox?.addEventListener('click', (e) => {
    if (e.target === lightbox) lightbox.close();
  });
  lightbox?.addEventListener('close', () => {
    if (lightboxImg) lightboxImg.removeAttribute('src');
  });

  /* ------------------------------------------------------------ year */
  const year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
