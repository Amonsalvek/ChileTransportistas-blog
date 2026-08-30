/* =========================================================================
   year-filter.js — filtro por año de los hubs del blog.
   Compartido por /transportistas/ y /contratar-transporte/.
   Antes vivía inline en blog.html; se extrajo al bifurcar el blog.
   ========================================================================= */
document.addEventListener('DOMContentLoaded', function () {
  const filterBar = document.querySelector('.year-filter');
  const buttons   = Array.from(document.querySelectorAll('.year-filter button'));
  const sections  = Array.from(document.querySelectorAll('.year-section'));

  if (!filterBar || !sections.length) return;

  function showYear(y){
    sections.forEach(sec => {
      const visible = (sec.dataset.section === y);
      sec.classList.toggle('is-visible', visible);
      sec.hidden = !visible; // accesible y evita focus en lo oculto
    });
    buttons.forEach(btn => {
      const active = (btn.dataset.year === y);
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.setAttribute('tabindex', active ? '0' : '-1');
    });
  }

  // Delegación: funciona aunque se reemplacen botones por SSI o plantillas
  filterBar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-year]');
    if(!btn) return;
    e.preventDefault();
    showYear(btn.dataset.year);
  });

  // Soporte teclado (izq/der)
  filterBar.addEventListener('keydown', (e) => {
    const idx = buttons.indexOf(document.activeElement);
    if(idx === -1) return;
    if(e.key === 'ArrowRight'){
      const next = buttons[(idx+1) % buttons.length];
      next.focus(); next.click();
    } else if(e.key === 'ArrowLeft'){
      const prev = buttons[(idx-1+buttons.length) % buttons.length];
      prev.focus(); prev.click();
    }
  });

  // Inicial: URL ?year=YYYY o conserva la marcada como activa
  const params  = new URLSearchParams(location.search);
  const initial = params.get('year')
    || (document.querySelector('.year-filter .is-active')?.dataset.year)
    || sections[0]?.dataset.section;
  if(initial) showYear(initial);
});
