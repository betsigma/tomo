// focus.js
// ---------------------------------------------------------------------------
// The original patmodoro app, embedded in the schedule widget's Focus view.
// Visuals, sounds, animations and the countdown are kept as-is. Scoped to
// .focus-app; audio paths point at focus/assets.
//
// Simplified per request: no side tabs, no Tasks panel, no Settings panel.
// The timer length now comes from the widget's main Settings (Work / Break
// minutes). The pomodoro-count code is kept (a finished WORK session credits
// the focused task); the shared task list itself lives in the main widget.
// ---------------------------------------------------------------------------
(function () {
  const root = document.querySelector('.focus-app');
  if (!root) return;
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => Array.from(root.querySelectorAll(sel));

  // ---------- TIMER (work / break countdown) ----------
  const timerDisplay = $('#timer');
  const startPauseBtn = $('#startPauseBtn');
  const startImg = $('#startImg');
  const pauseImg = $('#pauseImg');
  const resetBtn = $('#resetBtn');
  const focusOn = $('#focusOn');

  // Lengths come from the widget's Settings (Work / Break minutes).
  function readTimerSettings() {
    const t = store.settings.timer || {};
    return {
      work: Math.max(1, Math.min(99, Number(t.work) || 25)),
      brk: Math.max(1, Math.min(99, Number(t.break) || 5))
    };
  }

  let cfg = readTimerSettings();
  let phase = 'work';                 // 'work' | 'break'
  let totalSeconds = cfg.work * 60;
  let workBlockMinutes = cfg.work;    // length of the work block that is running
  let intervalId = null;
  let focusTaskId = null;             // picked in the "Focus on" dropdown (null = auto)

  // "Focus on" picker: incomplete tasks plus an (auto) option.
  function byDueSoonest(a, b) {
    const da = localDateOf(a.due), db = localDateOf(b.due);
    if (da && db) return (`${da} ${a.time || ''}`).localeCompare(`${db} ${b.time || ''}`);
    if (da) return -1;                 // dated tasks come before undated ones
    if (db) return 1;
    return 0;
  }

  function renderFocusPicker() {
    if (!focusOn) return;
    const open = [...activeTodos()].filter((t) => !t.done).sort(byDueSoonest);
    if (focusTaskId && !open.some((t) => t.id === focusTaskId)) focusTaskId = null;
    focusOn.innerHTML = '<option value="">(auto)</option>' + open.map((t) =>
      `<option value="${t.id}">${esc(t.title)}${t.pomodoros ? ' \u00B7 \u{1F345} ' + t.pomodoros : ''}</option>`).join('');
    focusOn.value = focusTaskId || '';
  }
  if (focusOn) focusOn.addEventListener('change', () => { focusTaskId = focusOn.value || null; });

  // Which task a finished WORK session credits:
  //   1. the picked task, else
  //   2. the last task you opened, else
  //   3. the next incomplete task by due date.
  function pickCreditTask() {
    const open = [...activeTodos()].filter((t) => !t.done);
    if (focusTaskId) {
      const t = open.find((x) => x.id === focusTaskId);
      if (t) return t;
    }
    if (typeof lastOpenedTaskId !== 'undefined' && lastOpenedTaskId) {
      const t = open.find((x) => x.id === lastOpenedTaskId);
      if (t) return t;
    }
    return open.sort(byDueSoonest)[0] || null;
  }

  function phaseSeconds() { return (phase === 'work' ? cfg.work : cfg.brk) * 60; }

  function updateDisplay() {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (timerDisplay) {
      timerDisplay.textContent =
        String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
      timerDisplay.classList.toggle('break', phase === 'break');
    }
    focusUpdateChip();
  }

  function startTimer() {
    if (intervalId !== null) return;

    // If the countdown already finished, restart the current phase.
    if (totalSeconds <= 0) totalSeconds = phaseSeconds();

    // Request notification permission on the user gesture if needed.
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    intervalId = setInterval(() => {
      if (totalSeconds > 0) {
        totalSeconds--;
        updateDisplay();
      } else {
        onPhaseEnd();
      }
    }, 1000);
    focusUpdateChip();
  }

  // A phase finished: credit + notify + chime on WORK, then swap and continue.
  function onPhaseEnd() {
    clearInterval(intervalId);
    intervalId = null;
    const t = store.settings.timer || {};

    if (phase === 'work') {
      if (t.notify !== false && 'Notification' in window && Notification.permission === 'granted') {
        new Notification("Time's up! \u{1F345}", { body: 'Work session done \u2014 take a break.' });
      }
      const task = pickCreditTask();
      const minutes = workBlockMinutes;
      if (task) {
        task.pomodoros = (Number(task.pomodoros) || 0) + 1;
        save();
        renderTodos();               // repaints the main task list with the new count
        if (window.widgetAPI && window.widgetAPI.timeLogAdd) {
          window.widgetAPI.timeLogAdd({ taskId: task.id, minutes }).then(() => {
            if (typeof refreshEstimateCard === 'function') refreshEstimateCard();
          }).catch(() => {});
        }
      }
      if (t.sound !== false) playChime();
      phase = 'break';
    } else {
      if (t.sound !== false) playChime();
      phase = 'work';
    }

    if (phase === 'work') workBlockMinutes = cfg.work;
    totalSeconds = phaseSeconds();
    updateDisplay();
    startTimer();                    // keep the work/break cycle going
  }

  function pauseTimer() {
    clearInterval(intervalId);
    intervalId = null;
    focusUpdateChip();
  }

  function resetTimer() {
    clearInterval(intervalId);
    intervalId = null;
    phase = 'work';
    cfg = readTimerSettings();
    workBlockMinutes = cfg.work;
    totalSeconds = cfg.work * 60;
    updateDisplay();
  }

  function triggerBounce(btn) {
    if (!btn) return;
    btn.classList.remove('bounce');
    void btn.offsetWidth;
    btn.classList.add('bounce');
  }

  $$('.img-btn').forEach((btn) => {
    btn.addEventListener('animationend', () => btn.classList.remove('bounce'));
    btn.addEventListener('click', () => triggerBounce(btn));
  });

  if (startPauseBtn) startPauseBtn.addEventListener('click', () => {
    if (intervalId === null) {
      startTimer();
      startImg.classList.add('hidden');
      pauseImg.classList.remove('hidden');
    } else {
      pauseTimer();
      pauseImg.classList.add('hidden');
      startImg.classList.remove('hidden');
    }
  });
  if (resetBtn) resetBtn.addEventListener('click', () => {
    resetTimer();
    pauseImg.classList.add('hidden');
    startImg.classList.remove('hidden'); // reset also visually goes back to "Start"
  });
  updateDisplay();

  // ---------- MUSIC ----------
  const playlist = Array.from({ length: 16 }, (_, i) => `focus/assets/audio/music${i + 1}.mp3`);

  const bgMusic = $('#bgMusic');
  const playBtn = $('#playBtn');
  const playIcon = $('#playIcon');
  const pauseIcon = $('#pauseIcon');
  const prevBtn = $('#prevBtn');
  const nextBtn = $('#nextBtn');
  const shuffleBtn = $('#shuffleBtn');
  const loopBtn = $('#loopBtn');
  const progressWrap = $('#progressWrap');
  const progressFill = $('#progressFill');
  const progressThumb = $('#progressThumb');
  const currentTimeEl = $('#currentTime');
  const durationTimeEl = $('#durationTime');
  const trackNameEl = $('#trackName');

  let currentTrack = 0;
  let isPlaying = false;
  let shuffleOn = false;
  let loopOn = false;

  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function loadTrack(index) {
    currentTrack = index;
    if (bgMusic) bgMusic.src = playlist[currentTrack];
    if (trackNameEl) trackNameEl.textContent = `#${currentTrack + 1}`;
  }

  function playMusic() {
    if (!bgMusic) return;
    bgMusic.play().then(() => {
      isPlaying = true;
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
    }).catch((err) => {
      console.warn('Audio playback interrupted or blocked:', err);
    });
  }

  function pauseMusic() {
    if (bgMusic) bgMusic.pause();
    isPlaying = false;
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
  }

  if (playBtn) playBtn.addEventListener('click', () => { if (isPlaying) pauseMusic(); else playMusic(); });

  if (nextBtn) nextBtn.addEventListener('click', () => {
    let nextIndex;
    if (shuffleOn && playlist.length > 1) {
      do { nextIndex = Math.floor(Math.random() * playlist.length); } while (nextIndex === currentTrack);
    } else {
      nextIndex = (currentTrack + 1) % playlist.length;
    }
    loadTrack(nextIndex);
    if (isPlaying) playMusic();
  });

  if (prevBtn) prevBtn.addEventListener('click', () => {
    const prevIndex = (currentTrack - 1 + playlist.length) % playlist.length;
    loadTrack(prevIndex);
    if (isPlaying) playMusic();
  });

  if (shuffleBtn) shuffleBtn.addEventListener('click', () => {
    shuffleOn = !shuffleOn;
    shuffleBtn.classList.toggle('toggled', shuffleOn);
  });

  if (loopBtn) loopBtn.addEventListener('click', () => {
    loopOn = !loopOn;
    if (bgMusic) bgMusic.loop = loopOn;
    loopBtn.classList.toggle('toggled', loopOn);
  });

  if (bgMusic) {
    bgMusic.addEventListener('ended', () => {
      if (loopOn) {
        bgMusic.currentTime = 0;
        playMusic();
      } else if (nextBtn) {
        nextBtn.click();
      }
    });
    bgMusic.addEventListener('loadedmetadata', () => {
      if (!isNaN(bgMusic.duration) && durationTimeEl) durationTimeEl.textContent = formatTime(bgMusic.duration);
    });
    bgMusic.addEventListener('timeupdate', () => {
      if (!isNaN(bgMusic.duration) && bgMusic.duration > 0) {
        const percent = (bgMusic.currentTime / bgMusic.duration) * 100;
        if (progressFill) progressFill.style.width = percent + '%';
        if (progressThumb) progressThumb.style.left = percent + '%';
        if (currentTimeEl) currentTimeEl.textContent = formatTime(bgMusic.currentTime);
        if (durationTimeEl) durationTimeEl.textContent = formatTime(bgMusic.duration);
      }
    });
  }

  if (progressWrap) progressWrap.addEventListener('click', (e) => {
    const rect = progressWrap.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percent = clickX / rect.width;
    if (bgMusic && !isNaN(bgMusic.duration) && bgMusic.duration > 0) {
      bgMusic.currentTime = percent * bgMusic.duration;
    }
  });

  loadTrack(0);

  // ---------- CLICK SOUND INDICATOR ----------
  let audioCtx = null;

  function audioContext() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch { audioCtx = null; }
    return audioCtx;
  }

  function playClickSound() {
    const ctx = audioContext();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(700, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(250, ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.04);
    } catch (e) { /* ignore autoplay restrictions */ }
  }

  // Soft two-tone chime when a phase ends (the widget's "sound" toggle).
  function playChime() {
    const ctx = audioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      [660, 880].forEach((freq, i) => {
        const at = now + i * 0.18;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(at); osc.stop(at + 0.4);
      });
    } catch (e) { /* ignore */ }
  }

  $$('button').forEach((btn) => btn.addEventListener('click', playClickSound));

  // ---------- JELLY SQUISH SOUND ----------
  function playJelloSound() {
    const ctx = audioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();

      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(22, now);
      lfoGain.gain.setValueAtTime(90, now);
      lfoGain.gain.exponentialRampToValueAtTime(1, now + 0.18);
      lfo.connect(osc.frequency);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(620, now + 0.04);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.12);
      osc.frequency.exponentialRampToValueAtTime(340, now + 0.18);

      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);

      lfo.start(now);
      osc.start(now);
      lfo.stop(now + 0.22);
      osc.stop(now + 0.22);
    } catch (e) { /* ignore */ }
  }

  // ---------- TOMATO SQUISH & PIXEL PARTICLES ----------
  const tomatoWrap = $('.tomato-wrap');
  if (tomatoWrap) {
    tomatoWrap.addEventListener('click', () => {
      tomatoWrap.classList.remove('squish');
      void tomatoWrap.offsetWidth; // trigger reflow
      tomatoWrap.classList.add('squish');
      playJelloSound();

      const rect = tomatoWrap.getBoundingClientRect();
      const centerX = rect.width * 0.58;
      const centerY = rect.height * 0.63;

      const particleColors = ['#f36b98', '#d1477a', '#ffb3c6', '#fff0f5', '#a6285a', '#eb7fa7', '#f7c6d9', '#e89bb0'];
      const numParticles = 70;

      for (let i = 0; i < numParticles; i++) {
        const particle = document.createElement('div');
        particle.className = 'pixel-particle';

        const angle = (i / numParticles) * Math.PI * 2 + (Math.random() - 0.5) * 0.15;
        const radiusX = 220 + Math.random() * 20;
        const radiusY = 170 + Math.random() * 20;
        const startX = centerX + Math.cos(angle) * radiusX;
        const startY = centerY + Math.sin(angle) * radiusY;
        const speed = 40 + Math.random() * 90;
        const dx = (Math.cos(angle) * speed).toFixed(1) + 'px';
        const dy = (Math.sin(angle) * speed).toFixed(1) + 'px';
        const rot = (Math.random() > 0.5 ? 1 : -1) * (180 + Math.random() * 360) + 'deg';
        const color = particleColors[Math.floor(Math.random() * particleColors.length)];
        const size = (2 + Math.floor(Math.random() * 3)) * 2 + 'px';
        const duration = (0.55 + Math.random() * 0.4).toFixed(2) + 's';
        const delay = Math.floor(Math.random() * 110) + 'ms';

        particle.style.background = color;
        particle.style.width = size;
        particle.style.height = size;
        particle.style.left = startX.toFixed(1) + 'px';
        particle.style.top = startY.toFixed(1) + 'px';
        particle.style.setProperty('--dx', dx);
        particle.style.setProperty('--dy', dy);
        particle.style.setProperty('--rot', rot);
        particle.style.setProperty('--duration', duration);
        particle.style.setProperty('--delay', delay);

        tomatoWrap.appendChild(particle);
        setTimeout(() => particle.remove(), 1100);
      }
    });
  }

  // ---------- COMPACT-VIEW CHIP + WINDOW TITLE ----------
  function focusUpdateChip() {
    const running = intervalId !== null;
    const elapsed = totalSeconds < phaseSeconds();
    const show = running || elapsed;
    const text = timerDisplay ? timerDisplay.textContent : '';
    const chip = document.getElementById('compact-timer');
    if (chip) {
      chip.classList.toggle('hidden', !show);
      const label = document.getElementById('compact-timer-label');
      if (label) label.textContent = phase === 'break' ? '\u2615 Break' : '\u{1F345} Focus';
      const timeEl = document.getElementById('compact-timer-time');
      if (timeEl) timeEl.textContent = text;
      const btn = document.getElementById('compact-timer-toggle');
      if (btn) btn.textContent = running ? 'Pause' : 'Start';
    }
    document.title = show ? `${phase === 'break' ? 'Break' : 'Focus'} ${text} \u00B7 Schedule` : 'Schedule';
  }
  window.focusUpdateChip = focusUpdateChip;

  const chipToggle = document.getElementById('compact-timer-toggle');
  if (chipToggle) chipToggle.addEventListener('click', () => {
    if (intervalId === null) {
      startTimer();
      if (startImg) startImg.classList.add('hidden');
      if (pauseImg) pauseImg.classList.remove('hidden');
    } else {
      pauseTimer();
      if (pauseImg) pauseImg.classList.add('hidden');
      if (startImg) startImg.classList.remove('hidden');
    }
  });

  // ---------- BRIDGE TO THE WIDGET ----------
  // Called by the widget after the store is loaded.
  function focusInit() {
    cfg = readTimerSettings();
    phase = 'work';
    workBlockMinutes = cfg.work;
    totalSeconds = cfg.work * 60;
    updateDisplay();
    renderFocusPicker();
  }
  // Called when the widget's Settings change the work/break lengths.
  function focusApplySettings() {
    cfg = readTimerSettings();
    if (intervalId === null) {
      if (phase === 'work') workBlockMinutes = cfg.work;
      totalSeconds = phaseSeconds();
      updateDisplay();
    }
  }

  window.focusInit = focusInit;
  window.focusApplySettings = focusApplySettings;
  window.focusRefreshPicker = renderFocusPicker;
})();