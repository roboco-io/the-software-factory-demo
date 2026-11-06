export interface ReplayState {
  /** How many events are visible. */
  shown: number;
  total: number;
  playing: boolean;
}

export interface Replay {
  state(): ReplayState;
  play(): void;
  pause(): void;
  toggle(): void;
  next(): void;
  prev(): void;
  reset(): void;
  destroy(): void;
}

/**
 * Steps through a run's events. It starts with every event shown. Playing from the end starts over
 * from the first event and adds one event per interval until the last.
 */
export function createReplay(options: {
  total: number;
  intervalMs: number;
  onChange(state: ReplayState): void;
}): Replay {
  const { total, intervalMs, onChange } = options;
  let shown = total;
  let timer: ReturnType<typeof setInterval> | undefined;

  const state = (): ReplayState => ({
    shown,
    total,
    playing: timer !== undefined,
  });
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const emit = () => onChange(state());

  const replay: Replay = {
    state,
    play() {
      if (total === 0 || timer !== undefined) return;
      if (shown >= total) shown = 0;
      timer = setInterval(() => {
        shown = Math.min(total, shown + 1);
        if (shown >= total) stop();
        emit();
      }, intervalMs);
      emit();
    },
    pause() {
      stop();
      emit();
    },
    toggle() {
      if (timer === undefined) replay.play();
      else replay.pause();
    },
    next() {
      stop();
      shown = Math.min(total, shown + 1);
      emit();
    },
    prev() {
      stop();
      shown = Math.max(0, shown - 1);
      emit();
    },
    reset() {
      stop();
      shown = 0;
      emit();
    },
    destroy: stop,
  };
  return replay;
}
